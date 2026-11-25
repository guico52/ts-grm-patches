import { model, prop } from '@ts-grm/core'
import type { SqlClient } from '@ts-grm/core'
import type {
  PostgresDriver,
  MySqlDriver,
  SqliteDriver,
  SqlServerDriver,
  SqlServer2012Driver,
  OracleDriver,
  Oracle12Drivier,
} from '@ts-grm/sql'
import { newSqlClient, enhanceClient } from '../src/index'
import { newSqlClient as pgClient, enhanceClient as bindPostgres } from '../src/postgres'
import { newSqlClient as myClient } from '../src/mysql'
import { newSqlClient as liteClient } from '../src/sqlite'
import { newSqlClient as msClient } from '../src/sqlserver'
import { newSqlClient as oraClient } from '../src/oracle'
import type { EnhancedSqlClient } from '../src/index'

const MODEL = model(
  'BoundClientTypeModel',
  'id',
  class {
    id = prop.i32()
    data = prop.str(100)
  },
)

/** Compile-only checks of inference and every callback/projection boundary. */
export function checkBoundTypes(
  pgDriver: PostgresDriver,
  mysql: MySqlDriver,
  sqlite: SqliteDriver,
  sqlserver: SqlServerDriver,
  sqlserver2012: SqlServer2012Driver,
  oracle: OracleDriver,
  oracle12: Oracle12Drivier,
  raw: SqlClient,
): void {
  const pg: EnhancedSqlClient<'postgres'> = newSqlClient(pgDriver)
  const inferred: 'postgres' = newSqlClient(pgDriver).dialect
  const my: 'mysql' = newSqlClient(mysql).dialect
  const lite: 'sqlite' = newSqlClient(sqlite).dialect
  const ms: 'sqlserver' = newSqlClient(sqlserver).dialect
  const ms2012: 'sqlserver' = newSqlClient(sqlserver2012).dialect
  const ora: 'oracle' = newSqlClient(oracle).dialect
  const ora12: 'oracle' = newSqlClient(oracle12).dialect
  const derived: EnhancedSqlClient<'postgres'> = newSqlClient(pg, { defaultBatchSize: 16 })
  const derivedAgain: EnhancedSqlClient<'postgres'> = pgClient(derived)
  const idempotent: EnhancedSqlClient<'postgres'> = enhanceClient(pg)
  const unknown = enhanceClient(raw)
  // @ts-expect-error A raw SqlClient has erased the original driver's type.
  void unknown.fn.postgres
  const checked: EnhancedSqlClient<'postgres'> = bindPostgres(unknown)
  // @ts-expect-error Only the matching namespace is exposed.
  void pg.fn.mysql
  // @ts-expect-error The Postgres entry rejects a MySQL driver.
  pgClient(mysql)
  // @ts-expect-error The Postgres entry rejects a bound MySQL client.
  pgClient(myClient(mysql))
  // @ts-expect-error An unbound native client requires checked enhancement first.
  newSqlClient(raw)
  pg.createQuery(MODEL, (q, t) => {
    const text = q.fn.postgres.jsonbExtractPathText(t.data, 'name').coalesce('none').trim()
    // @ts-expect-error Root query callbacks keep the driver's family.
    void q.fn.sqlite
    const projection = q.select({ id: t.id, text }).where(t.id.gt(0))
    projection.fn.postgres.jsonbExtractPathText(t.data, 'other')
    // @ts-expect-error The selected projection must not erase the family.
    void projection.fn.mysql
    q.fn.subQuery(MODEL, (sq, st) => {
      sq.fn.postgres.jsonbExtractPathText(st.data, 'value')
      // @ts-expect-error Nested subqueries retain the family.
      void sq.fn.oracle
      const selected = sq.select(st.id).where(st.id.gt(0))
      // @ts-expect-error Subquery projections retain the family.
      void selected.fn.mysql
      return selected
    })
    q.fn.baseQuery(MODEL, (bq, bt) => {
      bq.fn.postgres.jsonbExtractPathText(bt.data, 'value')
      const selected = bq.select({ id: bt.id }).where(bt.id.gt(0))
      // @ts-expect-error BaseQuery projections retain the family.
      void selected.fn.sqlserver
      selected.fn.subQuery(MODEL, (sq, st) => {
        // @ts-expect-error Deeper scopes also retain the family.
        void sq.fn.mysql
        return sq.select(st.id)
      })
      return selected
    })
    return projection
  })
  myClient(mysql).fn.mysql.jsonExtract('{}', '$')
  liteClient(sqlite).fn.sqlite.jsonType('{}')
  msClient(sqlserver2012).fn.sqlserver.isJson('{}')
  oraClient(oracle12).fn.oracle.toChar(new Date(), 'YYYY')
  const rows: Promise<Array<{ readonly id: number }>> = derived
    .createQuery(MODEL, (q, t) => q.select({ id: t.id }).where(t.id.gt(0)))
    .fetchList()
  void [inferred, my, lite, ms, ms2012, ora, ora12, derivedAgain, idempotent, checked, rows]
}
