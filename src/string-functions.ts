import { spi } from '@ts-grm/core'
import type { DialectProfile } from './dialect-context'
import { QuerySemanticError } from './function-semantics'
import { callParts, sqlArgument, sqlExpression } from './sql-function'
import type { SqlArgument } from './sql-function'

type Index = number | spi.AbstractNumExpr<number>
type Parts = spi.NativeExprContract['parts']

/** String syntax differs even where the native drivers share a renderer.
 * @see https://www.postgresql.org/docs/15/functions-string.html
 * @see https://dev.mysql.com/doc/refman/8.4/en/string-functions.html
 * @see https://www.sqlite.org/lang_corefunc.html
 * @see https://learn.microsoft.com/en-us/sql/t-sql/functions/substring-transact-sql
 * @see https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/INSTR.html
 */
export function createStringFunctions(profile: DialectProfile) {
  const dialect = profile.family
  const str = (name: string, parts: Parts) =>
    sqlExpression(name, 'string', 'scalar', parts, dialect)
  const num = (name: string, parts: Parts) =>
    sqlExpression(name, 'number', 'scalar', parts, dialect)
  const index = (value: Index, minimum: number) => {
    if (typeof value !== 'number' && !(value instanceof spi.AbstractNumExpr))
      throw new TypeError('String index/length requires a number or numeric expression')
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < minimum))
      throw new TypeError(`String index/length must be a safe integer >= ${minimum}`)
    return sqlArgument(value)
  }
  const substring = (expression: spi.AbstractStrExpr, start: Index, length?: Index) => {
    const offset = index(start, 1)
    const size = length === undefined ? undefined : index(length, 0)
    if (dialect === 'sqlserver') {
      return str(
        'substring',
        size === undefined
          ? [
              'substring(cast(',
              expression,
              ' as nvarchar(max)), cast(',
              offset,
              ' as bigint), 2147483647)',
            ]
          : callParts('substring', [expression, offset, size]),
      )
    }
    // Oracle SUBSTR(..., ..., 0) returns NULL (its empty string semantics).
    return str(
      'substring',
      callParts('substr', size === undefined ? [expression, offset] : [expression, offset, size]),
    )
  }
  const left = (expression: spi.AbstractStrExpr, length: Index) => {
    const size = index(length, 0)
    return str(
      'left',
      dialect === 'sqlite' || dialect === 'oracle'
        ? ['substr(', expression, ', 1, ', size, ')']
        : callParts('left', [expression, size]),
    )
  }
  const right = (expression: spi.AbstractStrExpr, length: Index) => {
    const size = index(length, 0)
    if (dialect !== 'sqlite' && dialect !== 'oracle')
      return str('right', callParts('right', [expression, size]))
    return str('right', [
      '(case when ',
      expression,
      ' is null then null when ',
      size,
      " = 0 then '' else substr(",
      expression,
      ', -(',
      size,
      ')) end)',
    ])
  }
  const position = (expression: spi.AbstractStrExpr, needle: string, start?: Index) => {
    const search = sqlArgument(needle)
    const offset = start === undefined ? undefined : index(start, 1)
    const args: SqlArgument[] =
      dialect === 'mysql' || dialect === 'sqlserver' ? [search, expression] : [expression, search]
    const sql =
      dialect === 'mysql'
        ? 'locate'
        : dialect === 'sqlserver'
          ? 'charindex'
          : dialect === 'postgres'
            ? 'strpos'
            : 'instr'
    if (
      offset === undefined ||
      dialect === 'mysql' ||
      dialect === 'sqlserver' ||
      dialect === 'oracle'
    )
      return num('position', callParts(sql, offset === undefined ? args : [...args, offset]))
    const found = num('position.offset', [
      `${sql}(substr(`,
      expression,
      ', ',
      offset,
      '), ',
      search,
      ')',
    ])
    return num('position', [
      '(case when ',
      found,
      ' = 0 then 0 else (',
      found,
      ' + ',
      offset,
      ' - 1) end)',
    ])
  }
  const pad = (
    side: 'left' | 'right',
    expression: spi.AbstractStrExpr,
    length: Index,
    fill?: string,
  ) => {
    const name = side === 'left' ? 'lpad' : 'rpad'
    const size = index(length, 0)
    const padding = fill === undefined ? str('pad.default', ["' '"]) : sqlArgument(fill)
    if (dialect !== 'sqlite' && dialect !== 'sqlserver')
      return str(name, callParts(name, [expression, size, padding]))
    const chars =
      dialect === 'sqlite'
        ? num('pad.length', callParts('length', [expression]))
        : num('pad.length', ['(len(cast(', expression, " as nvarchar(max)) + N'#') - 1)"])
    const repeated = str(
      'pad.repeat',
      dialect === 'sqlite'
        ? ['replace(hex(zeroblob(', size, ")), '00', ", padding, ')']
        : ['replicate(cast(', padding, ' as nvarchar(max)), ', size, ')'],
    )
    const needed = num('pad.needed', ['(', size, ' - ', chars, ')'])
    const extra =
      dialect === 'sqlite'
        ? str('pad.extra', ['substr(', repeated, ', 1, ', needed, ')'])
        : str('pad.extra', callParts('left', [repeated, needed]))
    const padded: Parts =
      side === 'left'
        ? [extra, dialect === 'sqlite' ? ' || ' : ' + ', expression]
        : [expression, dialect === 'sqlite' ? ' || ' : ' + ', extra]
    return str(name, [
      '(case when ',
      expression,
      ' is null or ',
      size,
      ' is null then null when ',
      size,
      ' <= ',
      chars,
      ' or ',
      padding,
      " = '' then ",
      left(expression, length),
      ' else (',
      ...padded,
      ') end)',
    ])
  }
  return {
    left,
    right,
    substring,
    position,
    lpad: (expression: spi.AbstractStrExpr, length: Index, fill?: string) =>
      pad('left', expression, length, fill),
    rpad: (expression: spi.AbstractStrExpr, length: Index, fill?: string) =>
      pad('right', expression, length, fill),
    trim: (expression: spi.AbstractStrExpr) =>
      str(
        'trim',
        dialect === 'sqlserver'
          ? ['ltrim(rtrim(', expression, '))']
          : callParts('trim', [expression]),
      ),
    reverse: (expression: spi.AbstractStrExpr) => {
      if (dialect === 'sqlite' || dialect === 'oracle')
        throw new QuerySemanticError(
          'UNSUPPORTED_FUNCTION',
          `${dialect} has no supported built-in reverse; use an explicit UDF contract`,
        )
      return str('reverse', callParts('reverse', [expression]))
    },
  }
}
