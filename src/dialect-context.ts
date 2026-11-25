import { QuerySemanticError } from './function-semantics'
import {
  PostgresDriver,
  MySqlDriver,
  SqliteDriver,
  SqlServerDriver,
  OracleDriver,
} from '@ts-grm/sql'

export type Dialect = 'postgres' | 'mysql' | 'sqlite' | 'sqlserver' | 'oracle'
export type ServerVersion =
  readonly [number] | readonly [number, number] | readonly [number, number, number]
export type DialectCapabilities = Readonly<Partial<Record<string, boolean>>>

/** Explicit declarations, not a claim that the driver has detected the server. */
export interface DialectOptions {
  readonly serverVersion?: ServerVersion
  readonly capabilities?: Readonly<Record<string, boolean>>
}
export interface DialectProfile<D extends Dialect = Dialect> {
  readonly family: D
  readonly driverName: string
  readonly serverVersion: ServerVersion | undefined
  readonly capabilities: DialectCapabilities
}

const families: Readonly<Record<string, Dialect>> = Object.freeze({
  postgres: 'postgres',
  MySql: 'mysql',
  sqlite: 'sqlite',
  SqlServer: 'sqlserver',
  SqlServer2012: 'sqlserver',
  Oracle: 'oracle',
  Oracle12: 'oracle',
})
const constructors = {
  postgres: PostgresDriver,
  mysql: MySqlDriver,
  sqlite: SqliteDriver,
  sqlserver: SqlServerDriver,
  oracle: OracleDriver,
}

/** Driver variants describe SQL syntax, not the actual server version. */
export function driverFamily(name: unknown): Dialect {
  if (typeof name !== 'string' || !Object.hasOwn(families, name)) {
    throw new QuerySemanticError(
      'UNSUPPORTED_CLIENT',
      'Expected a supported native ts-grm SQL driver',
    )
  }
  return families[name]!
}

export function resolveDriverFamily(driver: { readonly name: unknown } | undefined): Dialect {
  const family = driverFamily(driver?.name)
  // Native driver copies from another module format may not pass instanceof;
  // in that case the public driver-name contract still determines the family.
  for (const [name, Constructor] of Object.entries(constructors)) {
    if (driver instanceof Constructor && family !== name) {
      throw new QuerySemanticError(
        'DIALECT_MISMATCH',
        'Driver class and driver name identify different databases',
      )
    }
  }
  return family
}

export function createDialectProfile<D extends Dialect>(
  family: D,
  driverName: string,
  options: DialectOptions = {},
  inherited?: DialectProfile,
): DialectProfile<D> {
  const version = options.serverVersion ?? inherited?.serverVersion
  if (
    version !== undefined &&
    (!Array.isArray(version) ||
      version.length < 1 ||
      version.length > 3 ||
      !Array.from(version).every((part) => Number.isSafeInteger(part) && part >= 0))
  ) {
    throw new TypeError('serverVersion must contain one to three nonnegative safe integers')
  }
  if (
    options.capabilities !== undefined &&
    (options.capabilities === null ||
      typeof options.capabilities !== 'object' ||
      Array.isArray(options.capabilities))
  ) {
    throw new TypeError('Capability declarations must be a boolean dictionary')
  }
  const capabilities = Object.assign(
    Object.create(null) as Record<string, boolean>,
    inherited?.capabilities,
    options.capabilities,
  )
  if (!Object.values(capabilities).every((value) => typeof value === 'boolean')) {
    throw new TypeError('Capability declarations must be booleans')
  }
  return Object.freeze({
    family,
    driverName,
    serverVersion:
      version === undefined ? undefined : (Object.freeze([...version]) as ServerVersion),
    capabilities: Object.freeze(capabilities),
  })
}
