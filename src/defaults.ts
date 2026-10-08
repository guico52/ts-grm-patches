import type { ColumnDefaultExpression } from './types'

/**
 * 判断默认值是 SQL 表达式，而不是字面量。
 *
 * ts-grm 的所有表达式节点都实现 `__type()` 并返回 `expressionLike: true`，
 * 这里按该形状判别而不是 `instanceof`，以兼容同一进程加载 ESM/CJS 两份上游副本
 * 的情况。消费方（如迁移引擎）据此决定把默认值渲染成 `default <表达式>` 还是
 * `default <字面量>`。
 */
export function isColumnDefaultExpression(value: unknown): value is ColumnDefaultExpression {
  if (value == null || typeof value !== 'object') {
    return false
  }
  const typeOf = (value as { __type?: unknown }).__type
  if (typeof typeOf !== 'function') {
    return false
  }
  try {
    const marker = typeOf.call(value) as { expressionLike?: unknown } | undefined
    return marker?.expressionLike === true
  } catch {
    return false
  }
}
