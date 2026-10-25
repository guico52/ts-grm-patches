import { prop } from '@ts-grm/core'
import type { __ScalarProp } from '@ts-grm/core'

/**
 * 可参与查询表达式的布尔列声明（类型侧补丁）。
 *
 * 上游 0.0.13 的 `__MakeExpression` 用 `R extends Date ? … : R extends string ? …` 推导列表达式，
 * `R` 是 `infer` 出的裸类型参数，条件类型对它分配，`boolean` 被拆成 `true | false`：
 * 列成员成为 `Expression<true> | Expression<false>`，其上 `eq` 的参数取交集后为 `never`。
 *
 * `__MakeExpression` 是类型别名，无法用模块增强覆盖。但它的 `Customized extends true`
 * 分支排在 `R extends Date` 之前，并把 `R` 原样传给 `Expression<R>`，不会拆分 `boolean`。
 * `Customized` 只影响表达式类型推导与嵌入字段的可空性推导，不改变 DTO 类型与运行时行为。
 * 因此这里只在类型上把 `prop.bool()` 标记为 `Customized`：运行时就是 `prop.bool()` 本身。
 *
 * 运行时的表达式支持由 `applyPatches()` 安装（见 `query-props.ts`）。上游修复后，
 * 直接改回 `prop.bool()` 即可，无需迁移（列定义完全相同）。
 *
 * 注意：上游 `nullable()` 的返回类型会丢掉 `Customized` 标记，可空布尔列请用 `nullableBool()`。
 * `default(...)` 返回 `this`，标记会保留。
 */
export function bool(): __ScalarProp<boolean, 'NONNULL', true> {
  // 纯类型层面的重新标注：值就是 prop.bool()，只改变 Customized 类型参数。
  return prop.bool() as unknown as __ScalarProp<boolean, 'NONNULL', true>
}

/** 可空的 `bool()`，等价于 `prop.bool().nullable()`。 */
export function nullableBool(): __ScalarProp<boolean, 'NULLABLE', true> {
  return prop.bool().nullable() as unknown as __ScalarProp<boolean, 'NULLABLE', true>
}
