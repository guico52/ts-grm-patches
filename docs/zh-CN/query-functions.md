# 查询函数与自动分组

`enhanceClient(client)` 为指定的原生 ts-grm client 添加函数上下文，并在其查询回调中添加 `q.fn` 和 `q.autoGroupBy()`。返回值仍然是同一个 client；请使用返回值获得增强后的 TypeScript 类型。

新建 client 推荐使用本包的 newSqlClient 工厂，在创建时绑定数据库类别，获得公共函数与当前方言命名空间的精确类型；参见[创建时绑定数据库方言](./dialect-clients.md)。根入口 enhanceClient 接收类型已擦除的原生 SqlClient 时，只静态暴露公共函数；通过对应方言子路径的 enhanceClient 校验后可恢复精确类型。

```ts
import { enhanceClient } from 'ts-grm-patches'

const db = enhanceClient(client)

const rows = await db
  .createQuery(ORDER, (q, t) => {
    const category = q.fn.lower(t.category)
    return q
      .select({ category, total: q.fn.sum(t.amount), average: q.fn.avg(t.amount).coalesce(0) })
      .where(t.amount.gt(0))
      .autoGroupBy()
      .orderBy(category)
  })
  .fetchList()
```

SQL 对完整的 `lower(category)` 分组，而不是原始 category 列。SUM/AVG 的输入列不会进入分组键。`sum(amount).plus(tax)` 只对聚合之外的 tax 推导分组键。

## select 后继续添加条件

select/selectDistinct 返回原生投影，并为投影添加绑定到当前查询的 where、having、orderBy、groupBy、autoGroupBy 和 fn。单值、数组、对象投影均保留原来的结果类型推导；BaseQuery 和子查询的 select 后也可以链式添加条件。

```ts
db.createQuery(ORDER, (q, t) =>
  q.select({ id: t.id, amount: t.amount }).where(t.amount.gt(0)).where(t.status.eq('active')),
)
```

重复调用 where 会按原生规则通过 AND 合并。条件既可以写在 select 前，也可以写在后面；聚合分析、分组推导和 HAVING 校验统一在同步查询回调结束时进行，之后交给原生引擎。WHERE 始终是聚合前的行过滤，不因写在 select 后就变为 HAVING。

每个回调调用一次 select，并返回该投影。回调结束后条件构建关闭，不能保留 q 或投影引用再改变已构建的查询；根查询上的 fetchList、limit、offset 等原生操作继续按原方式使用。

## 链式嵌套 SQL 函数

q.fn、client.fn、方言命名空间及 native 模板返回的表达式，其每一步链式函数都会继续返回增强后的原生表达式：

```ts
q.fn.lower(t.name).trim().upper()
// upper(trim(lower(name)))

q.fn.avg(t.amount).coalesce(0).plus(1).coalesce(99)
// coalesce(coalesce(avg(amount), ?) + ?, ?)

q.fn.postgres.jsonbExtractPathText(t.payload, 'name').coalesce('unknown').trim()
q.fn.min(t.name).coalesce('empty').concat('!').upper()
q.fn.upper(t.name).position('X').plus(1)
```

普通业务参数仍由原生绑定器绑定。字符串、数值、日期结果保留各自的方法和可空性推导，position 的结果可以继续数值运算，concat、coalesce 的结果也可继续字符串变换。coalesce 使用变长参数形式且至少提供一个 fallback。

增强只添加到表达式实例，保留 AST 对象身份、prototype 和 Visitor；不修改全局表达式原型。函数形式与链式形式进入同一函数上下文，再选择方言实现或保存的原生方法，避免相互转调造成递归。公开类型包含 ChainedStrExpression、ChainedNumExpression、ChainedDateExpression，并可传回原生表达式 API。

表达式增强按原生 prototype 缓存方法描述，链式值变换在首次访问时才创建并缓存绑定方法。实例自有方法与通过 getter 返回的方法保留各自的原始实现，不会在其他实例间串用。比较与排序方法保留原生调用方式，操作数中的函数依赖仍参与方言和聚合检查；对应的 q.fn.eq、q.fn.asc 等函数入口继续提供。性能对比见[性能核查](./query-performance.md#性能优先改写后的复测)。

标量子查询经 distinct 创建的新实例也继续增强，asValue 后可接 coalesce 等 SQL 函数；这不扩大 autoGroupBy 对子查询自动推导的范围。已验证的上游 0.0.13 不生成子查询 LIMIT/OFFSET，增强层会对这两种调用报告 UNSUPPORTED_SUBQUERY_PAGINATION，防止静默丢失分页；根查询的 limit/offset 不受此限制。

外层 scalar 函数不会被误标成 aggregate；语义分析沿子节点保留内层聚合，因此 coalesce(avg(amount), 0) 仍按聚合结果处理。合法的标量函数嵌套可以组合；同一计算阶段的 SUM(AVG(...)) 等聚合嵌套仍由自动分组分析拒绝。

## 接入和函数范围

- 不需要安装全局查询补丁，`enhanceClient()` 可重复调用，与 `applyPatches()` 独立。列声明、BOOL/TEXT 等现有补丁仍按原流程安装。
- 覆盖当前支持的 `@ts-grm/core@0.0.13` 的所有 `dsl` 入口，包括聚合、逻辑、子查询、集合运算、BaseQuery、派生模型、CTE、常量、tuple 和 native。
- 所有公开字符串、数值、日期、EnumSet 和通用表达式方法均提供函数形式：如 `q.fn.lower(expr)`、`q.fn.times(expr, 2)`、`q.fn.plus(dateExpr, 1, 'DAYS')`、`q.fn.eq(expr, value)`。
- 保留并增强返回表达式上的原生链式方法。`q.fn.sum(t.amount).coalesce(0).plus(t.tax)` 与函数形式都能参与自动分组分析。
- `client.fn` 与查询内 `q.fn` 是同一函数上下文，可在回调外建立 BaseQuery。`q.fn.subQuery()` / `q.fn.baseQuery()` 创建的回调同样获得增强方法。直接调用全局 `dsl.subQuery/baseQuery` 不会被自动修改。
- `enhanceClient` 使用实际 driver 的名称识别 PostgreSQL、MySQL、SQLite、SQL Server、Oracle 及其上游版本变体。不同 client 不共享可变方言状态。
- 从原 client 派生出的新 client 应分别调用 `enhanceClient()`；不替换全局 QueryFactory、SQL builder、执行器或事务系统。

通用数学函数及部分字符串函数由补丁按绑定方言实现，见下表。其他上游函数仍保留原有支持范围和语义，尤其是日期运算、整数除法和排序规则。

## 通用函数的方言实现

这些函数直接生成原生表达式 parts，继续使用 ts-grm 的 Visitor 和参数绑定器。结果中的字段和聚合依赖均可被 autoGroupBy 识别，不对最终 SQL 做文本改写。

| API                         | PostgreSQL           | MySQL          | SQLite       | SQL Server            | Oracle     |
| --------------------------- | -------------------- | -------------- | ------------ | --------------------- | ---------- |
| abs、sign、floor、sqrt、exp | 同名函数             | 同名函数       | 同名函数     | 同名函数              | 同名函数   |
| ceil                        | ceil                 | ceil           | ceil         | ceiling               | ceil       |
| ln                          | ln                   | ln             | ln           | log                   | ln         |
| log10                       | log                  | log10          | log10        | log10                 | log(10, x) |
| trunc(x)                    | trunc                | truncate(x, 0) | trunc        | round(x, 0, 1)        | trunc      |
| round(x, digits?)           | 转 numeric 后 round  | round          | round        | round                 | round      |
| power(x, exponent)          | power                | power          | power        | 底数转 float 后 power | power      |
| charLength / length         | char_length          | char_length    | length       | 带尾部标记的 LEN      | length     |
| octetLength                 | octet_length         | octet_length   | octet_length | datalength            | lengthb    |
| countDistinct(expr)         | COUNT(DISTINCT expr) | 同左           | 同左         | 同左                  | 同左       |

新增数学函数接受数值字面量、NULL 或数值表达式，结果统一按 JavaScript number 读取，类型保守为 number \| null；高精度数值列也会转为 number，不提供精确小数计算保证。countDistinct 只接受单个表达式，返回 number，忽略 NULL，空集返回 0。它标记为 aggregate，可继续 abs/round 等链式调用；同阶段聚合嵌套仍会被拒绝。

```ts
q.fn.sum(t.amount).abs().round(2).coalesce(0)
q.fn.power(t.amount, -1).sqrt()
q.fn.lower(t.name).charLength().abs()
q.fn.countDistinct(t.category).plus(1)
```

round 的 digits 仅接受非负安全整数，缺省为 0；trunc 当前只支持向零截断至整数。不同数据库对近似数舍入、溢出、非法数学定义域的处理仍有差异，可能返回 NULL 或报数据库错误。显式传入的 digits、exponent 等数据继续绑定；带绑定参数的分组键仍受后文的参数化分组限制。缺省的 round 精度不增加绑定参数。

字符串适配同时覆盖函数形式和链式形式：

- left 在 PostgreSQL/MySQL/SQL Server 使用 LEFT，在 SQLite/Oracle 使用 SUBSTR(x, 1, length)，修正上游共享模板未截取前缀的问题。
- right 在 SQLite/Oracle 对长度 0 和 NULL 单独处理，其他三库使用 RIGHT。
- substring 在 SQL Server 使用 SUBSTRING，并在省略 length 时补齐其必需参数；其他库使用 SUBSTR。
- position 在 PostgreSQL/MySQL/SQLite/SQL Server/Oracle 分别使用 STRPOS/LOCATE/INSTR/CHARINDEX/INSTR。支持 start；PostgreSQL/SQLite 使用子串查找后修正偏移，未找到返回 0，NULL 输入返回 NULL。
- trim 在 SQL Server 使用 LTRIM(RTRIM(x))，不依赖 SQL Server 2017 的 TRIM。
- lpad/rpad 在 PostgreSQL/MySQL/Oracle 使用原生函数；SQLite 使用 zeroblob/hex/replace 生成重复填充串，SQL Server 使用 REPLICATE，按目标字符长度截取。这两个展开实现会在长度不足时截短原串，空 fill 不补齐，NULL 输入返回 NULL；原生函数对空 fill 的处理仍遵循厂商规则。
- SQLite、Oracle 的 reverse 缺少受支持的原生实现，构造时报告 UNSUPPORTED_FUNCTION；若部署了 UDF，可通过对应方言的 call 声明调用。

start 字面量必须为正安全整数，length 字面量必须为非负安全整数；传入数值表达式时由调用者保证同样的值域。长度以字符计并保留尾部空格，字节长度取决于数据库编码和存储类型。字符计数及查找仍遵循数据库字符集/排序规则；SQLite 的内嵌 NUL、Oracle 的空字符串等厂商行为不做统一转换。SQL Server 旧版本需使用标准的 CONCAT_NULL_YIELDS_NULL ON 设置。补齐、带 start 的查找等展开式可能多次引用输入，应避免依赖易变函数的单次求值语义。

SQLite 能力要求在创建或派生 client 时声明：

```ts
const db = newSqlClient(
  driver,
  { entityManager },
  {
    serverVersion: [3, 43],
    capabilities: { 'sqlite.mathFunctions': true },
  },
)
```

SQLite 的 ceil/floor/trunc/sqrt/exp/ln/log10/power 要求 sqlite.mathFunctions 显式为 true，表示部署环境提供 SQLITE_ENABLE_MATH_FUNCTIONS；abs/sign/round 不依赖该编译选项。octetLength 要求声明 SQLite >= 3.43，或 sqlite.octetLength 为 true；显式 false 优先禁用。未满足要求时构造表达式即报 UNSUPPORTED_FUNCTION。声明不安装扩展，也不触发联网探测。

@see [PostgreSQL 数学函数](https://www.postgresql.org/docs/15/functions-math.html)
@see [SQLite 数学函数与编译选项](https://www.sqlite.org/lang_mathfunc.html)
@see [SQLite 核心字符串函数](https://www.sqlite.org/lang_corefunc.html)
@see [SQL Server SUBSTRING](https://learn.microsoft.com/en-us/sql/t-sql/functions/substring-transact-sql)
@see [Oracle INSTR](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/INSTR.html)

## 语义标记

```ts
q.fn.metadata(q.fn.sum(t.amount))
// { name: 'sum', kind: 'aggregate' }

q.fn.metadata(q.fn.lower(t.category))
// { name: 'lower', kind: 'scalar' }
```

聚合函数标记为 aggregate，普通表达式函数标记为 scalar，任意 native 模板标记为 opaque。结构函数（如 derivedModel）返回的不是表达式，不标记为聚合。标记以旁路 WeakMap 保存，不改上游原型。

分析会沿表达式树传播聚合语义，不要求每个原生链式操作都重新写标记。原生 `dsl.sum` 等已有聚合节点也可识别。

不分析 SQL 字符串猜测是否存在 SUM 或 OVER。已知的外部表达式可以显式声明：

```ts
const total = q.fn.aggregate(q.fn.native.num`sum(${t.amount})`)
const label = q.fn.scalar(q.fn.native.str`lower(${t.category})`)
```

声明者负责保证类别与 SQL 一致；不要把窗口、子查询或 volatile 表达式伪装为普通 scalar。显式标注会更新该表达式在此模块的 metadata。没有声明的 opaque 表达式会被自动分组拒绝。

## 数值和类型

```ts
q.fn.avg(t.score) // number | null（数值列）
q.fn.avg(t.score, { as: 'number' }) // number | null
q.fn.sum(t.amount, { as: 'string' }) // string | null
```

- AVG 的 number 模式使用 FLOAT 读取标记，避免上游 AVG(integer) 对字符串小数调用 parseInt。
- MIN/MAX 的字符串、日期、EnumSet 结果保留相应运行时方法；例如 `q.fn.min(t.name).lower()`。
- 函数式与链式 position 均返回数值表达式；coalesce 均按公开的变长参数形式调用，并适配上游运行时需要数组的差异。
- `q.fn.native.num` 使用 FLOAT 标记读取小数；`.asString` 继续提供字符串读取。`q.fn.constant` 也区分整数和小数读取标记。
- string 模式只控制读取，SQL 中仍是数值表达式。不保证恢复驱动已丢失的精度，也不把 SQLite REAL 等近似计算变成精确计算。
- 数值算术、整数除法和溢出仍遵循数据库的原生 SQL 类型规则；本轮没有引入跨库精确小数运算或投影边界自动 CAST。

## 五库专有函数

创建或增强后，函数上下文只包含当前数据库的命名空间。已知方言类型会在编译时拒绝其他命名空间；运行时也没有那些属性。把其他方言的表达式带入查询时，语义检查会抛出 DIALECT_MISMATCH。

| 命名空间       | 本轮内置函数                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `fn.postgres`  | jsonbExtractPath、jsonbExtractPathText、jsonbContains、arrayAgg、arrayContains、toTsVector、websearchToTsQuery、tsRank |
| `fn.mysql`     | jsonExtract、jsonUnquote、jsonContains、findInSet、field、dateFormat、strToDate、timestampDiff                         |
| `fn.sqlite`    | jsonExtract、jsonType、jsonGroupArray、jsonGroupObject、strftime、julianday、unixepoch                                 |
| `fn.sqlserver` | jsonValue、jsonQuery、isJson、tryConvert、dateDiff、dateDiffBig、dateFromParts、eomonth                                |
| `fn.oracle`    | toChar、toDate、toTimestamp、addMonths、monthsBetween、lastDay、regexpSubstr、jsonValue、jsonQuery                     |

这些是已有调研清单的首批函数，不是五个厂商所有内置函数的完整目录。arrayAgg、jsonGroupArray、jsonGroupObject 自带聚合标记；其他条目为标量函数。JSON 的原始结果可能是文本、标量或驱动解析后的对象，因此部分返回类型保守声明为 unknown。

数据参数使用原生绑定；日期单位和 TRY_CONVERT 类型使用白名单。Oracle SQL/JSON path 必须是 SQL 字符串字面量，补丁在该语法位置正确转义单引号。MySQL `timestampDiff` 单位使用 `DAY` 等大写 token；SQL Server `dateDiff` 使用 `day` 等小写 token。`tryConvert` 首批类型支持 int、bigint、float、date、datetime2，结果类型保守为 unknown。

其他采用普通函数调用语法的内置函数/UDF 可以声明契约调用：

```ts
q.fn.postgres.call({ name: 'my_schema.custom_sum', kind: 'aggregate', result: 'number' }, t.amount)
```

函数名只接受受控的普通标识符或点分标识符，参数仍绑定。`result` 可选 number/string/date/boolean/unknown；boolean 表示驱动实际返回原生 boolean，不把任意数字自动解释成 boolean。专有函数保留厂商语义；MySQL jsonContains、SQL Server isJson 等数值谓词返回 number。表值函数、需要特殊 SQL 语法或窗口 OVER 的函数不能通过此接口伪装成标量调用。

不自动探测服务端版本、编译选项和扩展，不静默修改 session 配置。使用方须保证目标数据库具备相应函数。当前仅对 SQLite 做真实执行验证，其他方言模板通过 SQL/绑定测试，不构成五库完整执行兼容承诺。

@see [PostgreSQL JSON](https://www.postgresql.org/docs/15/functions-json.html)
@see [MySQL JSON](https://dev.mysql.com/doc/refman/8.0/en/json-search-functions.html)
@see [SQLite JSON](https://www.sqlite.org/json1.html)
@see [SQL Server DATEDIFF](https://learn.microsoft.com/en-us/sql/t-sql/functions/datediff-transact-sql)
@see [Oracle 单行函数](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Single-Row-Functions.html)

## 自动分组边界

autoGroupBy 是显式选择：不调用它时不会自动增加 GROUP BY。没有普通聚合时不生成分组，纯聚合不生成多余分组键；与原生 groupBy 互斥。HAVING/ORDER BY 只能使用已有分组键或聚合结果，不自动补入额外列改变分组粒度。

同一列及已知不可变一元函数（如两次构造的 lower(category)）可按结构去重；其他表达式优先复用同一个对象，不进行任意代数等价推导。select 前后的条件都会参与回调结束时的统一校验。

以下情况会明确报错：

- 参数化分组键在 SELECT/GROUP BY 中重复绑定，不能保证数据库将两个占位符视为同一表达式。
- 子查询参与自动推导、实体 fetch/复杂 DTO 投影、同一阶段嵌套聚合、WHERE 中直接使用聚合。
- 无分组键的 HAVING；应先做聚合 BaseQuery，再在外层 WHERE 过滤。
- 同时使用 HAVING 和 ORDER BY：已安装上游 0.0.13 的生成器将 ORDER BY 放在 HAVING 前，增强查询拒绝该组合，外层查询排序即可。

参数化键可显式分层，只绑定一次：

```ts
const { fn } = db
const stage = fn.derivedModel(
  fn.baseQuery(ORDER, (q, t) =>
    q.select({ category: q.fn.coalesce(t.category, 'unknown'), amount: t.amount }),
  ),
)

const query = db.createQuery(stage, (q, t) =>
  q.autoGroupBy().select({
    category: t.category,
    total: q.fn.sum(t.amount),
  }),
)
```

自动分组不处理函数依赖优化、窗口 frame、递归 CTE 的自动增强、volatile 表达式的搬移和任意查询的重新分层。不要将带参数的 raw SQL 字符串内联来绕过诊断。

本轮增强的是函数和分组；上游 `fetchCount/fetchPage` 对 native/嵌套聚合的计数问题没有在本轮修复，不应把语义标记理解为所有原生 API 已自动消费它。
