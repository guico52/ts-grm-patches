# 创建时绑定数据库方言

使用本包的 newSqlClient 工厂，在创建原生 client 的同时绑定方言、查询增强和函数类型。工厂继续调用 ts-grm 原生 newSqlClient，不接管连接池、执行器、事务或全局 QueryFactory。

```ts
import { PostgresDriver } from '@ts-grm/sql'
import { newSqlClient } from 'ts-grm-patches/postgres'

const db = newSqlClient(new PostgresDriver(pool), { entityManager })

db.dialect // 类型和运行时值均为 'postgres'

await db
  .createQuery(ORDER, (q, t) =>
    q
      .select({
        id: t.id,
        name: q.fn.postgres.jsonbExtractPathText(t.payload, 'name').coalesce('unknown').trim(),
      })
      .where(t.id.gt(0)),
  )
  .fetchList()

// db.fn.mysql：TypeScript 报错，运行时也没有这个命名空间
```

## 入口与驱动

| 导入路径                 | 接受的原生 driver                    | 绑定的 dialect |
| ------------------------ | ------------------------------------ | -------------- |
| ts-grm-patches/postgres  | PostgresDriver                       | postgres       |
| ts-grm-patches/mysql     | MySqlDriver                          | mysql          |
| ts-grm-patches/sqlite    | SqliteDriver                         | sqlite         |
| ts-grm-patches/sqlserver | SqlServerDriver、SqlServer2012Driver | sqlserver      |
| ts-grm-patches/oracle    | OracleDriver、Oracle12Drivier        | oracle         |

Oracle12Drivier 是当前上游实际导出的标识符。两个 SQL Server driver、两个 Oracle driver 分别归属同一种数据库；原 driver 实例和它自己的渲染/分页策略被保留。

每个子路径还导出相应的客户端类型，例如 PostgresClient、MySqlClient，以及经过运行时校验的 enhanceClient。只有公共函数和当前方言命名空间会进入 client.fn/q.fn。类型贯穿 select/selectDistinct 返回的投影、子查询、BaseQuery 及其进一步嵌套的构建回调。

根入口的工厂也可以根据具体 driver 类型自动推导：

```ts
import { newSqlClient } from 'ts-grm-patches'
import { MySqlDriver } from '@ts-grm/sql'

const db = newSqlClient(new MySqlDriver(pool), { entityManager })
db.dialect // 'mysql'
db.fn.mysql.jsonExtract('{}', '$')
```

驱动的 name 在上游类型中是 string，因此类型推导使用具体 driver 类；运行时同时检查实际名称和可识别的类。SQL Server/Oracle 的版本变体保留原始 driverName，不用名称末尾的数字猜测服务端版本。未知名称、错误子路径、可识别的类与名称不一致都会在创建时拒绝。

## 派生 client

使用本包工厂接收已绑定 client，会创建一个新的原生 client 并继承绑定：

```ts
const child = newSqlClient(db, { defaultBatchSize: 64 })
```

child 保留 db 的数据库类别、同一个 driver/连接池，以及原生工厂应继承的 EntityManager、FilterManager、命名策略和其他配置。child 获得独立函数上下文；修改派生配置不影响父 client。方言专有入口只接受匹配的 driver 或匹配的已绑定 client。

直接调用 @ts-grm/sql 的原生 newSqlClient 派生，仍只会创建未经增强的 SqlClient。要保留增强和方言类型，应使用本包工厂；本包不会修改上游的全局工厂。

绑定后的 dialect 和 dialectProfile 只读；运行时如果有人替换 native driver 或修改 driver.name，后续查询构建、增强或派生会拒绝该实例，而不是默默切换数据库类别。

## 已有 client 的接入

原生 newSqlClient 返回 SqlClient，会擦除具体 driver 类型。可以通过方言入口的 enhanceClient 在校验后恢复类型：

```ts
import { enhanceClient } from 'ts-grm-patches/postgres'

const db = enhanceClient(existingNativeClient)
```

这是原实例上的幂等增强；如果实际 driver 属于 MySQL 等其他数据库会报 DIALECT_MISMATCH。根入口 enhanceClient 无法从一个类型已擦除的 SqlClient 静态推断数据库，返回类型只暴露公共函数；实际运行时仍绑定真实方言。再次通过对应子路径检查即可获得精确类型，无需重建连接池。

## 版本与能力声明

第三个参数与原生 client options 分开，记录显式声明：

```ts
const db = newSqlClient(
  new PostgresDriver(pool),
  { entityManager },
  { serverVersion: [15, 2], capabilities: { json: true } },
)

db.dialectProfile
// {
//   family: 'postgres',
//   driverName: 'postgres',
//   serverVersion: [15, 2],
//   capabilities: { json: true }
// }
```

profile、版本数组和 capability 字典均复制后冻结。serverVersion 接受一至三个非负安全整数；capabilities 的值必须是 boolean，缺少的键表示未声明。

这些是调用者的声明，本轮不联网探测、不根据 driver 变体推测服务端版本，也没有新增逐函数版本/能力门槛；声明不会自动启用 SQLite 编译选项、安装扩展或改变某个函数的原生限制。具体函数的服务端可用性仍由使用方保证。

派生时自动继承声明；第三参数可为新 client 覆盖版本或按键合并能力，父 profile 不变。已绑定实例不能被原地重新配置声明，更新应通过派生工厂完成。

## 验证范围

包含七个原生 driver 变体的创建、派生、身份/方言校验，以及 TypeScript 的跨方言拒绝测试。SQL 模板测试使用五种真实 driver/renderer，并模拟执行边界；SQLite 另外通过 SqliteDriver 在真实内存数据库执行查询，验证了派生后的过滤器和聚合函数。尚未连接 PostgreSQL、MySQL、SQL Server、Oracle 服务端进行集成验证。

@see [原生创建工厂与派生机制](https://github.com/babyfish-ct/ts-grm/blob/8c89604b65922b4626df4e3b8a74d509338ea5b7/packages/sql/src/sql_client.ts)
