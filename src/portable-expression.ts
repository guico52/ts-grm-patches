import { spi } from '@ts-grm/core'
import type { ExpressionLike } from '@ts-grm/core'
import type { DialectProfile } from './dialect-context'
import {
  createPortableFunctions,
  NUMERIC_FUNCTIONS,
  validatePortableArguments,
  validatePortableCapabilities,
} from './portable-functions'
import type { PortableFunctions } from './portable-functions'
import { sqlArgument, sqlExpression, callParts } from './sql-function'
import type { SqlArgument, SqlResult, SqlFunctionResult } from './sql-function'
import { portableNode } from './function-contract'
import { isExpression } from './function-semantics'
import { renderProfile } from './render-profile'

type Parts = spi.NativeExprContract['parts']
const adapters = new WeakMap<DialectProfile, PortableFunctions>()
function lower(profile: DialectProfile, name: string, args: readonly SqlArgument[]) {
  if (name === 'concat') {
    const parts =
      profile.family === 'mysql' || profile.family === 'sqlserver'
        ? callParts('concat', args)
        : [
            '(',
            ...args.flatMap((arg, index) =>
              index === 0 ? [sqlArgument(arg)] : [' || ', sqlArgument(arg)],
            ),
            ')',
          ]
    return sqlExpression('concat', 'string', 'scalar', parts) as unknown as ExpressionLike &
      spi.Node
  }
  let functions = adapters.get(profile)
  if (!functions) {
    functions = createPortableFunctions(profile)
    adapters.set(profile, functions)
  }
  return Reflect.apply(
    Reflect.get(functions, name) as (...args: never[]) => unknown,
    undefined,
    args,
  ) as ExpressionLike & spi.Node
}
interface Data {
  fnName: string
  kind: 'scalar' | 'aggregate'
  args: readonly SqlArgument[]
  parts: Parts
}
function accept(data: Data, visitor: spi.Visitor) {
  // FragmentGenGenVisitor exposes sqlClient publicly; PreVisitor only has a
  // private _sqlClient. Non-rendering visitors see the original operand nodes.
  // @see https://github.com/babyfish-ct/ts-grm/blob/8c89604b65922b4626df4e3b8a74d509338ea5b7/packages/sql/src/sql/fragment_gen_visitor.ts
  if (
    'sqlClient' in visitor &&
    typeof visitor.sqlClient === 'object' &&
    visitor.sqlClient !== null
  ) {
    lower(renderProfile(visitor.sqlClient), data.fnName, data.args).accept(visitor)
  } else visitor.visitNativeExpr(data)
}
class PortableNumber extends spi.AbstractNumExpr<number> implements Data {
  readonly [portableNode] = true as const
  readonly parts: Parts
  readonly kind: 'scalar' | 'aggregate'
  constructor(
    readonly fnName: string,
    readonly args: readonly SqlArgument[],
  ) {
    super()
    this.kind = fnName === 'countDistinct' ? 'aggregate' : 'scalar'
    this.parts = args.map(sqlArgument)
  }
  override get explicitDataType() {
    return this.kind === 'aggregate' ? spi.ExplicitDataType.INTEGER : spi.ExplicitDataType.FLOAT
  }
  validate(profile: DialectProfile) {
    validatePortableCapabilities(profile, this.fnName)
  }
  override accept(visitor: spi.Visitor) {
    accept(this, visitor)
  }
}

class PortableString extends spi.AbstractStrExpr implements Data {
  readonly [portableNode] = true as const
  readonly kind = 'scalar' as const
  readonly parts: Parts
  constructor(
    readonly fnName: string,
    readonly args: readonly SqlArgument[],
  ) {
    super()
    this.parts = args.map(sqlArgument)
  }
  validate(profile: DialectProfile) {
    validatePortableCapabilities(profile, this.fnName)
  }
  override accept(visitor: spi.Visitor) {
    accept(this, visitor)
  }
}
export function deferredConcat(args: readonly unknown[]) {
  if (args.length === 0) throw new TypeError('concat requires at least one argument')
  for (const value of args) {
    if (
      typeof value !== 'string' &&
      (!isExpression(value) || !(value instanceof spi.AbstractStrExpr))
    )
      throw new TypeError('concat requires strings or string expressions')
  }
  if (args.length === 1)
    return sqlArgument(args[0] as SqlArgument) as unknown as import('@ts-grm/core').StrExpression<
      string | null
    >
  return new PortableString(
    'concat',
    Object.freeze([...args] as SqlArgument[]),
  ) as unknown as import('@ts-grm/core').StrExpression<string | null>
}

export function portableFunction<R extends SqlResult>(
  name: string,
  _result: R,
  args: readonly SqlArgument[],
): SqlFunctionResult<R> {
  return new PortableNumber(name, Object.freeze([...args])) as unknown as SqlFunctionResult<R>
}
export function createPortableFacade(): PortableFunctions {
  const functions: Record<string, unknown> = {}
  for (const name of [...NUMERIC_FUNCTIONS, 'charLength', 'octetLength', 'countDistinct']) {
    functions[name] = (...args: SqlArgument[]) => {
      validatePortableArguments(name, args)
      return portableFunction(name, 'number', args)
    }
  }
  return Object.freeze(functions) as unknown as PortableFunctions
}
