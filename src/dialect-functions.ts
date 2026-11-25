import { QuerySemanticError } from './function-semantics'
import { callParts, sqlArgument, sqlExpression } from './sql-function'
import type { SqlArgument, SqlFunctionResult, SqlResult } from './sql-function'

type Spec<R extends SqlResult = SqlResult> = {
  sql: string
  result: R
  min: number
  max?: number
  aggregate?: boolean
  operator?: string
  token?: readonly string[]
  literalPath?: number
}
const spec = <R extends SqlResult>(sql: string, result: R, min: number, max = min): Spec<R> => ({
  sql,
  result,
  min,
  max,
})
const variadic = <R extends SqlResult>(sql: string, result: R, min: number): Spec<R> => ({
  sql,
  result,
  min,
})
const DATE_PARTS = [
  'year',
  'quarter',
  'month',
  'dayofyear',
  'day',
  'week',
  'weekday',
  'hour',
  'minute',
  'second',
  'millisecond',
  'microsecond',
  'nanosecond',
] as const
const MYSQL_UNITS = [
  'MICROSECOND',
  'SECOND',
  'MINUTE',
  'HOUR',
  'DAY',
  'WEEK',
  'MONTH',
  'QUARTER',
  'YEAR',
] as const

// @see https://www.postgresql.org/docs/15/functions-json.html
const postgres = {
  jsonbExtractPath: variadic('jsonb_extract_path', 'unknown', 2),
  jsonbExtractPathText: variadic('jsonb_extract_path_text', 'string', 2),
  jsonbContains: { ...spec('', 'boolean', 2), operator: '@>' },
  arrayAgg: { ...spec('array_agg', 'unknown', 1), aggregate: true },
  arrayContains: { ...spec('', 'boolean', 2), operator: '@>' },
  toTsVector: spec('to_tsvector', 'unknown', 1, 2),
  websearchToTsQuery: spec('websearch_to_tsquery', 'unknown', 1, 2),
  tsRank: spec('ts_rank', 'number', 2, 4),
} as const
// @see https://dev.mysql.com/doc/refman/8.0/en/json-search-functions.html
const mysql = {
  jsonExtract: variadic('json_extract', 'unknown', 2),
  jsonUnquote: spec('json_unquote', 'string', 1),
  jsonContains: spec('json_contains', 'number', 2, 3),
  findInSet: spec('find_in_set', 'number', 2),
  field: variadic('field', 'number', 2),
  dateFormat: spec('date_format', 'string', 2),
  strToDate: spec('str_to_date', 'date', 2),
  timestampDiff: { ...spec('timestampdiff', 'number', 3), token: MYSQL_UNITS },
} as const
// @see https://www.sqlite.org/json1.html
const sqlite = {
  jsonExtract: variadic('json_extract', 'unknown', 2),
  jsonType: spec('json_type', 'string', 1, 2),
  jsonGroupArray: { ...spec('json_group_array', 'string', 1), aggregate: true },
  jsonGroupObject: { ...spec('json_group_object', 'string', 2), aggregate: true },
  strftime: variadic('strftime', 'string', 1),
  julianday: variadic('julianday', 'number', 0),
  unixepoch: variadic('unixepoch', 'number', 0),
} as const
// @see https://learn.microsoft.com/en-us/sql/t-sql/functions/datediff-transact-sql
const sqlserver = {
  jsonValue: spec('json_value', 'string', 2),
  jsonQuery: spec('json_query', 'string', 1, 2),
  isJson: spec('isjson', 'number', 1),
  dateDiff: { ...spec('datediff', 'number', 3), token: DATE_PARTS },
  dateDiffBig: { ...spec('datediff_big', 'number', 3), token: DATE_PARTS },
  dateFromParts: spec('datefromparts', 'date', 3),
  eomonth: spec('eomonth', 'date', 1, 2),
} as const
// @see https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Single-Row-Functions.html
const oracle = {
  toChar: spec('to_char', 'string', 1, 3),
  toDate: spec('to_date', 'date', 1, 3),
  toTimestamp: spec('to_timestamp', 'date', 1, 3),
  addMonths: spec('add_months', 'date', 2),
  monthsBetween: spec('months_between', 'number', 2),
  lastDay: spec('last_day', 'date', 1),
  regexpSubstr: spec('regexp_substr', 'string', 2, 6),
  jsonValue: { ...spec('json_value', 'string', 2), literalPath: 1 },
  jsonQuery: { ...spec('json_query', 'string', 2), literalPath: 1 },
} as const

/** Explicit contract for an additional ordinary SQL function, including UDFs. */
export interface SqlFunctionDefinition<R extends SqlResult> {
  readonly name: string
  readonly result: R
  readonly kind: 'scalar' | 'aggregate'
}
type Namespace<S extends Record<string, Spec>> = {
  readonly [K in keyof S]: (...args: SqlArgument[]) => SqlFunctionResult<S[K]['result']>
} & {
  call<R extends SqlResult>(
    definition: SqlFunctionDefinition<R>,
    ...args: SqlArgument[]
  ): SqlFunctionResult<R>
}
export interface DialectFunctions {
  readonly postgres: Namespace<typeof postgres>
  readonly mysql: Namespace<typeof mysql>
  readonly sqlite: Namespace<typeof sqlite>
  readonly sqlserver: Namespace<typeof sqlserver> & {
    tryConvert(
      type: 'int' | 'bigint' | 'float' | 'date' | 'datetime2',
      value: SqlArgument,
      style?: number,
    ): import('@ts-grm/core').Expression<unknown>
  }
  readonly oracle: Namespace<typeof oracle>
}

export function createDialectFunctions(active: string): DialectFunctions {
  const namespaces: Record<string, unknown> = {}
  for (const [dialect, specs] of Object.entries({ postgres, mysql, sqlite, sqlserver, oracle })) {
    const assertDialect = () => {
      if (active !== dialect)
        throw new QuerySemanticError('DIALECT_MISMATCH', `${dialect} function used with ${active}`)
    }
    const namespace: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(specs)) {
      const entry: Spec = value
      namespace[name] = (...args: SqlArgument[]) => {
        assertDialect()
        if (args.length < entry.min || (entry.max !== undefined && args.length > entry.max))
          throw new TypeError(`${dialect}.${name}: invalid argument count`)
        let parts = [
          ...(entry.operator
            ? ['(', sqlArgument(args[0]!), ` ${entry.operator} `, sqlArgument(args[1]!), ')']
            : callParts(entry.sql, args)),
        ]
        if (entry.token) {
          const unit = args[0]
          if (typeof unit !== 'string' || !entry.token.includes(unit))
            throw new TypeError(`${dialect}.${name}: invalid unit`)
          parts = [`${entry.sql}(${unit}, `, ...callParts('', args.slice(1)).slice(1)]
        }
        if (entry.literalPath !== undefined) {
          const path = args[entry.literalPath]
          if (typeof path !== 'string')
            throw new TypeError(`${dialect}.${name}: path must be a string literal`)
          // Oracle SQL/JSON requires a literal path, not a bind variable.
          parts = [...parts]
          parts[1 + entry.literalPath * 2] = `'${path.replaceAll("'", "''")}'`
        }
        return sqlExpression(
          name,
          entry.result,
          entry.aggregate ? 'aggregate' : 'scalar',
          parts,
          dialect,
        )
      }
    }
    namespace.call = <R extends SqlResult>(
      definition: SqlFunctionDefinition<R>,
      ...args: SqlArgument[]
    ) => {
      assertDialect()
      if (!/^[a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)*$/.test(definition.name))
        throw new TypeError('Invalid SQL function identifier')
      if (
        !['scalar', 'aggregate'].includes(definition.kind) ||
        !['number', 'string', 'date', 'boolean', 'unknown'].includes(definition.result)
      )
        throw new TypeError('Invalid SQL function contract')
      return sqlExpression(
        definition.name,
        definition.result,
        definition.kind,
        callParts(definition.name, args),
        dialect,
      )
    }
    if (dialect === 'sqlserver') {
      namespace.tryConvert = (type: string, value: SqlArgument, style?: number) => {
        assertDialect()
        if (!['int', 'bigint', 'float', 'date', 'datetime2'].includes(type))
          throw new TypeError('Invalid TRY_CONVERT type')
        const args = style === undefined ? [value] : [value, style]
        return sqlExpression(
          'tryConvert',
          'unknown',
          'scalar',
          [`try_convert(${type}, `, ...callParts('', args).slice(1)],
          dialect,
        )
      }
    }
    namespaces[dialect] = Object.freeze(namespace)
  }
  return Object.freeze(namespaces) as unknown as DialectFunctions
}
