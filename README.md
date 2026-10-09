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
// `columnDef` is the column metadata a consumer receives, e.g. a migration engine
columnDef.prop?.autoIncrement // boolean
columnDef.prop?.default // literal or expression node, or undefined
```

Both properties are declared on `spi.EntityProp` through a declaration merge, so they
type-check without a cast. `PatchedEntityProp` is exported for cases where you need to
name the type explicitly.

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

`createGlobalFilterManager(models)` returns a **native upstream `FilterManager`** that
registers your filters on each listed model. Pass it straight to `newSqlClient`:

```ts
import { createGlobalFilterManager } from 'ts-grm-patches'
import type { NumExpression } from '@ts-grm/core'
import { newSqlClient, PostgresDriver } from '@ts-grm/sql'

const globalFilters = createGlobalFilterManager([ORDER, CUSTOMER])
// registers only on models that actually have the column
globalFilters.addGlobalFor<NumExpression<number>>('tenantId', (t) => t.eq(currentTenantId))

const client = newSqlClient(new PostgresDriver(pool), {
  entityManager,
  filterManager: globalFilters,
})
```

- It **is** a `FilterManager`: no wrapping, no private members, no patching. Upstream's
  `merge()` passes an options value through untouched only when its constructor is exactly
  `FilterManager` (or `EntityManager`) — subclassing it, or passing any other object, gets
  shallow-copied and loses its prototype.
- All filters are combined with `AND`, in **registration order**: filters added via
  `add(model, filter)` and the global ones interleave exactly as they were registered, so there
  is no "global filters first" guarantee.
- `newSqlClient(client, options)` derives a client that **inherits** the manager, because it
  travels inside `options`.
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
  makes that list non-empty for every listed model and gives up that optimization.
- Upstream snapshots the filter list when the client is built: register before
  `newSqlClient()`. A model is registered only if it is listed _and_ no listed ancestor
  already applies — upstream collects along the `superEntity` chain, so a listed ancestor also
  covers its descendants, while a column that only exists on the subclass is registered on the
  subclass itself. A model that is not listed can still receive a filter through that same
  chain.
- `manager.unknownColumns(models)` lists column names that no given model has — inherited
  columns count as present, matching how applicability is decided — catching typos that would
  otherwise make a filter silently never apply.
- Inside a filter, `table.__entity` exposes the current `spi.Entity`, so a global filter
  can scope itself to — or exclude — specific models.

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
- `createGlobalFilterManager(models): GlobalFilterManager` — a native `FilterManager` with
  the listed models pre-registered.
- `GlobalFilterManager` — upstream `FilterManager` plus `addGlobal(filter)` (every listed
  model), `addGlobalFor(column, build)` (only models having that column),
  `unknownColumns(models)`, and `globalFilters`.
- `GlobalFilter` — an upstream `AnyFilter`.

### Consuming from a migration engine

```ts
import { isColumnDefaultExpression } from 'ts-grm-patches'

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
- `createGlobalFilterManager()` needs the model list up front, and — like upstream — the
  filters are snapshotted when the client is constructed (see Global filters).

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
