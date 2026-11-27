import { EntityManager, model, prop } from '@ts-grm/core'
import {
  FilterManager,
  MySqlDriver,
  Oracle12Drivier,
  OracleDriver,
  PostgresDriver,
  SqlServer2012Driver,
  SqlServerDriver,
  SqliteDriver,
  newSqlClient as nativeNewSqlClient,
} from '@ts-grm/sql'
import { describe, expect, it } from 'vitest'
import { enhanceClient, newSqlClient } from '../src/index'
import type { EnhancedSqlClient } from '../src/index'
import { newSqlClient as pgClient, enhanceClient as bindPostgres } from '../src/postgres'
import { newSqlClient as mysqlClient } from '../src/mysql'
import { newSqlClient as sqliteClient } from '../src/sqlite'
import { newSqlClient as sqlserverClient } from '../src/sqlserver'
import { newSqlClient as oracleClient } from '../src/oracle'

const ITEM = model(
  'DialectBoundItem',
  'id',
  class {
    id = prop.i32()
    amount = prop.i32()
  },
)
const names = ['postgres', 'mysql', 'sqlite', 'sqlserver', 'oracle']
const cases = [
  { family: 'postgres', Constructor: PostgresDriver, create: pgClient },
  { family: 'mysql', Constructor: MySqlDriver, create: mysqlClient },
  { family: 'sqlite', Constructor: SqliteDriver, create: sqliteClient },
  { family: 'sqlserver', Constructor: SqlServerDriver, create: sqlserverClient },
  { family: 'sqlserver', Constructor: SqlServer2012Driver, create: sqlserverClient },
  { family: 'oracle', Constructor: OracleDriver, create: oracleClient },
  { family: 'oracle', Constructor: Oracle12Drivier, create: oracleClient },
] as const

describe('dialect-bound native client creation', () => {
  it.each(cases)(
    'binds $Constructor.name to $family at creation',
    ({ family, Constructor, create }) => {
      const driver = new Constructor({} as never)
      const client = newSqlClient(driver)
      const specialized = Reflect.apply(create, undefined, [driver]) as EnhancedSqlClient
      expect(client.dialect).toBe(family)
      expect(specialized.dialect).toBe(family)
      expect(Reflect.get(client, 'driver')).toBe(driver)
      expect(client.dialectProfile.driverName).toBe(driver.name)
      expect(client.dialectProfile.serverVersion).toBeUndefined()
      expect(Object.keys(client.fn).filter((key) => names.includes(key))).toEqual([family])
      client.createQuery(ITEM, (q, t) => {
        expect(q.fn).toBe(client.fn)
        const projection = q.select(t.id)
        expect(projection.fn).toBe(client.fn)
        expect(Object.keys(projection.fn).filter((key) => names.includes(key))).toEqual([family])
        q.fn.baseQuery(ITEM, (bq, bt) => {
          expect(bq.fn).toBe(client.fn)
          return bq.select({ id: bt.id }).where(bt.id.gt(0))
        })
        q.fn.subQuery(ITEM, (sq, st) => {
          expect(sq.fn).toBe(client.fn)
          return sq.select(st.id).where(st.id.gt(0))
        })
        return projection.where(t.id.gt(0))
      })
    },
  )

  it('inherits the driver, native options and immutable declarations when deriving', () => {
    const driver = new PostgresDriver({} as never)
    const manager = new FilterManager()
    const entities = EntityManager.combine(ITEM as never, ITEM as never)
    const version: [number, number] = [15, 2]
    const capabilities = { json: true }
    const parent = pgClient(
      driver,
      { entityManager: entities, filterManager: manager, defaultBatchSize: 8 },
      { serverVersion: version, capabilities },
    )
    const child = newSqlClient(parent, { defaultBatchSize: 16 }, { capabilities: { math: false } })
    version[0] = 1
    capabilities.json = false
    expect(child).not.toBe(parent)
    expect(child.fn).not.toBe(parent.fn)
    expect(child.dialect).toBe('postgres')
    expect(Reflect.get(child, 'driver')).toBe(driver)
    expect(Reflect.get(child, 'options').filterManager).toBe(manager)
    expect(Reflect.get(child, 'options').entityManager).toBe(entities)
    expect(Reflect.get(child, 'options').defaultBatchSize).toBe(16)
    expect(Reflect.get(parent, 'options').defaultBatchSize).toBe(8)
    expect(parent.dialectProfile.serverVersion).toEqual([15, 2])
    expect(child.dialectProfile.serverVersion).toEqual([15, 2])
    expect(child.dialectProfile.capabilities).toEqual({ json: true, math: false })
    expect(parent.dialectProfile.capabilities).toEqual({ json: true })
    expect(Object.isFrozen(child.dialectProfile)).toBe(true)
    expect(Object.isFrozen(child.dialectProfile.serverVersion)).toBe(true)
    expect(Object.isFrozen(child.dialectProfile.capabilities)).toBe(true)
    expect(Reflect.set(child, 'dialect', 'mysql')).toBe(false)
    child.createQuery(ITEM, (q, t) => {
      const projection = q.select(t.id)
      expect('postgres' in projection.fn).toBe(true)
      return projection
    })
  })

  it('binds existing clients with a checked entry and keeps enhancement idempotent', () => {
    const raw = nativeNewSqlClient(new PostgresDriver({} as never), {})
    const unknown = enhanceClient(raw)
    const bound = bindPostgres(unknown)
    expect(bound).toBe(raw)
    expect(enhanceClient(bound)).toBe(bound)
    expect(bindPostgres(bound)).toBe(bound)
    expect(() => bindPostgres(bound, { serverVersion: [15] })).toThrow('CLIENT_ALREADY_BOUND')
    const mysql = nativeNewSqlClient(new MySqlDriver({} as never), {})
    expect(() => bindPostgres(mysql)).toThrow('DIALECT_MISMATCH')
    expect('fn' in mysql).toBe(false)
  })

  it('rejects mismatched entries and forged driver names before creating a client', () => {
    const pg = pgClient(new PostgresDriver({} as never))
    expect(() => Reflect.apply(mysqlClient, undefined, [pg])).toThrow('DIALECT_MISMATCH')
    expect(() => Reflect.apply(pgClient, undefined, [new MySqlDriver({} as never)])).toThrow(
      'DIALECT_MISMATCH',
    )
    const driver = new PostgresDriver({} as never)
    Object.defineProperty(driver, 'name', { value: 'MySql' })
    expect(() => newSqlClient(driver)).toThrow('DIALECT_MISMATCH')
    expect(() => bindPostgres(nativeNewSqlClient(driver, {}))).toThrow('DIALECT_MISMATCH')
    const unknown = new PostgresDriver({} as never)
    Object.defineProperty(unknown, 'name', { value: 'postgres99' })
    expect(() => newSqlClient(unknown)).toThrow('UNSUPPORTED_CLIENT')
  })

  it('requires explicit binding before deriving an untyped native client', () => {
    const raw = nativeNewSqlClient(new PostgresDriver({} as never), {})
    const derived = newSqlClient(raw)
    expect(derived.dialect).toBe('postgres')
    expect(derived).not.toBe(raw)
    expect('fn' in raw).toBe(false)
    expect(newSqlClient(bindPostgres(raw)).dialect).toBe('postgres')
  })

  it('rejects changing a bound driver through JavaScript property mutation', () => {
    const client = pgClient(new PostgresDriver({} as never))
    Reflect.set(client, 'driver', new MySqlDriver({} as never))
    expect(() => newSqlClient(client)).toThrow('CLIENT_DRIVER_CHANGED')
    expect(() => client.createQuery(ITEM, (q, t) => q.select(t.id))).toThrow(
      'CLIENT_DRIVER_CHANGED',
    )
  })

  it('validates explicit version and capability declarations', () => {
    const driver = new PostgresDriver({} as never)
    expect(() => pgClient(driver, {}, { serverVersion: [-1] })).toThrow('serverVersion')
    expect(() => pgClient(driver, {}, { serverVersion: [1.5] })).toThrow('serverVersion')
    expect(() =>
      Reflect.apply(pgClient, undefined, [driver, {}, { capabilities: { json: 'yes' } }]),
    ).toThrow('booleans')
    const client = pgClient(driver, {}, { serverVersion: [15], capabilities: { json: true } })
    expect(bindPostgres(client, { serverVersion: [15], capabilities: { json: true } })).toBe(client)
    expect(client.dialectProfile.capabilities['constructor']).toBeUndefined()
    expect(client.dialectProfile.capabilities['toString']).toBeUndefined()
  })

  it('keeps native-expression provenance when semantic annotations are applied', () => {
    const pg = pgClient(new PostgresDriver({} as never))
    const my = mysqlClient(new MySqlDriver({} as never))
    const expr = pg.fn
      .scalar(pg.fn.native.str`current_user`)
      .coalesce('none')
      .upper()
    expect(() => my.createQuery(ITEM, (q) => q.select(expr))).toThrow('DIALECT_MISMATCH')
    const raw = pg.fn.native.num`sum(1)`
    const annotated = my.fn.aggregate(raw)
    expect(() => my.createQuery(ITEM, (q) => q.select(annotated))).toThrow('DIALECT_MISMATCH')
  })
})
