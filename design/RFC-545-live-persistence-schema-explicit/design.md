# RFC-545 技术设计

## 1. 现状（HEAD `3f236a701`，源码实读）

- `platform/persistence/schema/tables.ts`：模块级 `let liveBinding`，`registerPersistenceSchema(binding)` 冻结后写入，`persistenceSchemaBinding()`
  读（未登记即抛 “Live persistence schema has not been composed”）。
- 登记方只有 `bootstrap/persistenceSchema.ts` 的模块求值（`registerPersistenceSchema({ definitions, nativeTables, rowRuleCodes })`）。
- 生产读方两处：`postgresqlDatabaseClient.ts` 的 `createPostgresqlDatabaseClient`（取 `nativeTables.postgresql` 与 `rowRuleCodes`）与
  `sessionTables.ts` 的 `tablesOf`（核对句柄绑的表集就是 live 的那一份，否则抛 “no epoch-2 table set”）。SQLite 客户端（`db/client.ts`）直接取
  bootstrap 的常量，不经登记。
- provider 运行期的选项（`ResolveDatabaseProviderRuntimeOptions`）已经显式带着 bootstrap 给的 `contract`（逻辑 schema 合同），PostgreSQL 一支在
  `composePostgresqlProviderRuntime` 的 `openClient` 里建客户端。

## 2. 机制与落位

落在 platform/persistence（`schema/tables.ts`、`sessionTables.ts`、`postgresqlDatabaseClient.ts`、`databaseProviderRuntime.ts`）与 bootstrap；
system-operations 与 CLI 的入口沿已有的 `contract` 通路多收一个字段。

### D1 live 绑定是 bootstrap 的常量

- 删去 `liveBinding`、`registerPersistenceSchema` 与 `persistenceSchemaBinding()`；`schema/tables.ts` 只导出 `RuntimeSchemaBinding` 类型。
- `bootstrap/persistenceSchema.ts` 导出冻结的 `persistenceSchemaBinding` 常量（内容与原先登记的相同）。

### D2 客户端与 provider 运行期显式收下

- `createPostgresqlDatabaseClient(runtime, { liveSchema, ... })`：`liveSchema` 必填，原生表集与行规则错误码取自它。
- `ResolveDatabaseProviderRuntimeOptions` 在 `contract` 旁加必填的 `liveSchema`，`composePostgresqlProviderRuntime` 用它建客户端。凡是构造这份选项
  的地方（bootstrap、CLI 的 migration report、system-operations 的 doctor / provider boot / 安装 / 托管部署）都沿各自拿到 `contract` 的同一条通路
  拿到 `liveSchema`：bootstrap 直接取常量，模块与 CLI 由各自的输入收下。字段名避开托管 provider 已有的 `schema: 'apply' | 'verify'`。

### D3 `tablesOf` 看句柄绑定时交入的 live 绑定

- 句柄上下文多一个 `live`（`RuntimeSchemaBinding | null`）；`bindDatabaseHandle(handle, tables, engine, live = null)`。PostgreSQL 客户端交入
  `liveSchema`，SQLite 客户端交入 bootstrap 的常量，epoch-1 的绑定不交。`tablesOf` 在 `live` 为空或表集不是 `live` 里这个引擎的那一份时照旧
  抛 “no epoch-2 table set”。继承句柄共用同一份上下文，`live` 随之。

### D4 用例与锁

- 新增 `tests/rfc545-live-persistence-schema-explicit-boundary.test.ts`，登记 guard-manifest：① `schema/tables.ts` 没有模块级状态，删去的名字在
  生产代码里不出现（语料下限 3,000）；② 行为：带 live 绑定的句柄 `tablesOf` 返回原生表集，表集不对或没有 live 绑定照旧报错，继承句柄随之；
  ③ 带负对照。
- 随改：直接构造 PostgreSQL 客户端或 provider 运行期选项的用例与测试助手补 `liveSchema`；调 `persistenceSchemaBinding()` 的用例改用 bootstrap
  的常量；绑 live 表集后取 `tablesOf` 的用例交入 live 绑定。

## 3. 清单（退出门）

| 名字                                                     | 之后                                           |
| -------------------------------------------------------- | ---------------------------------------------- |
| `liveBinding` / `registerPersistenceSchema`（live 登记） | 删去；bootstrap 的常量，显式交给客户端与运行期 |

## 4. 用例

- ① ～ ③ 见 D4；既有用例覆盖两种引擎的客户端、`tablesOf` 的 epoch-2 核对（`rfc395-target-test-database`、`rfc395-r1-target-contract`）与 provider
  运行期的各个入口。

## 5. 失败模式

- **某条入口漏交 `liveSchema`**：字段必填，类型检查即失败。
- **`tablesOf` 放过了不是 live 的表集**：RFC-545 用例钉没有 live 绑定与表集不对两种都报错。

## 6. 取舍（可推翻）

1. **沿 `contract` 的通路交，而不是挂在数据库运行期上**：运行期是连接与代次，schema 是组合根的表集；两者本来就由同一批入口一起交给
   provider 运行期。
2. **`tablesOf` 改看上下文里的 live 绑定**：核对的仍是“表集就是 live 的那一份”，只是那一份由绑定方交入，不再从进程状态里取。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：bootstrap 组合 schema 并显式交给 provider 构造。**C11**：各模块 public 不变（system-operations 的组合输入沿已有通路多一个字段）。
  **C12**：RFC-545 用例覆盖。**C13**：计数不升，模块级可变单例 48 → 46。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 4 项第十二步（live schema 的登记，2 条）。
- **留下**：schema 历史运行时的登记（2 条，另立）、规范 JSON 片段缓存（1 条）、日志器配置（4 条）；凭据 / 访问 / 完整性相邻的 9 条；须经用户确认
  的 30 条。
