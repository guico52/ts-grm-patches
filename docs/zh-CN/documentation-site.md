# ts-grm 文档网站接入建议

建议将 ts-grm-patches 纳入 [ts-grm 文档网站](https://ts-grmd.guico.top)的生态文档，设置独立的“生态增强 / ts-grm-patches”栏目。原生教程继续展示 ts-grm API，增强教程显式导入本包并说明启用入口，读者可以按自己的需求选择。

本文是接入方案，尚未修改或发布网站。拟议路由不是当前已经上线的页面。

## 依据现有网站结构安排栏目

截至 2026-11-26，网站目录已有“查询 API”“SQL 后端”“API 参考”等分组，并提供每页 Markdown 与 llms 索引。可以新增一个 ecosystem 分组，沿用 /docs/<group>/<page> 的路由形状：

| 拟议页面         | 拟议路由                              | 主要内容                              | 仓库内容来源                    |
| ---------------- | ------------------------------------- | ------------------------------------- | ------------------------------- |
| 增强包概览与接入 | /docs/ecosystem/patches-overview      | 定位、版本、安装和显式启用            | enhancement-guide.md            |
| 方言绑定 client  | /docs/ecosystem/patches-clients       | 五库工厂、驱动变体、派生与 capability | dialect-clients.md              |
| 函数与链式表达式 | /docs/ecosystem/patches-functions     | 原位链式表达式、通用/方言函数与嵌套   | query-functions.md              |
| 自动分组         | /docs/ecosystem/patches-grouping      | 标量键、聚合传播、语义错误与分层      | query-functions.md              |
| 过滤器与元数据   | /docs/ecosystem/patches-model-support | 全局过滤器、默认值、自增及 BOOL/TEXT  | README.md                       |
| 兼容性与性能     | /docs/ecosystem/patches-limits        | 支持版本、验证范围、性能和已知限制    | query-performance.md 与功能文档 |

每个增强页的开头标注包名、所需增强包版本、匹配的 ts-grm 版本和启用入口。原生与增强代码的 import 来源应完整展示，不让读者把 q.fn、autoGroupBy 或增强工厂当成原生 API。

从现有页面增加相关链接即可，不需要改写它们的基础用法：

| 网站现有页面                    | 增强栏目的链接主题                       |
| ------------------------------- | ---------------------------------------- |
| 查询 API → 聚合与分组           | 原位表达式链式、q.fn、autoGroupBy 与边界 |
| SQL 后端 → 驱动接入与 SqlClient | 创建时绑定方言、派生保留类型             |
| SQL 后端 → 方言差异             | 通用函数适配与专有命名空间               |
| SQL 后端 → SQL 拦截器           | 跨模型与按列注册过滤器                   |
| SQL 后端 → 模式创建             | 自增/默认值元数据与 DDL 消费边界         |

## 发布版本与文档来源

增强能力已随 **0.4.1** 发布（旧版 `0.3.1` 已从 npm 撤回；`0.4.1` 移除了 `select().where()` 以完全对齐原生查询语法）。站点教程可以锁定 ts-grm-patches@0.4.1 及匹配的 ts-grm 依赖，再完成沙盒验证后标为正式可运行示例。

本包要求 Node >=20、ts-grm >=0.0.13 <0.0.15；网站当前安装页写的是原生 ts-grm 的 Node >=18。增强页应单独列明要求，不能直接沿用原生要求。原生版本未来升级时，应先验证 peerDependencies 与行为，再扩展支持声明。

包仓库保存 API 契约、支持范围、CHANGELOG 和性能原始记录；网站侧提供学习顺序、可运行示例及相关原生教程的链接。两处文档标注对应版本，站点案例的变更与依赖升级一起验证，避免直接复制开发分支后长期失配。

## 浏览器沙盒的接入条件

网站说明沙盒在浏览器内使用 PGlite，预置只读 infra/sql-client.ts，并支持 SQL/参数追踪。这是演示增强前后 SQL 的合适位置，但本轮未读取站点源码或验证沙盒加载增强包。

接入时先完成以下验证：

1. 将选定的 ts-grm-patches 构建和匹配的 core/sql 类型加入沙盒依赖、编译映射与运行时映射，确保编辑器类型和执行代码一致。本包的 Node 支持范围本身不构成浏览器可运行承诺，需要验证打包与依赖加载。
2. 保留原生页面使用的 sqlClient，为增强页单独提供 enhancedSqlClient 或受控工厂。先确认沙盒 client 的 driver 名称与实际对象能通过绑定校验，再选择 enhanceClient 接入方式。
3. 展示相同查询的“原生手写 GROUP BY”和“增强 autoGroupBy”对照，并验证结果、SQL 结构和绑定参数。功能示例标为可运行之前，应先完成冒烟测试。
4. client/fn 示例可以先接入；元数据/BOOL/TEXT 示例还需要处理 applyPatches 必须早于模型模块执行的顺序。不能在已加载模型后追加调用就假设生效。
5. PGlite 沙盒演示以 PostgreSQL 能力为范围。其他数据库展示 SQL 模板和能力表，并标明真实 renderer 验证与真实数据库执行验证的区别。
6. 新页同步加入目录、搜索、llms.txt、llms-full.txt 和逐页 Markdown 输出；这些是网站已经向读者提供的入口。

## 建议的上线顺序

0.4.1 已发布，可先上线概览页；随后接入 PostgreSQL 沙盒中的原位表达式链式、函数与自动分组；再补齐 client 派生、过滤器、元数据与其他数据库的差异表。

这样既能让现有 ts-grm 用户发现增强包，也能保持原生教程独立可用。是否引入增强依赖由读者显式决定。

@see [网站目录与 Markdown 索引](https://ts-grmd.guico.top/llms.txt)
@see [网站安装要求](https://ts-grmd.guico.top/docs/getting-started/install)
@see [沙盒运行机制](https://ts-grmd.guico.top/docs/about/sandbox)
@see [原生聚合与分组](https://ts-grmd.guico.top/docs/query/aggregate)
@see [原生驱动接入](https://ts-grmd.guico.top/docs/sql-backend/driver)
@see [原生过滤器教程](https://ts-grmd.guico.top/docs/sql-backend/filter)
