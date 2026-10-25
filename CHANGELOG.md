# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).

## [Unreleased]

### Added

- `BOOL` and `TEXT` columns can be used in query expressions (`where` / `orderBy` /
  `select`). Upstream 0.0.13 throws `ArgumentError` for them; the patch only takes over
  in that case and steps aside once upstream supports them.
- `bool()` / `nullableBool()`: `prop.bool()` typed so the column's `eq(...)` accepts a
  `boolean` (upstream's conditional type splits it into `true | false`).

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

[Unreleased]: https://github.com/guico52/ts-grm-patches/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/guico52/ts-grm-patches/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/guico52/ts-grm-patches/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/guico52/ts-grm-patches/releases/tag/v0.1.0
