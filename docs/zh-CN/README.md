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

`createGlobalFilterManager(models)` 返回一个**上游原生 `FilterManager`**，它把过滤器注册到
清单里的每个模型上，直接交给 `newSqlClient`：

```ts
import { createGlobalFilterManager } from 'ts-grm-patches'
import type { NumExpression } from '@ts-grm/core'
import { newSqlClient, PostgresDriver } from '@ts-grm/sql'

const globalFilters = createGlobalFilterManager([ORDER, CUSTOMER])
// 只注册到真正拥有该列的模型上
globalFilters.addGlobalFor<NumExpression<number>>('tenantId', (t) => t.eq(currentTenantId))

const client = newSqlClient(new PostgresDriver(pool), {
  entityManager,
  filterManager: globalFilters,
})
```

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
- 按列过滤请优先用 `addGlobalFor(column, build)`（缺少该列的模型根本不会注册，也不会抛错），
  而不是自行写 `table.someColumn.eq(...)` —— 后者在缺列模型上会抛 `TypeError`。
- `manager.unknownColumns(models)` 列出给定模型中都不存在的列名；继承来的列算存在，
  与适用性判断的规则一致。用于发现拼写错误（否则该过滤器会在所有模型上静默失效）。
- 过滤器内部可通过 `table.__entity` 拿到当前的 `spi.Entity`，因此可以把全局过滤器限定到
  或排除掉特定模型。

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
- `ColumnDefaultValue` —— 字面量、表达式，或列类型可能承载的其他值
  （`prop.enumSet` 的数组、`prop.json` 的对象、自定义标量）。
- `ColumnPatchData` —— 补丁附加在 `__PropData` 上的字段。
- `PatchedEntityProp` —— `spi.EntityProp & { autoIncrement: boolean; default: ColumnDefaultValue | undefined }`。
- `createGlobalFilterManager(models): GlobalFilterManager` —— 一个已把清单中模型注册好的
  原生 `FilterManager`。
- `GlobalFilterManager` —— 上游 `FilterManager` 加上 `addGlobal(filter)`（清单中所有模型）、
  `addGlobalFor(column, build)`（仅拥有该列的模型）、`unknownColumns(models)` 与 `globalFilters`。
- `GlobalFilter` —— 上游的 `AnyFilter`。

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

- 必须在定义任何 `model(...)` **之前**调用 `applyPatches()`。
- 补丁作用于 `@ts-grm/core` 的类原型；若同一进程加载了 ESM 与 CJS 两份上游副本，
  补丁只作用于其中一份。上面的表达式判别函数已避开这个坑。
- `createGlobalFilterManager()` 需要先提供模型清单；与上游一致，过滤器在客户端构造时被快照
  （见「全局过滤器」）。

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
