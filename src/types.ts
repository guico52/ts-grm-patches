import type { ExpressionLike, __NullityType, spi } from '@ts-grm/core'

/**
 * 字面量默认值。
 *
 * `Date` 也在其中：`prop.dt()` 的值类型就是 `Date`，所以 `default(new Date())` 是合法
 * 声明，运行时会把这个 `Date` 原样带到列元数据上。至于如何把它写成 SQL 字面量
 （时区、格式），由消费方决定。
 */
export type ColumnDefaultLiteral = string | number | boolean | bigint | Date

/**
 * SQL 表达式默认值，复用上游的表达式 DSL（如 `dsl.native.date`now()``）。
 *
 * 这里只承载表达式节点本身，不承载任何 SQL 文本 —— 把它渲染成 `default <SQL>`
 * 是消费方（例如 ts-grm-migrate）的职责。
 */
export type ColumnDefaultExpression = ExpressionLike

/** 列的默认值：字面量或 SQL 表达式。 */
export type ColumnDefaultValue = ColumnDefaultLiteral | ColumnDefaultExpression

/**
 * 补丁附加在 prop 定义数据（上游 `__PropData`）上的字段。
 *
 * 上游的 `__PropData` 是 type alias，无法用声明合并扩展，因此补丁侧单独描述
 * 这两个字段，运行时以附加属性的形式写入。
 */
export interface ColumnPatchData {
  readonly autoIncrement?: boolean
  readonly default?: ColumnDefaultValue
}

/**
 * 携带补丁元数据的 `EntityProp`。
 *
 * `ColumnDef.prop` 是 `spi.EntityProp`，补丁在这两个只读属性上暴露列级信息，
 * 供迁移引擎等消费方读取。
 */
export type PatchedEntityProp = spi.EntityProp & {
  readonly autoIncrement: boolean
  readonly default: ColumnDefaultValue | undefined
}

/*
 * 声明合并要求泛型参数列表与上游类声明完全一致，因此 TNullity / TCustomized
 * 虽未在接口体内使用，也必须保留。
 */
/*
 * 声明合并要求泛型参数列表与上游类声明完全一致，因此 TNullity / TCustomized
 * 虽未在接口体内使用，也必须保留；而增强 `spi` 命名空间下的成员，也只能用
 * namespace + interface 合并的写法。
 */
/* eslint-disable @typescript-eslint/no-namespace, @typescript-eslint/no-unused-vars */
declare module '@ts-grm/core' {
  interface __ScalarProp<
    T,
    TNullity extends __NullityType = 'NONNULL',
    TCustomized extends boolean = false,
  > {
    /** 标记该列由数据库生成自增值（自增主键等）。 */
    autoIncrement(): this
    /**
     * 声明该列的默认值。
     *
     * 接受字面量（与列的值类型一致）或上游表达式（如 `dsl.native.date`now()``）。
     */
    default(value: T | ColumnDefaultExpression): this
  }

  // 让 `spi.EntityProp` 直接带上补丁的只读属性，消费方无需类型断言。
  namespace spi {
    interface EntityProp {
      readonly autoIncrement: boolean
      readonly default: ColumnDefaultValue | undefined
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace, @typescript-eslint/no-unused-vars */
