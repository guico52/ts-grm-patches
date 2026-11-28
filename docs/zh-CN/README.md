# ts-grm-patches

[English](../../README.md) | 简体中文

为 [ts-grm](https://github.com/babyfish-ct/ts-grm) 提供**可选增强层**：方言绑定 client、链式查询函数、自动分组、全局过滤器和列元数据，同时保留针对上游问题的修复。

## 定位与能力

本包起步于 ts-grm-migrate 需要的列元数据补丁，现在也覆盖查询体验和数据库函数支持。ts-grm 继续负责模型、AST、SQL 渲染、参数绑定、执行器、连接池和事务；本包通过显式创建/增强 client、安装元数据修饰符接入这些原生能力。

| 能力                                                     | 入口                                   | 详细文档                                                           |
| -------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| 创建时绑定数据库、匹配的方言函数命名空间、派生时保留类型 | `newSqlClient` 与五个方言子路径        | [方言绑定 client](./dialect-clients.md)                            |
| 原位表达式链式扩展 + 上游 DSL/表达式方法的函数形式       | 原生表达式、`client.fn`、`q.fn`        | [查询函数](./query-functions.md)                                   |
| 五库数学/字符串函数适配、去重计数、专有函数和 UDF 声明   | 通用函数和匹配的方言命名空间           | [函数支持](./query-functions.md#通用函数的方言实现)                |
| 识别聚合依赖，以完整标量表达式推导分组键                 | 显式 `q.autoGroupBy()`                 | [自动分组与限制](./query-functions.md)                             |
| 按模型集合或匹配列注册过滤器                             | `createGlobalFilterManager`            | [全局过滤器](#全局过滤器)                                          |
| 自增/默认值元数据及 BOOL/TEXT 查询修复                   | `applyPatches`、`bool`、`nullableBool` | [列元数据](#列元数据与迁移集成)、[查询修复](#布尔与文本列参与查询) |

从[增强包接入指南](./enhancement-guide.md)开始，根据需要启用能力。列元数据由 ts-grm-migrate 等消费方读取，并由它们负责生成相应 DDL。

## 依赖与发布状态

- Node.js **>=20**（有一个与上游版本相关的限制，见下）。
- 宿主项目提供 `@ts-grm/core` 和 `@ts-grm/sql`，支持范围为 **`>=0.0.13`**（不设上限；已实测验证 `0.0.13` 与 `0.0.14`）；本包不打包上游实现。不设上限是为了避免上游发布新的次版本后安装时产生 peer 冲突；唯一与具体上游版本绑定的修复见「已知限制」中的 coalesce 说明。
- 当前发布版本为 **`0.4.1`**，详见[版本记录](../../CHANGELOG.md#041---2026-11-27)（包含破坏性变更：移除 `select().where()`，统一回原生 `q.where(...).autoGroupBy().select(...)` 语法）。`0.3.1` 因逐实例包装与原生 API 割裂严重且性能损耗大，已被作者从 npm 撤回。

> [!IMPORTANT]
> **上游 `0.0.13` 需要 Node >=24。** 它发布的产物里 `using` 声明（显式资源管理）没有转译，在 Node 20/22 上会在 `import` 阶段直接抛 `SyntaxError: Unexpected identifier '_'`，此时本包的任何代码都还没执行。`0.0.14` 已转译该语法，Node 18+ 可用。若必须停留在 Node 20/22，请把 `@ts-grm/core` 与 `@ts-grm/sql` 固定到 `>=0.0.14`。CI 矩阵据此设计：`0.0.13` 只在 Node 24 上测试。

```bash
pnpm add ts-grm-patches@0.4.1 @ts-grm/core@0.0.14 @ts-grm/sql@0.0.14
```

查询增强通过创建或增强 client 启用。列修饰符和 BOOL/TEXT 修复由 `applyPatches()` 单独安装，并须早于模型定义。仅导入包不会自动安装这些运行时补丁。全局过滤器也可以独立交给原生 client 使用。

## 查询增强快速开始

以下示例沿用项目已有的 pool、entityManager 和 ORDER 模型：

```ts
import { PostgresDriver } from '@ts-grm/sql'
import { newSqlClient } from 'ts-grm-patches/postgres'

const db = newSqlClient(new PostgresDriver(pool), { entityManager })

const rows = await db
  .createQuery(ORDER, (q, t) =>
    q
      .where(t.amount.gt(0))
      .autoGroupBy()
      .select({
        category: t.category.lower().trim(),
        total: t.amount.sum().abs().round(2).coalesce(0),
        count: q.fn.count(),
      }),
  )
  .fetchList()

// db.dialect 的类型是 'postgres'；专有函数入口是 db.fn.postgres。
```

`q.autoGroupBy()` 作为原生 `q.groupBy(...)` 的同位替代，对完整的 category 标量表达式分组，不把聚合输入列加入分组键。函数结果继续链式嵌套，client.fn 也支持在根查询外构建增强的 BaseQuery 和子查询。

已有 PostgreSQL client 可使用 ts-grm-patches/postgres 的 enhanceClient 做运行时检查和实例增强。根入口 newSqlClient 可以从具体 driver 推导数据库类别；绑定贯穿派生、投影与嵌套查询，只暴露匹配的方言命名空间。

通用函数包含 abs/sign/ceil/floor/round/trunc/power/sqrt/exp/ln/log10、charLength/octetLength、countDistinct，并适配字符串截取、查找、补齐、trim。方言命名空间覆盖部分 JSON、数组、全文检索和日期函数，call 提供普通函数/UDF 的显式契约。完整列表及能力门槛见[查询函数文档](./query-functions.md)。

SQLite 可选数学函数与 octetLength 需要相应版本/能力声明。精度、NULL、Unicode 等保留已说明的厂商边界；此增强层没有修复上游聚合计数。查询增强有可测量的 CPU 开销，详见[优化前后性能报告](./query-performance.md)。五个方言现在都有真实服务端执行验证：SQLite 通过内存 `node:sqlite`，PostgreSQL、MySQL、SQL Server、Oracle 连接真实实例（`test/server/`）。这些测试锁定了渲染字符串看不出来的差异，例如 MySQL/SQL Server 默认排序规则大小写不敏感、Oracle 按字节填充字符串，详见「已知限制」。

## 上游 issue

支持版本中的部分 ts-grm issue 可以从外部绕过。每一处绕过都先交给上游处理，上游修复后
补丁自动让位，使用方无需改代码。

| Issue                                                                                            | 本包中的状态                                                                      |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| [#9](https://github.com/babyfish-ct/ts-grm/issues/9) `prop.bool()` 列无法用于 `where` / `select` | 已解决，`prop.text()` 列同样适用，见[布尔与文本列参与查询](#布尔与文本列参与查询) |

## 列元数据与迁移集成

原有列元数据增强继续服务于 ts-grm-migrate：自增和默认值声明经 EntityProp 传到 ColumnDef.prop。消费方将其翻译成 DDL，安装器负责提供这些元数据。

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

两个修饰符都返回**新实例**（与上游 `nullable()` 同构），且不会污染原 prop：

```ts
// 自增 id：值由数据库生成
const id = prop.i32().autoIncrement()

// 列默认值：未提供值时的取值
const status = prop.str(20).default('active')
```

它们和其他修饰符一样可以链式调用，但这两者通常不该放在一起 —— 自增列的值由数据库生成，
再给它一个字面默认值一般不是你想要的结果。

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
// columnDef 是消费方（例如迁移引擎）拿到的列元数据
columnDef.prop?.autoIncrement // boolean
columnDef.prop?.default // 字面量或表达式节点，或 undefined
```

这两个属性通过声明合并挂在 `spi.EntityProp` 上，无需类型转换即可访问；
需要显式命名类型时可以用导出的 `PatchedEntityProp`。

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

上游 ts-grm 自带的 `FilterManager` 是**按模型**注册的；本包提供的是「让同一个过滤器一次性覆盖
多个模型」的辅助 —— `createGlobalFilterManager(source)` 返回一个**上游原生 `FilterManager`**，
把过滤器注册到目标模型上，直接交给 `newSqlClient`：

```ts
import { createGlobalFilterManager } from 'ts-grm-patches'
import type { NumExpression } from '@ts-grm/core'
import { newSqlClient, PostgresDriver } from '@ts-grm/sql'

// 给一个 EntityManager 就够了，不必手写模型清单
const globalFilters = await createGlobalFilterManager(entityManager)
// 只注册到真正拥有该列的模型上
globalFilters.addGlobalFor<NumExpression<number>>('tenantId', (t) => t.eq(currentTenantId))

const client = newSqlClient(new PostgresDriver(pool), {
  entityManager,
  filterManager: globalFilters,
})
```

它之所以是异步的，是因为模型取自 `EntityManager.entities()` —— 上游自己的枚举已经涵盖
继承链 —— 再通过公开的 `Entity.model` 取回。也仍然接受模型数组。

- 它**就是** `FilterManager`：无包装、无私有成员、无补丁。上游的 `merge()` 只对构造器恰好
  是 `FilterManager`（或 `EntityManager`）的选项值原样放行 —— 继承它，或传入其他对象，
  都会被浅拷贝而**丢失原型**。
- 全部过滤器在上游以 `AND` 组合，顺序就是**注册顺序**：`add(model, filter)` 注册的
  与全局过滤器按各自注册的先后交错，没有「全局过滤器优先」这回事。
- `newSqlClient(client, options)` 派生的客户端会**自动继承**该管理器（实例在 `options` 里传递）。
- `addGlobalFor` 还会在**查找阶段**筛选：缺少该列的实体拿到的是空列表。这不只是正确性问题
  —— 上游据 `getFilters(entity).length === 0` 判断关联能否直接读取外键
  （`association_resolver.ts`），非空列表会退化为 join，对可空关联可能改变结果集。
  自由形式的 `addGlobal()` 无法预知适用性，因此对清单里的每个模型都会非空，会放弃该优化。
- 上游在客户端构造时对过滤器做一次快照：必须在 `newSqlClient()` 之前注册完毕；
  未列入 `models` 的模型**本身**不会注册过滤器；但若它的某个祖先在清单中且适用，
  它仍会通过上游沿 `superEntity` 链的收集拿到该过滤器。只存在于子模型的列，
  则由该子模型自己注册。
- 模型的来源会影响范围：`EntityManager.combine(...)` 只会给出显式传入的部分（外加其关联），
  而 `EntityManager.of(baseDir, paths)` 枚举的是**进程内所有已注册模型** —— 它的 `paths`
  只负责触发模块加载，因此传 `of(...)` 的管理器会涵盖比那些文件更多的模型。
- 按列过滤请优先用 `addGlobalFor(column, build)`（缺少该列的模型根本不会注册，也不会抛错），
  而不是自行写 `table.someColumn.eq(...)` —— 后者在缺列模型上会抛 `TypeError`。
- `manager.unknownColumns(models)` 列出给定模型中都不存在的列名；继承来的列算存在，
  与适用性判断的规则一致。用于发现拼写错误（否则该过滤器会在所有模型上静默失效）。
- 过滤器内部可通过 `table.__entity` 拿到当前的 `spi.Entity`，因此可以把全局过滤器限定到
  或排除掉特定模型。

## 布尔与文本列参与查询

`@ts-grm/core` `0.0.13` 的 `createTableProp` 只为数值、`STR`、`DATETIME` 列建立属性表达式，
`prop.bool()` / `prop.text()` 列一旦用在 `where` / `orderBy` / `select` 里，就会抛出
`ArgumentError: Cannot create table prop … whose scalar type is BOOL/TEXT`。

在 **`0.0.14`** 中，上游已修复 **`BOOL` 运行时查询**（`createTableProp` 新增 `case "BOOL"`）以及
**可空布尔列读取 `NULL` 返回 `true`** 的问题，本包的运行时 getter 在 `0.0.14` 上会对 `BOOL` 自动让位；
但 **`TEXT` 运行时查询**（`createTableProp` 仍缺 `case "TEXT"`）与 **`BOOL` 类型侧的 `boolean` 分配问题**
在 `0.0.14` 中仍未修复，仍需使用 `applyPatches()` 与 `bool()` / `nullableBool()`。

`applyPatches()` 包装 `spi.Entity.prototype.tableClass`，为这两类列补上属性表达式
（`BOOL` → 可比较表达式，`TEXT` → 完整的字符串表达式，支持 `like` / `lower()` 等）。
**始终先调用上游 getter**，只有它因「不支持该标量类型」抛出 `ArgumentError` 时补丁才接管；
上游支持这两类列之后，补丁自动让位。其他错误（包括其他原因的 `ArgumentError`）照常抛出。

`TEXT` 不需要额外处理：`prop.text()` 在类型上本来就是字符串列。`BOOL` 还有一个类型问题
—— `boolean` 被分配成 `true | false`，`eq` 的参数推导为 `never` —— 所以需要参与查询的布尔列
用 `bool()` 声明：

```ts
import { applyPatches, bool, nullableBool } from 'ts-grm-patches'

applyPatches()

const ARTICLE = model(
  'Article',
  'id',
  class {
    id = prop.i32()
    body = prop.text() // applyPatches() 之后即可查询
    published = bool().default(false) // 代替 prop.bool()
    pinned = nullableBool() // 代替 prop.bool().nullable()
  },
)

client.createQuery(ARTICLE, (q, a) =>
  q.where(a.published.eq(true), a.body.like('ts-grm')).select(a.id),
)
```

`bool()` 在运行时就是 `prop.bool()`，只是在类型上标记为 customized，使列推导为
`Expression<boolean>`。生成的列完全相同，上游修复后改回 `prop.bool()` 不产生迁移。
可空列请用 `nullableBool()`：上游的 `nullable()` 会丢掉这个标记。

> [!WARNING]
> **上游 0.0.13 问题（已在 0.0.14 修复）：读取可空布尔列中的 `NULL` 会得到 `true`。**
> `@ts-grm/sql` `0.0.13` 在判断 `NULL` 之前就转换了 `BOOL` 值，因此可空布尔列中存储的 `NULL`
> 会被读成 `true`，且不报错。上游已在 `@ts-grm/sql` **`0.0.14`** 修复此问题（`DataRowReader` 已增加
> `value != null` 判断）。若仍停留在 `0.0.13`，建议使用带默认值的非空布尔列，例如 `bool().default(false)`。

## 数据流

补丁不 hook 上游的 schema 构建流程，而是利用既有的数据通路：

```
prop.i32().autoIncrement()          // 新增字段写入 __PropData
  → EntityProp(this, name, __data)  // core 构建模型时原样传递（entity.ts）
    → ColumnDef.prop                // schema_creator 持有该 EntityProp
```

`applyPatches()` 还会安装原生表达式方法和字符串渲染修复；原有元数据步骤为：

1. 给 `__ScalarProp` 安装 `autoIncrement()` / `default(value)`
2. 给 `spi.EntityProp` 安装 `autoIncrement` / `default` 只读读取器
3. 包装 `spi.Entity.prototype.tableClass`，让 `BOOL` / `TEXT` 列可以参与查询

若上游将来原生提供同名成员，或开始支持这两类列参与查询，补丁会自动让位（不覆盖）。

## 原位链式增强

`0.4.0` 将新增方法声明合并到 core 原生接口，并一次性安装到 SPI 原型。字段、原生 DSL 结果与 q.fn 共享同一套表达式：

```ts
t.amount.times(t.qty).sum().abs().round(2).coalesce(0)
dsl.sum(t.amount).abs().round(2)
t.name.min().trim()
```

applyPatches 或创建/增强 client 会安装共享方法；原生字符串 AST 保留，方言补齐在 NodeRender 执行。新增中立函数节点在渲染时确定方言。增强 client 保留原生 `select`/`selectDistinct` 投影契约与原生 `SqlClient` 兼容性。限制与迁移见[查询函数](./query-functions.md)。

## API

- `newSqlClient(source, options?, dialectOptions?)` —— 创建增强的原生 client，或从已绑定 client 派生；也提供 `/postgres`、`/mysql`、`/sqlite`、`/sqlserver`、`/oracle` 子路径。
- `enhanceClient(client)` —— 增强已有实例；方言子路径同时检查数据库类别，并保留相应命名空间类型。
- `client.fn` / `q.fn` —— `QueryFunctions`，提供通用函数、语义标记、增强子查询/BaseQuery 与匹配的专有命名空间。
- `q.autoGroupBy()` —— 原生 `q.groupBy(...)` 的显式同位替代，在查询回调结束时依据最终投影推导分组键。
- `getFunctionMetadata(expression)` / `QuerySemanticError` —— 函数元数据读取与显式构建期语义错误。
- `EnhancedSqlClient`、`DialectProfile`、`DialectOptions` —— client、表达式与能力声明的公开类型。
- `applyPatches(): void` —— 安装补丁。幂等；必须在任何 `model(...)` 定义之前调用。
- `isColumnDefaultExpression(value: unknown): value is ColumnDefaultExpression` ——
  默认值是 SQL 表达式节点而非字面量时返回 `true`。
- `ColumnDefaultLiteral` —— `string | number | boolean | bigint | Date`。
- `ColumnDefaultExpression` —— 上游表达式节点（`ExpressionLike`）。
- `ColumnDefaultValue` —— 字面量、表达式，或列类型可能承载的其他值
  （`prop.enumSet` 的数组、`prop.json` 的对象、自定义标量）。
- `ColumnPatchData` —— 补丁附加在 `__PropData` 上的字段。
- `PatchedEntityProp` —— `spi.EntityProp & { autoIncrement: boolean; default: ColumnDefaultValue | undefined }`。
- `createGlobalFilterManager(source: EntityManager | AnyModel[]): Promise<GlobalFilterManager>`
  —— 一个已把目标模型注册好的原生 `FilterManager`。
- `GlobalFilterManager` —— 上游 `FilterManager` 加上 `addGlobal(filter)`（清单中所有模型）、
  `addGlobalFor(column, build)`（仅拥有该列的模型）、`unknownColumns(models)` 与 `globalFilters`。
- `GlobalFilter` —— 上游的 `AnyFilter`。
- `bool(): __ScalarProp<boolean, 'NONNULL', true>` / `nullableBool()` —— 类型上可在查询中比较的
  `prop.bool()`（见「布尔与文本列参与查询」）。

### 迁移引擎侧的消费方式

```ts
import { isColumnDefaultExpression } from 'ts-grm-patches'

const d = columnDef.prop?.default
if (isColumnDefaultExpression(d)) {
  // d 是表达式节点（如 dsl.native.* 产出），带 `parts`
  // 渲染它并产出 `default <sql>`
} else if (d !== undefined) {
  // 字面量：转义后产出 `default '<...>'`
}
```

## 已知限制

- 必须在定义任何 `model(...)` **之前**调用 `applyPatches()`。ES 模块的 `import` 先于本模块的
  函数体求值，若 `main.ts` 同时导入了模型模块，在其顶部调用就已经晚了。请把调用放进一个单独的
  模块（例如 `src/patches.ts`），并在入口首行导入它；测试框架按文件隔离 worker 时，可将其配进 `setupFiles`。
- 类型增强（`prop` 上的 `autoIncrement()` / `default()` 以及原生表达式上的链式方法）只要所在
  `tsconfig.json` 涵盖的任意文件加载了本包类型即全局可见（单包项目只需入口 `src/patches.ts` 导入一次，
  其他文件无需重复导入）；若 Monorepo 独立子包或独立 `tsconfig` 未包含该入口，可在子包内添加仅含
  `import 'ts-grm-patches'` 的 `.d.ts` 文件。运行时方法仍需在调用 `applyPatches()`（或创建/增强 client）后才存在。
- 元数据/BOOL/TEXT 安装器作用于 `@ts-grm/core` 的类原型；若同一进程加载了 ESM 与 CJS 两份上游副本，
  补丁只作用于其中一份。上面的表达式判别函数已避开这个坑。
- 布尔 / 文本查询补丁只覆盖实体上直接声明的标量属性；嵌入字段内的属性与中间（关联）实体上的
  属性不在范围内。
- `createGlobalFilterManager()` 是异步的（模型取自 `EntityManager`）；与上游一致，过滤器在
  客户端构造时被快照（见「全局过滤器」）。

## 开发

```bash
pnpm install        # 安装依赖
pnpm dev            # 监听模式构建
pnpm typecheck      # 类型检查 (tsc --noEmit)
pnpm lint           # ESLint
pnpm format         # Prettier 格式化
pnpm test           # 运行测试（含端到端：真实 model → createSchema() → 列元数据）
pnpm test:exports   # 验证 ESM/CJS 的方言入口、绑定与元数据共享
pnpm bench:query    # 独立进程的查询构建/渲染性能对比
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
