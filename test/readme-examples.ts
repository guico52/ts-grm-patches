/**
 * README 中示例的可编译验证。
 *
 * 这个文件不参与运行时测试（vitest 只收集 `*.test.ts`），但会参与 `tsc --noEmit`，
 * 因此文档里的写法一旦与类型不符就会在这里暴露。
 */
import { dsl, model, prop } from '@ts-grm/core'
import type { NumExpression } from '@ts-grm/core'
import { newSqlClient, PostgresDriver } from '@ts-grm/sql'

import { applyPatches, createGlobalFilterManager, isColumnDefaultExpression } from '../src/index'

applyPatches()

// —— Usage ——
const USER = model(
  'DocUser',
  'id',
  class {
    id = prop.i32().autoIncrement()
    status = prop.str(20).default('active')
    createdAt = prop.dt().default(dsl.native.date`now()`)
  },
)
void USER

// 链式组合，且不污染原 prop
const chained = prop.i32().autoIncrement().default(0)
void chained

// —— Defaults: literals or SQL expressions ——
const asLiteral = prop.str(20).default('active')
const asDateExpr = prop.dt().default(dsl.native.date`now()`)
const asStrExpr = prop.str(36).default(dsl.native.str`uuid_generate_v4()`)
void [asLiteral, asDateExpr, asStrExpr]

// —— Reading from column metadata ——
// 消费方拿到的是列元数据（例如迁移引擎里的 ColumnDef）；这里用结构等价的最小声明验证写法
declare const columnDef: {
  readonly prop?: { readonly autoIncrement: boolean; readonly default: unknown }
}
const autoIncrement: boolean = columnDef.prop?.autoIncrement ?? false
const defaultValue: unknown = columnDef.prop?.default
void [autoIncrement, defaultValue]

// —— Global filters ——
const ORDER = model(
  'DocOrder',
  'id',
  class {
    id = prop.i32()
    tenantId = prop.i32()
  },
)
const CUSTOMER = model(
  'DocCustomer',
  'id',
  class {
    id = prop.i32()
  },
)
declare const currentTenantId: number
declare const pool: never
declare const entityManager: never

const globalFilters = createGlobalFilterManager([ORDER, CUSTOMER])
globalFilters.addGlobalFor<NumExpression<number>>('tenantId', (t) => t.eq(currentTenantId))

const client = newSqlClient(new PostgresDriver(pool), {
  entityManager,
  filterManager: globalFilters,
})
void client

// —— Consuming from a migration engine ——
const d = defaultValue
if (isColumnDefaultExpression(d)) {
  const parts = (d as { readonly parts?: unknown }).parts
  void parts
} else if (d !== undefined) {
  void d
}
