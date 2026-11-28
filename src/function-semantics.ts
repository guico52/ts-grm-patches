import { validateNativeStringIndexes } from './string-arguments'
import { assertSubqueryPagination } from './subquery-guard'
import { ExpressionOrder, spi } from '@ts-grm/core'
import { isPortableFunction } from './function-contract'
import { createStringFunctions } from './string-functions'
import type { DialectProfile } from './dialect-context'
import type { ExpressionLike } from '@ts-grm/core'

export type FunctionKind = 'scalar' | 'aggregate' | 'opaque'

export interface FunctionMetadata {
  readonly name: string
  readonly kind: FunctionKind
  readonly dialect?: string
}

const metadata = new WeakMap<object, Readonly<FunctionMetadata>>()

/** Metadata belongs to the expression, not a process-global current query. */
function declaredMetadata(expression: object): Readonly<FunctionMetadata> | undefined {
  return (
    metadata.get(expression) ??
    (isPortableFunction(expression)
      ? { name: expression.fnName, kind: expression.kind }
      : undefined)
  )
}
export function getFunctionMetadata(expression: object): Readonly<FunctionMetadata> | undefined {
  const declared = declaredMetadata(expression)
  if (declared || !isExpression(expression)) return declared
  let result: FunctionMetadata | undefined
  expression.accept(
    visitor((method, payload) => {
      if (method === 'visitAggregateExpr') {
        result = {
          name: (payload as spi.AggregateExpr<number>).op.toLowerCase(),
          kind: 'aggregate',
        }
      } else if (
        [
          'visitCoalesceExpr',
          'visitBinaryNumExpr',
          'visitUnaryMinusExpr',
          'visitLowerExpr',
          'visitUpperExpr',
          'visitTrimExpr',
          'visitLengthExpr',
        ].includes(method)
      )
        result = { name: method.slice(5, -4).toLowerCase(), kind: 'scalar' }
    }),
  )
  return result
}

export function markFunction<T>(value: T, info: FunctionMetadata, replace = false): T {
  if (isExpression(value) && (replace || !metadata.has(value)))
    metadata.set(value, Object.freeze({ ...info }))
  return value
}

export function isExpression(value: unknown): value is ExpressionLike & spi.Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__type' in value &&
    typeof value.__type === 'function' &&
    value.__type()?.expressionLike === true &&
    'accept' in value &&
    typeof value.accept === 'function'
  )
}

export class QuerySemanticError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'QuerySemanticError'
  }
}

interface Shape {
  method: keyof spi.Visitor
  children: spi.Node[]
  bound: boolean
  column: boolean
  aggregate: boolean
  opaque: boolean
  subquery: boolean
  dialect?: string
}

function visitor(onVisit: (method: keyof spi.Visitor, value: unknown) => void): spi.Visitor {
  return new Proxy({} as spi.Visitor, {
    get: (_, method: keyof spi.Visitor) => (value: unknown) => onVisit(method, value),
  })
}

/** Read direct children using the upstream Visitor, never SQL text or private AST fields.
 * @see https://github.com/babyfish-ct/ts-grm/blob/8c89604b65922b4626df4e3b8a74d509338ea5b7/packages/core/src/impl/ast/visitor.ts
 */
function shapeOf(node: spi.Node): Shape {
  let method: keyof spi.Visitor | undefined
  let payload: unknown
  node.accept(
    visitor((key, value) => {
      method = key
      payload = value
    }),
  )
  if (method === undefined)
    throw new QuerySemanticError('UNKNOWN_EXPRESSION', 'Expression has no visitor event')
  const info = declaredMetadata(node)
  const shape: Shape = {
    method,
    children: [],
    bound: method === 'visitLiteral',
    column: method === 'visitPropExpr' || method === 'visitShadowExpr',
    aggregate: method === 'visitAggregateExpr' || info?.kind === 'aggregate',
    opaque: method === 'visitNativeExpr' && (info === undefined || info.kind === 'opaque'),
    subquery:
      method === 'visitSubQueryExpr' ||
      method === 'visitAtomQuery' ||
      method === 'visitMergedQuery' ||
      method === 'visitExistsPred',
    dialect: info?.dialect,
  }
  if (shape.subquery || shape.column || method === 'visitLiteral' || method === 'visitConstant')
    return shape
  if (method === 'visitFetchedView' || method === 'visitIsPred') {
    throw new QuerySemanticError(
      'UNSUPPORTED_PROJECTION',
      'autoGroupBy requires scalar expression selections',
    )
  }
  const collect = visitor((key, value) => {
    if (key === 'visitLiteral') shape.bound = true
    else if (
      key !== 'visitConstant' &&
      typeof value === 'object' &&
      value !== null &&
      'accept' in value
    ) {
      shape.children.push(value as spi.Node)
    }
  })
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Upstream visitor dispatch is called with an explicit receiver below (walk.call).
  const walk = spi.AbstractVisitor.prototype[method] as (this: spi.Visitor, value: unknown) => void
  if (typeof walk !== 'function') throw new QuerySemanticError('UNKNOWN_EXPRESSION', String(method))
  walk.call(collect, payload)
  // Upstream's default traversal omits these public operands. They matter both
  // for aggregate detection and for parameterized GROUP BY equivalence.
  if (method === 'visitLikePred') (payload as spi.LikePred).pattern.accept(collect)
  if (method === 'visitInCollectionPred') {
    for (const value of (payload as spi.InCollectionPred<unknown>).values) value.accept(collect)
  }
  if (method === 'visitEsOpPred') shape.bound ||= (payload as spi.EsOpPred).values.length > 0
  return shape
}

class DialectValidator extends spi.AbstractVisitor {
  constructor(
    private readonly dialect: string,
    private readonly profile?: DialectProfile,
  ) {
    super()
  }
  private readonly seen = new WeakSet<object>()
  override visitNativeExpr(expr: spi.NativeExprContract): void {
    if (isPortableFunction(expr) && this.profile) expr.validate(this.profile)
    const source = declaredMetadata(expr)
    if (source?.dialect !== undefined && source.dialect !== this.dialect) {
      throw new QuerySemanticError(
        'DIALECT_MISMATCH',
        `${source.dialect} expression used with ${this.dialect}`,
      )
    }
    super.visitNativeExpr(expr)
  }
  override visitLeftExpr(expr: spi.LeftExpr): void {
    validateNativeStringIndexes('Left', expr)
    super.visitLeftExpr(expr)
  }
  override visitRightExpr(expr: spi.RightExpr): void {
    validateNativeStringIndexes('Right', expr)
    super.visitRightExpr(expr)
  }
  override visitPadExpr(expr: spi.PadExpr): void {
    validateNativeStringIndexes('Pad', expr)
    super.visitPadExpr(expr)
  }
  override visitSubstringExpr(expr: spi.SubstringExpr): void {
    validateNativeStringIndexes('Substring', expr)
    super.visitSubstringExpr(expr)
  }
  override visitPositionExpr(expr: spi.PositionExpr): void {
    validateNativeStringIndexes('Position', expr)
    super.visitPositionExpr(expr)
  }
  override visitReverseExpr(expr: spi.ReverseExpr): void {
    if (this.profile && ['sqlite', 'oracle'].includes(this.profile.family))
      createStringFunctions(this.profile).reverse(expr.expr)
    super.visitReverseExpr(expr)
  }
  override visitShadowExpr(expr: spi.ShadowExprContract): void {
    const original = expr.anchor.original
    if (isExpression(original) && !this.seen.has(original)) {
      this.seen.add(original)
      original.accept(this)
    }
  }
  override visitAtomQuery(query: spi.AtomQueryContract): void {
    assertSubqueryPagination(query)
    if (this.seen.has(query)) return
    this.seen.add(query)
    super.visitAtomQuery(query)
    const projection = query.projection
    const selections =
      'selection' in projection
        ? [projection.selection]
        : 'selections' in projection
          ? Object.values(projection.selections)
          : Object.values(projection.args)
    for (const selection of selections) if (isExpression(selection)) selection.accept(this)
  }
  override visitLikePred(pred: spi.LikePred): void {
    super.visitLikePred(pred)
    pred.pattern.accept(this)
  }
  override visitInCollectionPred(pred: spi.InCollectionPred<unknown>): void {
    super.visitInCollectionPred(pred)
    for (const value of pred.values) value.accept(this)
  }
}
/** Validate provenance independently of autoGroupBy; raw SQL remains opaque. */
export function validateFunctionDialects(
  values: readonly unknown[],
  dialect: string,
  profile?: DialectProfile,
): void {
  const validator = new DialectValidator(dialect, profile)
  for (const value of values) {
    const expression = value instanceof ExpressionOrder ? value.expression : value
    if (isExpression(expression)) expression.accept(validator)
  }
}

interface Analysis {
  aggregate: boolean
  column: boolean
  bound: boolean
  subquery: boolean
  children: readonly spi.Node[]
}

export function inferGroupBy(
  selections: readonly unknown[],
  predicates: readonly unknown[],
  having: readonly unknown[],
  orders: readonly unknown[],
  dialect: string,
): readonly ExpressionLike[] {
  const cache = new Map<spi.Node, Analysis>()
  const shapes = new Map<spi.Node, Shape>()
  const shapeOfCached = (node: spi.Node): Shape => {
    let shape = shapes.get(node)
    if (shape === undefined) {
      shape = shapeOf(node)
      shapes.set(node, shape)
    }
    return shape
  }
  const analyze = (node: spi.Node, insideAggregate = false): Analysis => {
    const cached = cache.get(node)
    if (cached !== undefined) {
      // A subtree valid outside an aggregate may become nested inside one.
      if (insideAggregate && cached.aggregate)
        throw new QuerySemanticError('NESTED_AGGREGATE', 'Same-stage aggregate nesting is invalid')
      return cached
    }
    const shape = shapeOfCached(node)
    if (shape.dialect !== undefined && shape.dialect !== dialect) {
      throw new QuerySemanticError(
        'DIALECT_MISMATCH',
        `${shape.dialect} expression used with ${dialect}`,
      )
    }
    if (shape.opaque)
      throw new QuerySemanticError(
        'OPAQUE_EXPRESSION',
        'Annotate native SQL with fn.scalar() or fn.aggregate()',
      )
    if (shape.subquery) {
      // Do not leak internal columns/aggregates into the outer GROUP BY.
      // Correlated grouping needs ownership analysis; reject instead of guessing.
      throw new QuerySemanticError(
        'UNSUPPORTED_SUBQUERY',
        'Put subqueries in an explicit baseQuery stage before autoGroupBy',
      )
    }
    if (insideAggregate && shape.aggregate)
      throw new QuerySemanticError('NESTED_AGGREGATE', 'Same-stage aggregate nesting is invalid')
    const children = shape.children.map((child) =>
      analyze(child, insideAggregate || shape.aggregate),
    )
    const result: Analysis = {
      aggregate: shape.aggregate || children.some((child) => child.aggregate),
      column: shape.column || children.some((child) => child.column),
      bound: shape.bound || children.some((child) => child.bound),
      subquery: shape.subquery,
      children: shape.children,
    }
    cache.set(node, result)
    return result
  }
  const nodes = (values: readonly unknown[]): spi.Node[] =>
    values
      .map((value) => (value instanceof ExpressionOrder ? value.expression : value))
      .filter((value): value is ExpressionLike & spi.Node => {
        if (!isExpression(value))
          throw new QuerySemanticError('UNSUPPORTED_PROJECTION', 'Expected a scalar expression')
        return true
      })
  const selected = nodes(selections)
  if (selected.length === 0)
    throw new QuerySemanticError('UNSUPPORTED_PROJECTION', 'The projection cannot be empty')
  const rowPredicates = nodes(predicates)
  const postGroup = nodes([...having, ...orders])
  for (const node of rowPredicates) {
    if (analyze(node).aggregate)
      throw new QuerySemanticError('INVALID_STAGE', 'Aggregate functions cannot appear in WHERE')
  }
  const analyses = [...selected, ...postGroup].map((node) => analyze(node))
  if (!analyses.some((value) => value.aggregate)) return []
  const sameKey = (a: spi.Node, b: spi.Node): boolean => {
    if (a === b) return true
    const x = a as Partial<spi.PropExprContract>
    const y = b as Partial<spi.PropExprContract>
    if (x.prop !== undefined && x.table === y.table && x.prop === y.prop) return true
    const left = shapeOfCached(a)
    const right = shapeOfCached(b)
    // Only proven immutable unary operations; never compare rendered SQL text.
    return (
      left.method === right.method &&
      [
        'visitLowerExpr',
        'visitUpperExpr',
        'visitLengthExpr',
        'visitReverseExpr',
        'visitUnaryMinusExpr',
      ].includes(left.method) &&
      left.children.length === right.children.length &&
      left.children.every((child, index) => sameKey(child, right.children[index]!))
    )
  }
  const keys: spi.Node[] = []
  const collectKeys = (node: spi.Node): void => {
    const result = cache.get(node)!
    if (shapeOfCached(node).aggregate) return
    if (!result.aggregate) {
      if (!result.column) return
      if (result.bound)
        throw new QuerySemanticError(
          'PARAMETERIZED_GROUP_KEY',
          'Project parameterized keys through fn.baseQuery() and fn.derivedModel() first',
        )
      if (!keys.some((key) => sameKey(key, node))) keys.push(node)
    } else result.children.forEach(collectKeys)
  }
  selected.forEach(collectKeys)
  const covered = (node: spi.Node): boolean => {
    if (keys.some((key) => sameKey(key, node)) || shapeOfCached(node).aggregate) return true
    const result = cache.get(node)!
    if (!result.column) return true
    return result.children.length > 0 && result.children.every(covered)
  }
  for (const node of postGroup) {
    if (!covered(node))
      throw new QuerySemanticError(
        'UNGROUPED_DEPENDENCY',
        'HAVING/ORDER BY references a value outside the inferred group keys',
      )
  }
  return keys as unknown as ExpressionLike[]
}
