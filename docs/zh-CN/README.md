# ts-grm-patches

[English](../../README.md) | 简体中文

为 [ts-grm](https://github.com/babyfish-ct/ts-grm) 补齐**列的 `autoIncrement` 与
`default` 支持**，填平 `ts-grm` 与 `ts-grm-migrate` 之间的需求鸿沟。此外还提供全局过滤器，
并绕过了部分上游尚未修复的 issue（见[上游 issue](#上游-issue)）。

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

## 上游 issue

ts-grm 中部分尚未修复的 issue 可以从外部绕过。每一处绕过都先交给上游处理，上游修复后
补丁自动让位，使用方无需改代码。

| Issue                                                                                            | 本包中的状态                                                                      |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| [#9](https://github.com/babyfish-ct/ts-grm/issues/9) `prop.bool()` 列无法用于 `where` / `select` | 已解决，`prop.text()` 列同样适用，见[布尔与文本列参与查询](#布尔与文本列参与查询) |

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

`@ts-grm/core` 0.0.13 的 `createTableProp` 只为数值、`STR`、`DATETIME` 列建立属性表达式，
`prop.bool()` / `prop.text()` 列一旦用在 `where` / `orderBy` / `select` 里，就会抛出
`ArgumentError: Cannot create table prop … whose scalar type is BOOL/TEXT`。

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
> **上游问题：读取可空布尔列中的 `NULL` 会得到 `true`。**
> `@ts-grm/sql` 0.0.13 在判断 `NULL` 之前就转换了 `BOOL` 值，因此可空布尔列中存储的 `NULL`
> 会被读成 `true`，且不报错。问题出在上游内部的行读取器，本包无法触及；无论是否使用本包，
> `prop.bool().nullable()` 都会受影响。过滤不受影响（`where(a.pinned.isNull())` 正常），
> 只有读回值时出错。在上游修复之前，建议使用带默认值的非空布尔列，例如 `bool().default(false)`。

## 数据流

补丁不 hook 上游的 schema 构建流程，而是利用既有的数据通路：

```
prop.i32().autoIncrement()          // 新增字段写入 __PropData
  → EntityProp(this, name, __data)  // core 构建模型时原样传递（entity.ts）
    → ColumnDef.prop                // schema_creator 持有该 EntityProp
```

`applyPatches()` 做三件事：

1. 给 `__ScalarProp` 安装 `autoIncrement()` / `default(value)`
2. 给 `spi.EntityProp` 安装 `autoIncrement` / `default` 只读读取器
3. 包装 `spi.Entity.prototype.tableClass`，让 `BOOL` / `TEXT` 列可以参与查询

若上游将来原生提供同名成员，或开始支持这两类列参与查询，补丁会自动让位（不覆盖）。

## API

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
  模块，并最先导入它。
- 类型增强（prop 上的 `autoIncrement()` / `default()`）只要加载了本包的类型就可见，
  即使只是 `import type`；运行时方法则只在调用 `applyPatches()` 之后才存在。
- 补丁作用于 `@ts-grm/core` 的类原型；若同一进程加载了 ESM 与 CJS 两份上游副本，
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
