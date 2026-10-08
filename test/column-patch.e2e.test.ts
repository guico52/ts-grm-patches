import { EntityManager, model, prop } from '@ts-grm/core'
import { newSqlClient, PostgresDriver } from '@ts-grm/sql'
import { describe, expect, it } from 'vitest'

import { applyPatches } from '../src/index'

interface ColumnLike {
  readonly name: string
  readonly prop?: {
    readonly autoIncrement: boolean
    readonly default: unknown
  }
}

interface TableDefLike {
  readonly name: string
  readonly columns: ReadonlyArray<ColumnLike>
}

/** ts-grm 的命名策略会给标识符加上引号，比较时去掉。 */
function bare(identifier: string): string {
  return identifier.replaceAll('"', '')
}

applyPatches()

// 注意：ts-grm 把 model 注册进全局表，同名 model 只能定义一次，
// 因此模型定义放在模块作用域（每个测试文件只加载一次）。
const USER = model(
  'User',
  'id',
  class {
    id = prop.i32().autoIncrement()
    name = prop.str(50)
    status = prop.str(20).default('active')
  },
)

const POST = model(
  'Post',
  'id',
  class {
    id = prop.i64()
    title = prop.str(100).default('untitled')
  },
)

let tableDefsPromise: Promise<ReadonlyArray<TableDefLike>> | undefined

/**
 * 端到端：真实 model 定义 → createSchema() → 列元数据。
 *
 * 不连接任何数据库：`createSchema()` 只做元数据计算，因此可以传入未真正使用的
 * driver（与 ts-grm-migrate 的做法一致）。
 */
function tableDefs(): Promise<ReadonlyArray<TableDefLike>> {
  tableDefsPromise ??= (async () => {
    const entityManager = EntityManager.combine(USER as never, POST as never)
    const client = newSqlClient(new PostgresDriver({} as never), { entityManager })
    const schema = (await client.createSchema()) as unknown as {
      readonly tableDefs?: ReadonlyArray<TableDefLike>
    }

    const defs = schema.tableDefs
    if (defs == null) {
      throw new Error('createSchema() did not expose tableDefs')
    }
    return defs
  })()
  return tableDefsPromise
}

function columnOf(defs: ReadonlyArray<TableDefLike>, table: string, column: string): ColumnLike {
  const foundTable = defs.find((t) => bare(t.name).toUpperCase() === table.toUpperCase())
  if (foundTable == null) {
    throw new Error(`table "${table}" not found in schema`)
  }
  const foundColumn = foundTable.columns.find(
    (c) => bare(c.name).toUpperCase() === column.toUpperCase(),
  )
  if (foundColumn == null) {
    throw new Error(`column "${column}" not found in table "${table}"`)
  }
  return foundColumn
}

describe('column patches end to end', () => {
  it('把 autoIncrement / default 一路带到列元数据', async () => {
    const defs = await tableDefs()

    expect(columnOf(defs, 'USER', 'ID').prop?.autoIncrement).toBe(true)
    expect(columnOf(defs, 'USER', 'STATUS').prop?.default).toBe('active')
    expect(columnOf(defs, 'POST', 'TITLE').prop?.default).toBe('untitled')
  })

  it('未声明的列保持非自增、无默认值', async () => {
    const defs = await tableDefs()

    expect(columnOf(defs, 'USER', 'NAME').prop?.autoIncrement).toBe(false)
    expect(columnOf(defs, 'USER', 'NAME').prop?.default).toBeUndefined()
    expect(columnOf(defs, 'POST', 'ID').prop?.autoIncrement).toBe(false)
    expect(columnOf(defs, 'POST', 'ID').prop?.default).toBeUndefined()
  })
})
