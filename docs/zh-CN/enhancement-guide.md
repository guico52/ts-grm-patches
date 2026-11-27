# 增强包接入指南

ts-grm-patches 是 ts-grm 的可选增强层。它起步于自增和默认值元数据补丁，现在也提供原位表达式链式扩展、查询函数、方言绑定、自动分组、全局过滤器和针对上游问题的修复。

ts-grm 提供模型、AST、参数绑定、SQL 渲染、执行器、连接池与事务；本包沿这些原生入口增强使用体验和函数支持范围。

## 版本与获取方式

当前支持 Node.js >=20，以及 @ts-grm/core、@ts-grm/sql 的 >=0.0.13 <0.0.15 范围（已实测验证 0.0.13 与 0.0.14）。

当前发布版本为 **`0.4.1`**，详见 [CHANGELOG](../../CHANGELOG.md#041---2026-11-27)（包含破坏性变更：移除 `select().where()`，统一回原生 `q.where(...).autoGroupBy().select(...)` 语法）。旧版 `0.3.1` 已被作者从 npm 撤回，请直接安装 **`0.4.1`** 及匹配的原生依赖：

```bash
pnpm add ts-grm-patches@0.4.1 @ts-grm/core@0.0.14 @ts-grm/sql@0.0.14
```

需要从源码开发或调试时，也可以构建本地仓库：

```bash
# 在 ts-grm-patches 仓库中执行
pnpm install
pnpm build
```

假设应用目录与本仓库同级，再在应用中安装本地构建和匹配的原生依赖：

```bash
pnpm add ../ts-grm-patches @ts-grm/core@0.0.13 @ts-grm/sql@0.0.13
```

## 选择启用入口

| 需要的能力                            | 启用方式                                  | 时机                    |
| ------------------------------------- | ----------------------------------------- | ----------------------- |
| 新建具有查询增强的 client             | 本包 newSqlClient，或对应方言子路径       | 配置 driver/options 时  |
| 增强已有 client                       | enhanceClient；明确数据库时使用方言子路径 | 建立原生 client 后      |
| 自增/默认值修饰符、BOOL/TEXT 查询修复 | applyPatches                              | 模型模块执行前          |
| 按集合/列注册全局过滤器               | createGlobalFilterManager                 | client 创建前注册过滤器 |

仅需要查询增强时，创建/增强 client 即可。applyPatches 同时安装元数据、查询属性及共享表达式原型/字符串渲染增强；仅导入包不会自动执行它。过滤器的注册也可以独立用于原生 client。

## 创建时绑定数据库

项目已有连接池和 EntityManager 时，将工厂导入改为增强入口，driver 仍使用原生类：

```ts
import { PostgresDriver } from '@ts-grm/sql'
import { newSqlClient } from 'ts-grm-patches/postgres'

const db = newSqlClient(new PostgresDriver(pool), { entityManager })
db.dialect // 'postgres'
```

五个子路径为 postgres、mysql、sqlite、sqlserver、oracle。根入口也可以根据具体 driver 推导数据库类别。方言类型贯穿 client.fn、q.fn、投影、BaseQuery 和子查询；专有命名空间只暴露匹配的一种。

已有 PostgreSQL client 可直接检查并增强：

```ts
import { enhanceClient } from 'ts-grm-patches/postgres'

const db = enhanceClient(existingNativeClient)
```

错误数据库类别会报告 DIALECT_MISMATCH。根入口 enhanceClient 接受类型已擦除的原生 SqlClient 时，静态类型只提供公共函数；需要具体方言类型时使用对应子路径。

派生时使用本包工厂保留绑定：

```ts
const child = newSqlClient(db, { defaultBatchSize: 64 })
```

这会创建新的原生 client，继承原生工厂应保留的 driver/options 和方言声明。详见[client 绑定、派生与 capability](./dialect-clients.md)。

## 查询函数与自动分组

以下使用项目已有的 ORDER 模型，其 category 是字符串列、amount 是数值列：

```ts
const rows = await db
  .createQuery(ORDER, (q, t) => {
    const category = t.category.lower().trim()
    return q
      .where(t.amount.gt(0))
      .autoGroupBy()
      .orderBy(category)
      .select({
        category,
        total: t.amount.sum().abs().round(2).coalesce(0),
        distinctAmounts: t.amount.countDistinct(),
      })
  })
  .fetchList()
```

SQL 先按 where 过滤行，对完整的 trim(lower(category)) 表达式分组，聚合输入 amount 不会成为分组键。SQL 函数可继续嵌套；sum 的外层 abs/round/coalesce 不会丢失内部聚合依赖。

查询保持原生 `q.where(...).autoGroupBy().having(...).orderBy(...).select(...)` 顺序，`select`/`selectDistinct` 直接返回原生投影对象，fetchList 等原生根查询操作继续由 ts-grm 负责。

## 函数范围与自动分组边界

- q.fn 提供当前支持的原生 DSL 和表达式方法的函数形式，client.fn 支持在查询回调外构造表达式、BaseQuery 和子查询。
- 通用函数包含五库数学/字符串适配及 countDistinct；匹配的方言命名空间提供部分 JSON、数组、全文和日期函数。普通 UDF 通过 call 声明返回类型与 scalar/aggregate 语义。
- autoGroupBy 是显式功能，以完整标量表达式推导键，识别聚合依赖和非法同阶段嵌套。原始 native SQL 需要通过 scalar/aggregate 显式声明语义，补丁不解析 SQL 文本猜测函数。
- 参数化分组键、子查询参与自动推导、HAVING 和排序的组合等有明确阶段限制，需要时通过 BaseQuery 分层。上游 native/嵌套聚合的 fetchCount/fetchPage 问题仍需按原生边界处理。
- 数值精度、NULL、空字符串、Unicode 和日期等保留厂商边界。SQLite 可选数学函数、octetLength 等还需要显式版本/capability 声明；声明不安装扩展或探测服务端。

完整函数表、标记规则和错误边界见[查询函数与自动分组](./query-functions.md)。SQLite 有真实执行验证，其他四库目前验证真实 renderer 和绑定参数；不能据此承诺所有函数在五个服务端完全等价。

## 原有元数据和过滤器

列修饰符、BOOL/TEXT 支持及原生表达式链式方法由 `applyPatches()` 一次性安装（幂等）。在 ESM 中，将安装放在独立模块并早于模型模块导入：

```ts
// infra/patches.ts
import { applyPatches } from 'ts-grm-patches'
applyPatches()
```

```ts
// application entry
import './infra/patches'
import './models'
```

在标准单包项目中，只需这样在入口执行一次：

- **运行时**：整个进程内所有后续加载的模型、查询与表达式都会生效；若使用 Vitest/Jest 等按文件隔离 worker 的测试框架，把 `./infra/patches` 配置进 `setupFiles` 即可，无需在每个测试文件中重复调用。
- **IDE 与类型检查**：只要 `infra/patches.ts` 位于 `tsconfig.json` 的 `include` 范围内，TypeScript 会加载本包对 `@ts-grm/core` 的全局模块增强，项目内其他模型与查询文件无需再次导入 `ts-grm-patches` 即可获得 `autoIncrement()`、`default()` 以及原生表达式链式方法的类型补全。
- **Monorepo 子包或独立 `tsconfig`**：若某个独立子包（如 `packages/models`）或 `tsconfig.test.json` 的编译范围未包含 `infra/patches.ts`，在该子包下增加一个仅用于类型加载的声明文件（例如 `src/ts-grm.d.ts`，写入一行 `import 'ts-grm-patches'`）即可让 IDE 和 `tsc` 识别所有类型增强，且不产生运行时代码。

安装器保留 autoIncrement/default 元数据；迁移引擎负责消费和渲染。createGlobalFilterManager 则返回原生 FilterManager，按模型集合或匹配列注册过滤器。详见[元数据](./README.md#列元数据与迁移集成)与[全局过滤器](./README.md#全局过滤器)。

## 性能和后续阅读

查询增强会增加构建阶段的 CPU 成本。方法模板缓存、按需绑定与分析复用已降低开销；数据库等待、复杂 SQL、持续负载和尾延迟仍需在自己的工作负载下测量。[性能报告](./query-performance.md)包含原生对照、优化前后结果和 pnpm bench:query 复现方式。

文档入口：

- [中英文 README](../../README.md)：定位、能力导航与公共 API。
- [方言 client](./dialect-clients.md)：工厂、驱动变体、派生与能力声明。
- [查询函数](./query-functions.md)：函数目录、链式调用、分组与错误语义。
- [性能核查](./query-performance.md)：测量条件、结果和边界。
- [文档网站接入建议](./documentation-site.md)：站点栏目、原生/增强示例与沙盒接入条件。
