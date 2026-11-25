# 补丁性能核查

核查日期：2026-11-26。生产代码基线：2260a8c，@ts-grm/core 与 @ts-grm/sql 均为 0.0.13。

CHANGELOG 的 Unreleased 已覆盖三次功能提交：链式查询/自动分组（8c84504）、client 方言绑定（08c7882）、方言函数实现（2260a8c）。它们尚未被标记为一个已发布版本；package.json 仍是 0.2.2。此次追加了基准工具和本报告的记录。

## 结论

补丁不是零开销。普通导入未自动修改原生 API；基础 applyPatches 在普通字段查询上的稳态影响较小。显式 enhanceClient 或使用补丁的 newSqlClient 后，即使没有调用 q.fn、autoGroupBy，每次查询仍增加实例方法安装、生命周期检查和方言校验。q.fn 返回表达式的逐实例链式增强是本例最大的额外 JavaScript 成本。

自动分组在查询构建回调结束时执行，不会针对返回的每一行重新分析。执行器、连接池和事务仍由原生 client 处理；但使用展开的方言函数、改变过滤器或分组规则会改变 SQL，数据库端的成本需要另测。

## 方法与复现

```bash
pnpm bench:query
# 反向排列模式顺序再跑一次，检查顺序效应：
pnpm build
BENCH_REVERSE=1 node bench/query-performance.mjs
```

环境为 Linux x64、Node v24.15.0、Intel Core i7-12700H。每种模式启动独立 Node 进程，避免全局补丁和 V8 调用点相互污染。预热后自适应批次数，每批目标至少 40 ms，取七次样本的中位数；保留 256 个结果的循环数组，让构建的对象逃逸计时循环。每次样本前主动 GC，计时内自然发生的 GC 仍计入。

以下区间为正序、反序两轮各自中位数的最小值与最大值，不是置信区间。raw 数据保留每批迭代次数、最小值、最大值和 SQL/参数。

- native：只加载原生包。
- imported：导入补丁包，继续使用原生 client，不调用 applyPatches。
- patched：调用 applyPatches，继续使用原生 client。
- enhanced-native：基础补丁加 enhanceClient，表达式仍使用原生 DSL，手写 GROUP BY。
- enhanced-functions：基础补丁加 enhanceClient，使用 q.fn 的链式表达式，手写 GROUP BY。
- enhanced-auto：与上项相同，改由 autoGroupBy 推导；普通查询也开启 autoGroupBy。

简单查询是选择 id/name、按 id 过滤；分组查询选择 UPPER(LOWER(name)) 和 SUM(amount) + 1，并按前者分组。测试使用真实 PostgresDriver 和原生 SQL renderer，执行边界返回空数组。脚本对六种模式生成的 SQL 文本及绑定参数做完全一致性断言。

因此 render 指“每次重新构建查询 + SQL 生成/绑定 + 原生 fetchList 管线 + 空结果模拟执行”，包含异步调用成本。它不包含网络、数据库实际执行、非空结果解码，也不是预构建查询反复执行的测量。导入时间、首次模型初始化、其他四库、复杂关联/CTE、持续负载堆占用、p95/p99 均未在本轮测量。

## 测量结果

单位：μs/次。本机微基准结果不作为跨环境阈值。

| 模式               | 简单查询构建 | 分组查询构建 | 简单查询构建及 render | 分组查询构建及 render |
| ------------------ | -----------: | -----------: | --------------------: | --------------------: |
| native             |    0.17–0.18 |         0.24 |             22.5–23.6 |             29.4–29.8 |
| imported           |    0.15–0.16 |    0.23–0.30 |             23.9–25.4 |             27.1–29.4 |
| patched            |    0.18–0.19 |         0.24 |             24.0–27.2 |             29.3–30.5 |
| enhanced-native    |    8.78–8.97 |  12.30–12.53 |             35.0–35.7 |             44.6–46.4 |
| enhanced-functions |    9.14–9.54 |  67.61–69.79 |             36.6–38.4 |           123.6–130.1 |
| enhanced-auto      |  10.88–11.60 |  68.29–71.56 |             36.9–37.7 |           131.8–134.3 |

在这两个样本中，普通增强查询构建及 render 相对原生多约 12 μs；q.fn 分组查询多约 94–101 μs。后者约为原生本例的 4.2–4.4 倍，自动分组模式约 4.5 倍。这个倍数只适用于测到的 JavaScript 管线，不能直接套到有数据库等待的请求上。

同样需要看绝对成本：对于当前约 0.24 μs 的原生分组 AST 构建，增强后的几十微秒会产生很大的构建阶段倍数，但它不是数毫秒或数十毫秒的网络请求基准。两轮结果有噪声，不能把相邻模式的每个差值都视为稳定的独立组件耗时。

其他观测：

- 在相同 driver/entityManager 上新建并绑定 client 约 31–36 μs，原生 client 约 0.25–0.28 μs。前者会创建完整 fn 上下文，适合按应用配置复用；本轮未计入真实连接建立。
- 单独构建 SUM(amount).plus(1)，通过 client.fn 返回两个增强表达式时约 23–25 μs；原生路径约 0.02 μs。该结果只覆盖这个很小的表达式构造。
- applyPatches 后，新表实例首次访问 BOOL 与 TEXT 并构建两列投影，约 10.2–10.9 μs。原生 0.0.13 不支持相同查询，不能声称这是相对于可用原生实现的性能退化。
- BOOL/TEXT 在同一表实例缓存后不再触发异常回退；缓存读取微基准接近测量下限，不用于推导业务收益。新的查询表实例仍需要首次回退。

## 代码路径与 CPU 采样

源码检查和额外的 enhanced-functions CPU 采样一致：表达式增强是显著热点，查询包装、函数上下文创建、方言校验也有采样。

1. 每个新函数结果都检查完整的方法清单，构造 Map、闭包和属性描述符，再执行 Object.defineProperties。一个链条有多个结果对象，会重复这一步。涉及 expression-chain.ts 的 createExpressionEnhancer。
2. 每个查询都安装 select/where/groupBy 等实例包装，并为投影再安装链式条件方法。即使没有使用增强函数，这条路径也会执行。涉及 query-enhancer.ts 的 enhanceQuery。
3. where/groupBy/having/orderBy 调用时验证方言，finish 时又统一遍历；validateFunctionDialects 还在每次调用时声明 Visitor 子类和创建实例。即使不启用自动分组也会发生。
4. inferGroupBy 在启用时分析 AST，创建 shape/Visitor 并验证分组键。当前分析 cache 保存结果，但 analyze 入口没有按上下文读取缓存；共享节点可能被重复分析。任何缓存优化必须区分 insideAggregate 上下文，保留嵌套聚合校验。
5. BOOL/TEXT getter 在每个新表实例第一次访问时先调用会抛错的上游 getter，再回退并写缓存。安装后的 tableClass 包装在其他模型上也有一次 WeakSet 检查。

CPU 采样涵盖初始化、多个基准阶段和脚本主动 GC，不能用它的 GC 百分比推断线上服务的 GC 占比。本报告只用采样辅助确认热点位置，不给出各组件的精确贡献百分比。

这些路径说明，后续优化的首要核验对象是逐表达式的方法/闭包安装，其次是每查询包装与重复方言遍历。此次核查保留现有校验和查询语义，未将错误检测关闭作为性能对照。

## SQL 层的额外边界

上述基准的 SQL 完全相同，因此没有测量新增方言展开式在数据库端的额外工作。例如 SQLite padding 生成重复填充串，SQL Server 字符长度追加标记，带 start 的查找可能重复引用子表达式；它们的执行成本取决于数据量、长度和执行计划。

全局过滤器还可能改变 SQL：addGlobal 给每个目标模型注册过滤器，会影响原生框架关联读取外键的优化条件；addGlobalFor 仅向匹配列的模型注册。这个差异应通过真实关联查询的执行计划验证，本轮没有给它估算百分比。

@see [可复现基准](../../bench/query-performance.mjs)
@see [两轮完整原始结果](../../bench/results/2026-11-26.json)
@see [表达式实例增强](../../src/expression-chain.ts)
@see [查询生命周期与包装](../../src/query-enhancer.ts)
@see [方言校验与分组分析](../../src/function-semantics.ts)
@see [BOOL/TEXT getter 回退](../../src/query-props.ts)
@see [全局过滤器](../../src/global-filter.ts)
