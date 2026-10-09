# ts-grm-patches

English | [简体中文](docs/zh-CN/README.md)

Extension patches for [ts-grm](https://github.com/babyfish-ct/ts-grm) that add
**column-level `autoIncrement` and `default`**, closing the gap between `ts-grm`
and `ts-grm-migrate`.

## Why this exists

ts-grm's column metadata (`ColumnDef`, see `packages/sql/src/impl/schema_def.ts`)
expresses only `name` / `type` / `nullable` / `length` / `precision` / `scale` /
`when`. It expresses **neither auto-increment nor column defaults**, which leaves
two capabilities missing:

- ts-grm cannot emit self-incrementing columns (`serial` / `identity` /
  `auto_increment`) or column defaults in its generated `create table`.
- ts-grm-migrate's model adapter has to hard-code them as `default: undefined` /
  `autoIncrement: false` (see `src/schema/adapter.ts` in that repository), so
  migrations cannot produce the corresponding database features.

This package is the **extension patch** that fills the gap.

## Scope

It only **adds capability to ts-grm**: the declaration entry points and the
metadata.

It does **not generate SQL**. Translating `autoIncrement` / `default` into
`serial` / `identity(1,1)` / `auto_increment` / `default <...>` clauses is the
consumer's responsibility (for example `ts-grm-migrate`).

## Requirements

`@ts-grm/core` and `@ts-grm/sql` are **peerDependencies**
(`>=0.0.13 <0.0.14`), supplied by the host project. Upstream implementations are
never bundled.

## Usage

```ts
import { dsl, model, prop } from '@ts-grm/core'
import { applyPatches } from 'ts-grm-patches'

// Call once before defining any model(...) — idempotent
applyPatches()

const USER = model(
  'User',
  'id',
  class {
    id = prop.i32().autoIncrement()
    status = prop.str(20).default('active')
    createdAt = prop.dt().default(dsl.native.date`now()`)
  },
)
```

Both modifiers return a **new instance**, mirroring upstream `nullable()`. They
chain freely and never mutate the original prop:

```ts
const id = prop.i32().autoIncrement().default(0)
```

### Defaults: literals or SQL expressions

`default` accepts either a literal, constrained by the column's value type, or an
upstream expression node (`dsl.native.*`, or any ts-grm expression) for calling
SQL functions:

```ts
prop.str(20).default('active') // literal
prop.dt().default(dsl.native.date`now()`) // SQL function
prop.str(36).default(dsl.native.str`uuid_generate_v4()`) // SQL function
```

The patch only **carries** the expression node; it never renders SQL.

### Reading from column metadata

```ts
const column: ColumnDef = /* ... */ column.prop?.autoIncrement // boolean
column.prop?.default // literal or expression node, or undefined
```

`isColumnDefaultExpression(value)` tells expression nodes apart from literals. It
discriminates on the ts-grm node marker `__type().expressionLike` rather than
`instanceof`, so it keeps working when both the ESM and the CJS copy of
`@ts-grm/core` are loaded in one process.

### Where autoIncrement comes from

1. **Explicit column-level declaration** — `prop.i32().autoIncrement()`. This is
   the only option available with `@ts-grm/core@0.0.13`.
2. **Upstream ID-generation strategy (forward compatible)** — if the host ships
   that capability, the id column of `ctx.table(...).id("IDENTITY")` is reported
   as auto-increment.

> As of `@ts-grm/core@0.0.13` the upstream ID-generation strategy is unreleased:
> `IDENTITY` / `idGenerator` / `__RootModelContext` do not appear in its type
> declarations. The development branch does define
> `ctx.table(...).id("IDENTITY")` (stored on `Entity.idGenerator`), but the
> runtime has a single null check as its only consumer, no `=== "IDENTITY"`
> branch, and the `sql` package's DDL layer never reads it — it can be declared
> but not enforced. The patch therefore leads with the column-level declaration
> and keeps the branch above purely forward compatible.

## Global filters

`installGlobalFilters(client)` makes an existing client apply filters to **every** model,
with no need to register them one by one:

```ts
import { installGlobalFilters } from 'ts-grm-patches'
import type { NumExpression } from '@ts-grm/core'
import { newSqlClient, PostgresDriver } from '@ts-grm/sql'

const client = newSqlClient(new PostgresDriver(pool), { entityManager })

const globalFilters = installGlobalFilters(client)
// applies only to models that actually have the column; others are skipped
// (use addGlobal() with your own guard if you need full control)
globalFilters.addGlobalFor<NumExpression<number>>('tenantId', (t) => t.eq(currentTenantId))
```

- Upstream's `FilterManager.add(model, filter)` is bound to one model; global filters
  require no enumeration — any entity receives them, including models you never registered.
- Applied **before** per-model filters; all filters are combined with `AND` upstream, and
  `add(model, filter)` keeps working as before.
- Registration takes effect **immediately** — unlike upstream's `filterManager` option,
  which is snapshotted when the client is constructed.
- **Not every model has the column you filter on.** Upstream builds each table class from
  the entity's declared props, so on a model lacking that column the property is `undefined`
  and `table.someColumn.eq(...)` throws a `TypeError` that aborts the whole query. Prefer
  `addGlobalFor(column, build)`, which skips such models, or guard it yourself with
  `(table) => table.tenantId?.eq(id)`.
- `addGlobalFor` also filters at **lookup** time: an entity lacking the column gets an empty
  filter list. That matters beyond correctness — upstream decides whether an association may
  read the foreign key directly from `getFilters(entity).length === 0`
  (`association_resolver.ts`), so a non-empty list falls back to a join and can change the
  result set for nullable associations. Plain `addGlobal()` cannot know applicability, so it
  makes that list non-empty for every entity and gives up that optimization.
- Installation is idempotent per client: re-installing with no argument (or with the same
  manager) returns the installed one, while passing a **different** manager throws instead of
  being silently ignored. `newSqlClient(client, options)` builds a **new** instance that does
  not inherit the wrapper — call `installGlobalFilters(derived, manager)` to share one manager
  across clients.
- `manager.unknownColumns(models)` lists column names that no given model has — inherited
  columns count as present, matching how applicability is decided — catching typos that would
  otherwise make a filter silently never apply.
- Inside a filter, `table.__entity` exposes the current `spi.Entity`, so a global filter
  can scope itself to — or exclude — specific models.
- The filter is typed against `AnyModel`, so field access inside it is **not** verified at
  compile time: a typo surfaces when the query is generated, not when you write it.
- Built on the public `getFilters(entity)` member of `SqlClientImplementor`; if a client
  does not expose it, `installGlobalFilters` throws rather than failing silently.

## Data flow

The patch does not hook the schema-build pipeline; it rides the existing data
path:

```
prop.i32().autoIncrement()          // writes a field into __PropData
  → EntityProp(this, name, __data)  // core passes it through verbatim (entity.ts)
    → ColumnDef.prop                // schema_creator holds that EntityProp
```

`applyPatches()` only does two things:

1. installs `autoIncrement()` / `default(value)` on `__ScalarProp`
2. installs read-only `autoIncrement` / `default` readers on `spi.EntityProp`

If upstream ever provides members with those names, the patch steps aside — it
never overwrites.

## API

- `applyPatches(): void` — installs the patch. Idempotent; must run before any
  `model(...)` definition.
- `isColumnDefaultExpression(value: unknown): value is ColumnDefaultExpression` —
  `true` when the default is a SQL expression node rather than a literal.
- `ColumnDefaultLiteral` — `string | number | boolean | bigint | Date`.
- `ColumnDefaultExpression` — upstream expression node (`ExpressionLike`).
- `ColumnDefaultValue` — literal, expression, or any other value that column type may carry
  (arrays from `prop.enumSet`, objects from `prop.json`, custom scalars).
- `ColumnPatchData` — the fields the patch attaches to `__PropData`.
- `PatchedEntityProp` — `spi.EntityProp & { autoIncrement: boolean; default: ColumnDefaultValue | undefined }`.
- `installGlobalFilters(client): GlobalFilterManager` — makes an existing client apply
  filters to every model.
- `GlobalFilterManager` — `addGlobal(filter)` (applies to every model),
  `addGlobalFor(column, build)` (skips models lacking that column), `unknownColumns(models)`,
  and `globalFilters`.
- `GlobalFilter` — an upstream `AnyFilter`.

### Consuming from a migration engine

```ts
const d = columnDef.prop?.default
if (isColumnDefaultExpression(d)) {
  // d is an expression node (e.g. produced by dsl.native.*), carrying `parts`
  // render it and emit `default <sql>`
} else if (d !== undefined) {
  // literal: escape it and emit `default '<...>'`
}
```

## Known limitations

- `applyPatches()` must run before any `model(...)` definition.
- The patch extends prototypes of classes from `@ts-grm/core`. If two copies of
  the upstream package (ESM and CJS) are loaded in one process, only one of them
  gets patched. The expression discriminator above avoids this pitfall.
- `installGlobalFilters()` relies on the `getFilters` member of `SqlClientImplementor`
  (see Global filters). That member is part of the upstream public surface, so removing
  or renaming it upstream would be a breaking change.

## Development

```bash
pnpm install        # install dependencies
pnpm dev            # build in watch mode
pnpm typecheck      # tsc --noEmit
pnpm lint           # ESLint
pnpm format         # Prettier
pnpm test           # vitest run (includes end-to-end: real model → createSchema() → column metadata)
pnpm coverage       # test coverage
pnpm build          # build to dist/ (ESM + CJS + d.ts)
```

The package is published in two formats: ESM (`dist/index.js`) and CJS
(`dist/index.cjs`), with type declarations exposed through `exports` as
`dist/index.d.ts` / `dist/index.d.cts`.

Publishing and pre-publish verification are performed locally by the maintainer;
this repository ships no CI and no `prepublishOnly` hook.

## License

Original code in this project is [MIT](LICENSE). Upstream `ts-grm` is
Apache-2.0; see [third-party notices](THIRD_PARTY_NOTICES.md) and the
[full text](LICENSES/Apache-2.0.txt).
