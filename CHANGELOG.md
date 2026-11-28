# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).

## [Unreleased]

### Changed

- Drop the upper bound from the `@ts-grm/core` / `@ts-grm/sql` peer range: it is now
  `>=0.0.13` instead of `>=0.0.13 <0.0.15`. A new upstream minor no longer produces a
  peer conflict on install. The `coalesce` array bridge remains tied to the verified
  upstream implementations and is the one repair that will not step aside by itself.

### Added

- Real server execution tests (`test/server/`) for PostgreSQL, MySQL, SQL Server and
  Oracle. They run when `GRM_PG_URL` / `GRM_MYSQL_URL` / `GRM_MSSQL_URL` /
  `GRM_ORACLE_URL` are set, print why they skipped otherwise, and fail instead of
  skipping when `REQUIRE_SERVER_TESTS=1` (CI sets it).
- CI matrix documented caveat: upstream `0.0.13` ships `using` declarations untranspiled
  and only loads on Node >=24; `0.0.14` is required for Node 20/22.
- Coverage thresholds (`vitest.config.ts`) and type-aware ESLint rules on `src/`.
- GitHub Actions CI: Node 20/22 with upstream `0.0.14`, Node 24 with `0.0.13` and
  `0.0.14` (0.0.13 cannot be parsed below Node 24), running typecheck, lint, tests with
  coverage thresholds, and the published-entry contract checks. A separate job runs
  `test/server/` against PostgreSQL, MySQL, SQL Server and Oracle containers.
- `pnpm verify:tags` (`scripts/verify-release-tags.mjs`) checks that every version
  published on npm has a tag, that the tag resolves to a commit on the current branch,
  and that the checked-out `package.json` version matches the tag name.

### Fixed

- PostgreSQL: `trunc` and `power` were emitted with untyped bind parameters, so the server
  rejected them with `function trunc(unknown) is not unique` and
  `function power(unknown) does not exist`. Both now cast to `numeric`, found by the new
  server execution tests.
- Release tags were out of sync with npm: `v0.3.1`, `v0.4.0` and `v0.4.1` were missing,
  and the earlier tags pointed at commits orphaned by a history rewrite. All tags now
  resolve to commits on `main` whose trees match what npm recorded as `gitHead`.
- The real-SQLite execution test no longer skips silently on Node <22.3. It prints the
  reason it skipped, and `REQUIRE_REAL_SQLITE=1` turns a missing `node:sqlite` into a
  hard failure so CI cannot lose that coverage unnoticed.

## [0.4.1] - 2026-11-27

> **BREAKING CHANGE**: Removed post-selection condition chaining (`select(...).where(...)` /
> `select(...).autoGroupBy(...)` / `select(...).orderBy(...)`) and the `SelectedQuery` /
> `QueryConditions` types to stay aligned with native `ts-grm` query syntax. Place `where`,
> `autoGroupBy`, `having`, and `orderBy` on `q` before `select(...)`, matching native
> `q.where(...).groupBy(...).having(...).orderBy(...).select(...)`.

### Removed

- Post-selection condition chaining on `select` / `selectDistinct` projections, along with
  the `SelectedQuery` and `QueryConditions` type exports.

### Changed

- Streamlined `enhanceQuery()` so `select` / `selectDistinct` / `where` / `orderBy` remain
  untouched native methods; `autoGroupBy()` now acts as a drop-in replacement for native
  `groupBy(...)` (reading native `wherePred` and `orders` directly) and requires `having(...)`
  to be called after `autoGroupBy()` or `groupBy(...)`, matching native `ts-grm`.
- Consolidated dialect/capability validation into callback finalization instead of
  re-traversing predicates on every `where` / `orderBy` call.

## [0.4.0] - 2026-11-27

### Changed

- Merge fluent methods into native core interfaces; remove public Chained*Expression
  types and per-instance expression method interception.
- Install new methods once on SPI prototypes via applyPatches or client enhancement.
  Field chains, native DSL results and q.fn share expression implementations.
- Keep native string AST nodes; repair missing or incorrect dialect rendering in
  Driver NodeRender, buffering unsupported upstream rendering before fallback.
- Resolve portable-function dialects at render time from the current client;
  preserve function/aggregate semantics for analysis and validate capabilities at
  enhanced-query completion, with render-time checks as a fallback.
- Preserve native SqlClient/query signatures, multiple projection construction and
  raw-client derivation while retaining default select().where() support.

- Separate portable argument/capability validation from SQL lowering; reuse
  rendering adapters by immutable dialect profile instead of rebuilding factories
  during construction and query validation.

### Added

- Support `@ts-grm/core` and `@ts-grm/sql` `>=0.0.13 <0.0.15` (verified against `0.0.14`,
  where upstream fixed runtime `BOOL` queries and nullable `BOOL` `NULL` decoding; runtime
  `TEXT` queries and `BOOL` type distribution remain handled by this package).
- Native/field/facade expression performance benchmarks separating query building,
  synchronous fragment generation and fetchList pipelines, with same-machine old
  implementation comparisons and recorded source hashes.

### Fixed

- Unify concat validation across field and q.fn entry points, preserve identity
  for field concat() without operands, and validate all string index/length
  literals during enhanced-query validation and native rendering.

- Preserve string/date/EnumSet MIN/MAX chaining and floating-point AVG decoding
  through chain/q.fn entry points; repair native position numeric methods/decoding
  and the 0.0.13 coalesce variadic runtime mismatch on prototypes.

### Migration notes

- Use native NumExpression/StrExpression/DateExpression types. Prototype methods
  affect the loaded core copy after explicit installation; extracted methods need
  their native receiver. Raw dsl.min/max string/date chaining and raw dsl.avg
  integer decoding retain upstream limitations. fetchCount/fetchPage aggregate
  recognition is not repaired by this change.

## [0.3.1] (Unpublished / YANKED)

> **YANKED**: `0.3.1` has been unpublished from npm. Its per-instance expression
> wrapping diverged sharply from native `ts-grm` APIs and incurred heavy runtime
> overhead; the author considers that design a failed attempt. Do not use `0.3.1`
> — upgrade directly to **`0.4.0`**.

### Added

- Reproducible isolated-process query benchmarks (`pnpm bench:query`) and a
  performance review separating metadata patches, query/function enhancement and
  automatic grouping from database execution.
- Portable numeric functions specialized for five dialects, chained numeric
  transforms, character/byte lengths and aggregate-aware COUNT DISTINCT.
- SQLite optional-math and octet-length capability checks using bound profiles.

- Dialect-bound `newSqlClient` factories at the root and postgres/mysql/sqlite/
  sqlserver/oracle entries, with checked existing-client binding, driver-based type
  inference, and specialization preserved through projections and nested queries.
- Derived-client binding inheritance and immutable explicit server-version and
  capability declarations. Only the matching dialect namespace is exposed.
- Package-export verification of shared binding and expression metadata across
  root and dialect entry points in both ESM and CJS.

- `enhanceClient(client)`: native-client query extensions with `client.fn`, `q.fn`,
  semantic function metadata, and opt-in `q.autoGroupBy()`.
- Functional entry points for the installed upstream DSL and expression methods,
  enhanced base/subquery callbacks, and an initial five-dialect function catalog.
- Conditions after `select` / `selectDistinct`, with grouping and HAVING finalized
  when the owning query callback completes. Result inference is preserved for
  scalar, tuple and map projections.
- Recursive function-result chains for common, dialect and native expressions;
  shared native-method dispatch, variadic chained COALESCE, string CONCAT and
  numeric POSITION results, preserving aggregate dependencies.
- Explicit errors for subquery pagination that upstream 0.0.13 would silently omit.
- Explicit scalar/aggregate annotation for native SQL, numeric return modes for
  SUM/AVG, and fixes to enhanced AVG decoding, MIN/MAX runtime expression families,
  position, coalesce, and concat.
- SQL/binding and type checks, plus real SQLite grouping/aggregate execution tests.

### Fixed

- Dialect rendering for string prefix/suffix, substring, start-aware search,
  padding and trim; SQLite padding now has a native-expression implementation.
- SQL Server trailing-space character length and integer POWER results,
  PostgreSQL decimal ROUND signatures, and explicit unsupported REVERSE errors.

### Performance

- Cache expression method plans by native prototype and lazily bind value
  transforms, keeping own methods and accessor-provided methods instance-local.
  Comparison/order chains retain their native methods; functional q.fn entries
  remain available.
- Reuse the dialect-validator class, reduce query setup allocations, and memoize
  grouping shapes/analysis while still rejecting cached nested aggregates.
- On the recorded local benchmark, grouped q.fn construction/rendering fell from
  124–130 us to 52–54 us, and automatic grouping from 132–134 us to 59–61 us.
  These are JavaScript pipeline measurements with mock execution, not database
  latency guarantees; before/after data is included in the performance review.

### Documentation

- Reframe the English/Chinese READMEs and package description around an optional
  ts-grm enhancement layer, with capability navigation, activation boundaries,
  current peer/runtime requirements and release status.
- Add an adoption guide and a documentation-site integration proposal covering
  an ecosystem section, versioned examples and browser-sandbox verification.

## [0.2.2] - 2026-10-25

### Added

- `BOOL` and `TEXT` columns can be used in query expressions (`where` / `orderBy` /
  `select`). Upstream 0.0.13 throws `ArgumentError` for them; the patch only takes over
  in that case and steps aside once upstream supports them.
- `bool()` / `nullableBool()`: `prop.bool()` typed so the column's `eq(...)` accepts a
  `boolean` (upstream's conditional type splits it into `true | false`).

### Changed

- The published package now includes `CHANGELOG.md`, and `package.json` links to the
  GitHub repository, homepage and issue tracker.

### Documentation

- Known limitations: with ES modules, call `applyPatches()` in its own module imported
  before any model module; the type augmentation is visible before the runtime patch is
  applied.

## [0.2.1] - 2026-10-09

### Changed

- **Breaking:** `createGlobalFilterManager()` is now async and also accepts an
  `EntityManager`, taking the model list from `entities()` (including the inheritance
  chain). Existing callers passing a model array must `await` the result.
- Column presence for `addGlobalFor()` is read from entity metadata (`allPropMap`)
  instead of constructing a table instance.

## [0.2.0] - 2026-10-09

### Added

- `createGlobalFilterManager(models)`: a plain upstream `FilterManager` with
  `addGlobal(filter)`, `addGlobalFor(column, build)`, `unknownColumns(models)` and
  `globalFilters`. Pass it as the `filterManager` option of `newSqlClient`.
- `addGlobalFor()` registers the filter only on models that have the column, so models
  without it keep upstream's direct-foreign-key optimization for associations.

### Fixed

- A filter is no longer registered twice when a parent and its child model are both
  listed.
- `ColumnDefaultLiteral` includes `Date`, and `ColumnDefaultValue` covers every shape
  `default(...)` accepts (arrays from `prop.enumSet`, objects from `prop.json`, custom
  scalars).
- `spi.EntityProp` is augmented with `autoIncrement` / `default`, so consumers read
  them without a cast.

## [0.1.0] - 2026-10-09

### Added

- `applyPatches()`: adds `autoIncrement()` and `default(value)` to scalar props and
  exposes them on `spi.EntityProp`, so they reach `ColumnDef.prop` for DDL generators
  and migration engines.
- `default(...)` accepts upstream SQL expression nodes (e.g. ``dsl.native.date`now()` ``)
  besides literals; `isColumnDefaultExpression()` tells them apart.
- Forward-compatible support for upstream `IDENTITY` ID generation (not present in
  `@ts-grm/core` 0.0.13).

[Unreleased]: https://github.com/guico52/ts-grm-patches/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/guico52/ts-grm-patches/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/guico52/ts-grm-patches/compare/eb7c62c...v0.4.0
[0.3.1]: https://github.com/guico52/ts-grm-patches/compare/v0.2.2...eb7c62c
[0.2.2]: https://github.com/guico52/ts-grm-patches/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/guico52/ts-grm-patches/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/guico52/ts-grm-patches/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/guico52/ts-grm-patches/releases/tag/v0.1.0
