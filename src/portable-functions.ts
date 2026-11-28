import { spi } from '@ts-grm/core'
import type { ExpressionLike, NumExpression, StrExpression } from '@ts-grm/core'
import type { DialectProfile } from './dialect-context'
import { isExpression, QuerySemanticError } from './function-semantics'
import { callParts, sqlArgument, sqlExpression } from './sql-function'

export type NumericArgument =
  | number
  | null
  | NumExpression<number>
  | NumExpression<number | null>
  | NumExpression<number | undefined>
  | NumExpression<number | null | undefined>
  | NumExpression<string>
  | NumExpression<string | null>
  | NumExpression<string | undefined>
  | NumExpression<string | null | undefined>
export type StringArgument =
  | string
  | null
  | StrExpression<string>
  | StrExpression<string | null>
  | StrExpression<string | undefined>
  | StrExpression<string | null | undefined>
type NumericFunction = (value: NumericArgument) => NumExpression<number | null>
export interface PortableFunctions {
  readonly abs: NumericFunction
  readonly sign: NumericFunction
  readonly ceil: NumericFunction
  readonly floor: NumericFunction
  readonly trunc: NumericFunction
  readonly sqrt: NumericFunction
  readonly exp: NumericFunction
  readonly ln: NumericFunction
  readonly log10: NumericFunction
  readonly round: (value: NumericArgument, digits?: number) => NumExpression<number | null>
  readonly power: (
    value: NumericArgument,
    exponent: NumericArgument,
  ) => NumExpression<number | null>
  readonly charLength: (value: StringArgument) => NumExpression<number | null>
  readonly octetLength: (value: StringArgument) => NumExpression<number | null>
  readonly countDistinct: (value: ExpressionLike) => NumExpression<number>
}

export const NUMERIC_FUNCTIONS = [
  'abs',
  'sign',
  'ceil',
  'floor',
  'trunc',
  'sqrt',
  'exp',
  'ln',
  'log10',
  'round',
  'power',
] as const
export const STRING_FUNCTIONS = ['charLength', 'octetLength'] as const

function validateNumber(value: unknown): void {
  if (
    typeof value === 'number'
      ? !Number.isFinite(value)
      : value !== null && (!isExpression(value) || !(value instanceof spi.AbstractNumExpr))
  )
    throw new TypeError('Expected a finite number or numeric expression')
}
function validateString(value: unknown): void {
  if (
    typeof value !== 'string' &&
    value !== null &&
    (!isExpression(value) || !(value instanceof spi.AbstractStrExpr))
  )
    throw new TypeError('Expected a string or string expression')
}
function validateDigits(digits: unknown): void {
  if (
    digits !== undefined &&
    (typeof digits !== 'number' || !Number.isSafeInteger(digits) || digits < 0)
  )
    throw new TypeError('round digits must be a nonnegative safe integer')
}
/** Validation creates no lowered AST or argument literals. */
export function validatePortableArguments(name: string, args: readonly unknown[]): void {
  if (name === 'countDistinct') {
    if (!isExpression(args[0])) throw new TypeError('countDistinct requires one expression')
  } else if (name === 'charLength' || name === 'octetLength') validateString(args[0])
  else {
    validateNumber(args[0])
    if (name === 'round') validateDigits(args[1])
    if (name === 'power') validateNumber(args[1])
  }
}
export function validatePortableCapabilities(profile: DialectProfile, name: string): void {
  if (profile.family !== 'sqlite') return
  if (
    ['ceil', 'floor', 'trunc', 'sqrt', 'exp', 'ln', 'log10', 'power'].includes(name) &&
    profile.capabilities['sqlite.mathFunctions'] !== true
  )
    throw new QuerySemanticError(
      'UNSUPPORTED_FUNCTION',
      `${name} requires capabilities['sqlite.mathFunctions'] = true (SQLITE_ENABLE_MATH_FUNCTIONS)`,
    )
  if (name === 'octetLength') {
    const capability = profile.capabilities['sqlite.octetLength']
    const version = profile.serverVersion
    const supported =
      version !== undefined && (version[0] > 3 || (version[0] === 3 && (version[1] ?? 0) >= 43))
    if (capability === false || (capability !== true && !supported))
      throw new QuerySemanticError(
        'UNSUPPORTED_FUNCTION',
        "octetLength requires SQLite >= 3.43 or capabilities['sqlite.octetLength'] = true",
      )
  }
}

/** Lower to native expression parts, so the semantic visitor still sees operands.
 * @see https://www.postgresql.org/docs/15/functions-math.html
 * @see https://dev.mysql.com/doc/refman/8.4/en/mathematical-functions.html
 * @see https://www.sqlite.org/lang_mathfunc.html
 * @see https://learn.microsoft.com/en-us/sql/t-sql/functions/round-transact-sql
 * @see https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Single-Row-Functions.html
 */
export function createPortableFunctions(profile: DialectProfile): PortableFunctions {
  const dialect = profile.family
  const number = (value: NumericArgument) => {
    validateNumber(value)
    return sqlArgument(value)
  }
  const string = (value: StringArgument) => {
    validateString(value)
    return sqlArgument(value)
  }
  const result = (name: string, parts: spi.NativeExprContract['parts']) =>
    sqlExpression(name, 'number', 'scalar', parts, dialect)
  const requireMath = (name: string) => validatePortableCapabilities(profile, name)
  const functions: Record<string, unknown> = {}
  for (const name of NUMERIC_FUNCTIONS) {
    if (name === 'round' || name === 'power') continue
    functions[name] = (value: NumericArgument) => {
      const input = number(value)
      if (!['abs', 'sign'].includes(name)) requireMath(name)
      let sql: string = name
      if (name === 'ceil' && dialect === 'sqlserver') sql = 'ceiling'
      if (name === 'ln' && dialect === 'sqlserver') sql = 'log'
      if (name === 'log10' && dialect === 'postgres') sql = 'log'
      if (name === 'trunc' && dialect === 'mysql') return result(name, ['truncate(', input, ', 0)'])
      if (name === 'trunc' && dialect === 'sqlserver')
        return result(name, ['round(', input, ', 0, 1)'])
      // Postgres has trunc(numeric) and trunc(double precision), so an untyped bind
      // parameter makes the call ambiguous ("function trunc(unknown) is not unique").
      if (name === 'trunc' && dialect === 'postgres')
        return result(name, ['trunc(cast(', input, ' as numeric))'])
      if (name === 'log10' && dialect === 'oracle') return result(name, ['log(10, ', input, ')'])
      return result(name, callParts(sql, [input]))
    }
  }
  functions.round = (value: NumericArgument, digits?: number) => {
    // SQLite treats negative scale as zero; reject that nonportable contract.
    validateDigits(digits)
    const input = number(value)
    return result(
      'round',
      dialect === 'postgres'
        ? [
            'round(cast(',
            input,
            ' as numeric), ',
            digits === undefined ? '0' : sqlArgument(digits),
            ')',
          ]
        : ['round(', input, ', ', digits === undefined ? '0' : sqlArgument(digits), ')'],
    )
  }
  functions.power = (value: NumericArgument, exponent: NumericArgument) => {
    requireMath('power')
    const input = number(value)
    const exp = number(exponent)
    // SQL Server's POWER(int, negative exponent) otherwise returns an integer.
    // Postgres has both power(numeric, numeric) and power(double precision, double
    // precision), so untyped bind parameters do not resolve ("function power(unknown,
    // unknown) does not exist"); cast both operands instead.
    return result(
      'power',
      dialect === 'sqlserver'
        ? ['power(cast(', input, ' as float), ', exp, ')']
        : dialect === 'postgres'
          ? ['power(cast(', input, ' as numeric), cast(', exp, ' as numeric))']
          : callParts('power', [input, exp]),
    )
  }
  // @see https://learn.microsoft.com/en-us/sql/t-sql/functions/len-transact-sql
  functions.charLength = (value: StringArgument) => {
    const input = string(value)
    if (dialect === 'sqlserver')
      return result('charLength', ['(len(cast(', input, " as nvarchar(max)) + N'#') - 1)"])
    return result(
      'charLength',
      callParts(dialect === 'mysql' || dialect === 'postgres' ? 'char_length' : 'length', [input]),
    )
  }
  // @see https://www.sqlite.org/releaselog/3_43_0.html
  functions.octetLength = (value: StringArgument) => {
    validatePortableCapabilities(profile, 'octetLength')
    const sql =
      dialect === 'sqlserver' ? 'datalength' : dialect === 'oracle' ? 'lengthb' : 'octet_length'
    return result('octetLength', callParts(sql, [string(value)]))
  }
  functions.countDistinct = (value: ExpressionLike) => {
    if (!isExpression(value)) throw new TypeError('countDistinct requires one expression')
    const expression = sqlExpression(
      'countDistinct',
      'number',
      'aggregate',
      ['count(distinct ', value, ')'],
      dialect,
    )
    Object.defineProperty(expression, 'explicitDataType', { value: spi.ExplicitDataType.INTEGER })
    return expression
  }
  return Object.freeze(functions) as unknown as PortableFunctions
}
