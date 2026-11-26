# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).

## [Unreleased]

## [0.3.1]

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

[Unreleased]: https://github.com/guico52/ts-grm-patches/compare/eb7c62c...HEAD
[0.3.1]: https://github.com/guico52/ts-grm-patches/compare/v0.2.2...eb7c62c
[0.2.2]: https://github.com/guico52/ts-grm-patches/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/guico52/ts-grm-patches/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/guico52/ts-grm-patches/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/guico52/ts-grm-patches/releases/tag/v0.1.0
