# Third-party notices

Original code in this project is under the [MIT license](LICENSE). Dependencies
and adapted portions retain their respective licenses.

## ts-grm

This package is an extension patch for [ts-grm](https://github.com/babyfish-ct/ts-grm),
authored by Chen Tao (陈涛). The upstream packages `@ts-grm/core` and `@ts-grm/sql`
are licensed under Apache-2.0.

- @see https://github.com/babyfish-ct/ts-grm
- [Full Apache-2.0 license](LICENSES/Apache-2.0.txt)

The published package keeps `@ts-grm/core` and `@ts-grm/sql` as external peer
dependencies; it does not bundle upstream implementations. Database drivers
(`pg`, `mysql2`, `better-sqlite3`, `oracledb`, `mssql`) are external
dependencies of `@ts-grm/sql` with their own licenses.

Current status: no upstream source code has been copied or adapted into this
project yet. If any file is later derived from ts-grm, record its path, the
upstream file it came from, and the commit hash here, and keep the attribution
in the derived file.
