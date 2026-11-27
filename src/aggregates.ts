import { spi } from '@ts-grm/core'
import { markFunction } from './function-semantics'

class AggregateString extends spi.AbstractStrExpr {
  constructor(readonly source: spi.AggregateExpr<string | number>) {
    super()
  }
  override accept(visitor: spi.Visitor): void {
    visitor.visitAggregateExpr(this.source)
  }
}
class AggregateDate extends spi.AbstractDtExpr {
  constructor(readonly source: spi.AggregateExpr<string | number>) {
    super()
  }
  override accept(visitor: spi.Visitor): void {
    visitor.visitAggregateExpr(this.source)
  }
}
class AggregateEnumSet extends spi.AbstractEsExpr<string> {
  constructor(readonly source: spi.AggregateExpr<string | number>) {
    super()
  }
  override accept(visitor: spi.Visitor): void {
    visitor.visitAggregateExpr(this.source)
  }
}

/** Own the aggregate node so metadata/decoding never modify a caller's expression. */
export function aggregate(
  op: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX',
  input?: unknown,
  options?: { as: 'number' | 'string' },
): unknown {
  if (options !== undefined && options.as !== 'number' && options.as !== 'string')
    throw new TypeError('Expected numeric return mode number or string')
  const expr = input as spi.AbstractExpr<string | number> | undefined
  const source = new spi.AggregateExpr(op, expr)
  let result: unknown = source
  if (op === 'MIN' || op === 'MAX') {
    if (expr instanceof spi.AbstractStrExpr) result = new AggregateString(source)
    else if (expr instanceof spi.AbstractDtExpr) result = new AggregateDate(source)
    else if (expr instanceof spi.AbstractEsExpr) result = new AggregateEnumSet(source)
  }
  const explicitDataType =
    options?.as === 'string'
      ? spi.ExplicitDataType.STRING
      : options?.as === 'number' ||
          (op === 'AVG' && expr?.explicitDataType !== spi.ExplicitDataType.STRING)
        ? spi.ExplicitDataType.FLOAT
        : source.explicitDataType
  if (Reflect.get(result as object, 'explicitDataType') !== explicitDataType)
    Object.defineProperty(result, 'explicitDataType', { value: explicitDataType })
  markFunction(source, { name: op.toLowerCase(), kind: 'aggregate' })
  return markFunction(result, { name: op.toLowerCase(), kind: 'aggregate' })
}
