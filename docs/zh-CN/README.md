# ts-grm-patches

[English](../../README.md) | 简体中文

为 [ts-grm](https://github.com/babyfish-ct/ts-grm) 补齐**列的 `autoIncrement` 与
`default` 支持**，填平 `ts-grm` 与 `ts-grm-migrate` 之间的需求鸿沟。

## 背景

ts-grm 的列元数据（`ColumnDef`，见 `packages/sql/src/impl/schema_def.ts`）只表达
`name` / `type` / `nullable` / `length` / `precision` / `scale` / `when`，**不表达自增与列默认值**。
由此导致两块能力缺失：

- ts-grm 生成 `create table` 时无法输出自增列（`serial` / `identity` / `auto_increment`）与列默认值。
- ts-grm-migrate 的模型适配器只能把它们写死为 `default: undefined` / `autoIncrement: false`
  （见该仓库的 `src/schema/adapter.ts`），因此迁移无法产出对应的数据库功能。

本包作为 ts-grm 的**扩展补丁**，补齐这部分缺口。

## 能力范围

本包只负责**为 ts-grm 添加能力**：声明入口 + 元数据。

**不负责 SQL 生成** —— 把 `autoIncrement` / `default` 翻译成 `serial` / `identity(1,1)` /
`auto_increment` / `default <...>` 子句，是消费方（例如 ts-grm-migrate）的职责。

## 依赖要求

`@ts-grm/core` 与 `@ts-grm/sql` 是本包的 **peerDependencies**（`>=0.0.13 <0.0.14`），
由宿主项目提供，本包不打包上游实现。

## 用法

```ts
import { dsl, model, prop } from '@ts-grm/core'
import { applyPatches } from 'ts-grm-patches'

// 必须在定义任何 model(...) 之前调用一次，幂等
applyPatches()

const USER = model(
  'User',
  'id',
  class {
    id = prop.i32().autoIncrement()
    status = prop.str(20).default('active')
    createdAt = prop.dt().default(dsl.native.date`now()`)
  },
)
```

两个修饰符都返回**新实例**（与上游 `nullable()` 同构），可自由链式组合，且不会污染原 prop：

```ts
const id = prop.i32().autoIncrement().default(0)
```

### 默认值：字面量或 SQL 表达式

`default` 接受两类取值：受列值类型约束的字面量，或上游表达式节点（`dsl.native.*`，
或任何 ts-grm 表达式），用于调用 SQL 函数：

```ts
prop.str(20).default('active') // 字面量
prop.dt().default(dsl.native.date`now()`) // SQL 函数
prop.str(36).default(dsl.native.str`uuid_generate_v4()`) // SQL 函数
```

补丁只**承载**表达式节点，不渲染任何 SQL。

### 从列元数据读取

```ts
const column: ColumnDef = /* ... */ column.prop?.autoIncrement // boolean
column.prop?.default // 字面量或表达式节点，或 undefined
```

`isColumnDefaultExpression(value)` 用于区分表达式节点与字面量。它按 ts-grm 的节点标记
`__type().expressionLike` 判别，而不是 `instanceof`，因此在同一进程同时加载 ESM 与 CJS
两份 `@ts-grm/core` 时依然有效。

### autoIncrement 的两个来源

1. **列级显式声明** —— `prop.i32().autoIncrement()`，当前 `@ts-grm/core@0.0.13` 下唯一可用的方式。
2. **上游 ID 生成策略（向前兼容）** —— 宿主版本若提供该能力，`ctx.table(...).id("IDENTITY")`
   的 id 列会被识别为自增。

> 截至 `@ts-grm/core@0.0.13`，上游的 ID 生成策略尚未发布：其类型声明里不存在
> `IDENTITY` / `idGenerator` / `__RootModelContext`。开发分支中虽有
> `ctx.table(...).id("IDENTITY")`（存入 `Entity.idGenerator`），但运行时只有一处判空
> 消费点，没有任何 `=== "IDENTITY"` 分支，`sql` 包的 DDL 层也未接入 —— 即"能声明、不能生效"。
> 因此补丁以列级声明为主，并保留上述向前兼容分支。

## 全局过滤器

`installGlobalFilters(client)` 让一个已创建的 client 对所有模型生效，无需逐个登记：

```ts
import { installGlobalFilters } from 'ts-grm-patches'
import type { NumExpression } from '@ts-grm/core'
import { newSqlClient, PostgresDriver } from '@ts-grm/sql'

const client = newSqlClient(new PostgresDriver(pool), { entityManager })

const globalFilters = installGlobalFilters(client)
// 只在真正拥有该列的模型上生效，其余模型自动跳过
// （需要完全自控时用 addGlobal() 并自己判断列是否存在）
globalFilters.addGlobalFor<NumExpression<number>>('tenantId', (t) => t.eq(currentTenantId))
```

- 上游的 `FilterManager.add(model, filter)` 绑定单个模型；全局过滤器**不需要枚举模型** ——
  任何实体（包括你从未注册过的模型）都会拿到它们。
- 全局过滤器排在上游的模型级过滤器**之前**，全部过滤器在上游以 `AND` 组合，
  `add(model, filter)` 的用法不受影响。
- **并非每个模型都有你过滤的那个列。** 上游的 table 类是按实体的声明属性逐个生成的，
  缺少该列的模型上属性是 `undefined`，直接 `table.someColumn.eq(...)` 会抛 `TypeError`
  并打断整个查询。请优先用 `addGlobalFor(column, build)`（缺少该列的模型自动跳过），
  或自行判断：`(table) => table.tenantId?.eq(id)`。
- `addGlobalFor` 还会在**查找阶段**筛选：缺少该列的实体拿到的是空列表。这不只是正确性问题
  —— 上游据 `getFilters(entity).length === 0` 判断关联能否直接读取外键
  （`association_resolver.ts`），非空列表会退化为 join，对可空关联可能改变结果集。
  自由形式的 `addGlobal()` 无法预知适用性，因此对每个实体都返回非空，会放弃该优化。
- 对同一个 client 重复安装是幂等的。`newSqlClient(client, options)` 会**新建实例**、
  不继承包装 —— 需要调用 `installGlobalFilters(derived, manager)` 让多个 client 共享同一个管理器。
- `manager.unknownColumns(models)` 列出给定模型中都不存在的列名，用于发现拼写错误
  （否则该过滤器会在所有模型上静默失效）。
- 过滤器内部可通过 `table.__entity` 拿到当前的 `spi.Entity`，因此可以把全局过滤器限定到
  或排除掉特定模型。
- 过滤器的类型参数是 `AnyModel`，因此其中的字段访问**不受编译期校验**：写错字段名要到
  生成查询时才暴露，而不是写代码时。
- 注册后**立即生效** —— 不同于上游的 `filterManager` 选项（客户端构造时会被快照）。
- 构建在上游公开接口 `SqlClientImplementor.getFilters(entity)` 之上；若 client 未暴露它，
  `installGlobalFilters` 会直接报错，而不是静默失效。

## 数据流

补丁不 hook 上游的 schema 构建流程，而是利用既有的数据通路：

```
prop.i32().autoIncrement()          // 新增字段写入 __PropData
  → EntityProp(this, name, __data)  // core 构建模型时原样传递（entity.ts）
    → ColumnDef.prop                // schema_creator 持有该 EntityProp
```

`applyPatches()` 只做两件事：

1. 给 `__ScalarProp` 安装 `autoIncrement()` / `default(value)`
2. 给 `spi.EntityProp` 安装 `autoIncrement` / `default` 只读读取器

若上游将来原生提供同名成员，补丁会自动让位（不覆盖）。

## API

- `applyPatches(): void` —— 安装补丁。幂等；必须在任何 `model(...)` 定义之前调用。
- `isColumnDefaultExpression(value: unknown): value is ColumnDefaultExpression` ——
  默认值是 SQL 表达式节点而非字面量时返回 `true`。
- `ColumnDefaultLiteral` —— `string | number | boolean | bigint | Date`。
- `ColumnDefaultExpression` —— 上游表达式节点（`ExpressionLike`）。
- `ColumnDefaultValue` —— `ColumnDefaultLiteral | ColumnDefaultExpression`。
- `ColumnPatchData` —— 补丁附加在 `__PropData` 上的字段。
- `PatchedEntityProp` —— `spi.EntityProp & { autoIncrement: boolean; default: ColumnDefaultValue | undefined }`。
- `installGlobalFilters(client): GlobalFilterManager` —— 让一个已创建的 client 对所有模型生效。
- `GlobalFilterManager` —— `addGlobal(filter)`（对所有模型生效）、
  `addGlobalFor(column, build)`（缺少该列的模型自动跳过）、`unknownColumns(models)`
  与 `globalFilters`。
- `GlobalFilter` —— 上游的 `AnyFilter`。

### 迁移引擎侧的消费方式

```ts
const d = columnDef.prop?.default
if (isColumnDefaultExpression(d)) {
  // d 是表达式节点（如 dsl.native.* 产出），带 `parts`
  // 渲染它并产出 `default <sql>`
} else if (d !== undefined) {
  // 字面量：转义后产出 `default '<...>'`
}
```

## 已知限制

- 必须在定义任何 `model(...)` **之前**调用 `applyPatches()`。
- 补丁作用于 `@ts-grm/core` 的类原型；若同一进程加载了 ESM 与 CJS 两份上游副本，
  补丁只作用于其中一份。上面的表达式判别函数已避开这个坑。
- `installGlobalFilters()` 依赖 `SqlClientImplementor` 的 `getFilters` 成员（见「全局过滤器」）。
  该成员属于上游公开接口，在上游移除或改名属于破坏性变更。

## 开发

```bash
pnpm install        # 安装依赖
pnpm dev            # 监听模式构建
pnpm typecheck      # 类型检查 (tsc --noEmit)
pnpm lint           # ESLint
pnpm format         # Prettier 格式化
pnpm test           # 运行测试（含端到端：真实 model → createSchema() → 列元数据）
pnpm coverage       # 测试覆盖率
pnpm build          # 构建到 dist/ (ESM + CJS + d.ts)
```

包以双格式发布：ESM (`dist/index.js`) 与 CJS (`dist/index.cjs`)，类型声明通过
`exports` 字段分别提供 `dist/index.d.ts` / `dist/index.d.cts`。

发布与发布前验证由维护者在本地执行，本仓库不提供 CI 与 `prepublishOnly` 钩子。

## 许可

本项目原创代码使用 [MIT](../../LICENSE)。上游 `ts-grm` 使用 Apache-2.0，归属与许可全文见
[third-party notices](../../THIRD_PARTY_NOTICES.md) 与
[LICENSES/Apache-2.0.txt](../../LICENSES/Apache-2.0.txt)。
