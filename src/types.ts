import type { __NullityType, spi } from '@ts-grm/core'

/**
 * 列的默认值。
 *
 * 这里只承载"值"本身，不承载任何 SQL 语法 —— 生成 `default` 子句是消费方
 * （例如 ts-grm-migrate）的职责。
 */
export type ColumnDefaultValue = string | number | boolean | bigint

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
/* eslint-disable @typescript-eslint/no-unused-vars */
declare module '@ts-grm/core' {
  interface __ScalarProp<
    T,
    TNullity extends __NullityType = 'NONNULL',
    TCustomized extends boolean = false,
  > {
    /** 标记该列由数据库生成自增值（自增主键等）。 */
    autoIncrement(): this
    /** 声明该列的默认值。 */
    default(value: T): this
  }
}
/* eslint-enable @typescript-eslint/no-unused-vars */
