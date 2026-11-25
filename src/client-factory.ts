import { newSqlClient as nativeNewSqlClient } from '@ts-grm/sql'
import type {
  PostgresDriver,
  MySqlDriver,
  SqliteDriver,
  SqlServerDriver,
  OracleDriver,
} from '@ts-grm/sql'
import type { SqlClient } from '@ts-grm/core'

import { enhanceClient, getClientBinding } from './query-enhancer'
import type { EnhancedSqlClient, BoundClientSource } from './query-enhancer'
import { createDialectProfile, resolveDriverFamily } from './dialect-context'
import type { Dialect, DialectOptions } from './dialect-context'
import { QuerySemanticError } from './function-semantics'

export interface DialectDriverMap {
  postgres: PostgresDriver
  mysql: MySqlDriver
  sqlite: SqliteDriver
  sqlserver: SqlServerDriver
  oracle: OracleDriver
}
export type SupportedDriver = DialectDriverMap[Dialect]
export type NativeClientOptions = Parameters<typeof nativeNewSqlClient>[1]
type BoundSource = BoundClientSource
type Source = SupportedDriver | BoundSource
export type SourceDialect<T> = T extends BoundSource
  ? T['dialect']
  : T extends PostgresDriver
    ? 'postgres'
    : T extends MySqlDriver
      ? 'mysql'
      : T extends SqliteDriver
        ? 'sqlite'
        : T extends SqlServerDriver
          ? 'sqlserver'
          : T extends OracleDriver
            ? 'oracle'
            : never

/** Delegate creation and option inheritance to the native factory; bind once.
 * @see https://github.com/babyfish-ct/ts-grm/blob/8c89604b65922b4626df4e3b8a74d509338ea5b7/packages/sql/src/sql_client.ts
 */
export function newSqlClient<const T extends Source>(
  source: T,
  options: NativeClientOptions = {},
  dialectOptions: DialectOptions = {},
): EnhancedSqlClient<SourceDialect<T>> {
  return createClient(source, options, dialectOptions) as unknown as EnhancedSqlClient<
    SourceDialect<T>
  >
}

function createClient(
  source: Source,
  options: NativeClientOptions,
  dialectOptions: DialectOptions,
  expected?: Dialect,
) {
  const isClient = typeof Reflect.get(source, 'createQuery') === 'function'
  const binding = isClient ? getClientBinding(source) : undefined
  if (isClient && !binding)
    throw new QuerySemanticError(
      'UNBOUND_CLIENT',
      'Bind an existing client with a dialect entry point before deriving it',
    )
  const driver = binding?.driver ?? (source as SupportedDriver)
  const family = resolveDriverFamily(driver)
  if (expected !== undefined && family !== expected)
    throw new QuerySemanticError(
      'DIALECT_MISMATCH',
      `${expected} entry cannot create a ${family} client`,
    )
  const profile = createDialectProfile(family, driver.name, dialectOptions, binding?.profile)
  const client = nativeNewSqlClient(
    source as unknown as Parameters<typeof nativeNewSqlClient>[0],
    options,
  )
  return enhanceClient(client, family, {
    serverVersion: profile.serverVersion,
    // Public lookup types include absent keys; every own value was validated.
    capabilities: profile.capabilities as Readonly<Record<string, boolean>>,
  })
}

export interface DialectClientFactory<D extends Dialect> {
  (
    source: DialectDriverMap[D] | EnhancedSqlClient<D>,
    options?: NativeClientOptions,
    dialectOptions?: DialectOptions,
  ): EnhancedSqlClient<D>
}
export function createDialectClientFactory<D extends Dialect>(dialect: D): DialectClientFactory<D> {
  return (source, options = {}, dialectOptions = {}) =>
    createClient(source, options, dialectOptions, dialect) as unknown as EnhancedSqlClient<D>
}

export function createDialectEnhancer<D extends Dialect>(dialect: D) {
  return (
    client: SqlClient | BoundClientSource,
    options: DialectOptions = {},
  ): EnhancedSqlClient<D> => enhanceClient(client, dialect, options)
}
