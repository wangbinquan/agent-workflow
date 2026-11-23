# RFC-549 技术设计

## 1. 现状（HEAD `9612c16e6`，源码实读）

- `platform/persistence/schema/history/runtime.ts`：`SchemaHistoryRuntime`（`head()`、`metaTables`、可选的 `history()` 与 `catalogCache()`）、模块级
  `let binding`、`registerSchemaHistoryRuntime()`、`schemaHistoryRuntime()`（未登记即抛 `schema-history-runtime-unbound`）与
  `runtimeHistoryAdmission()`（head、元数据表与目录缓存，准入用）。
- 登记两处：`bootstrap/persistenceSchema.ts` 在模块求值时登记二进制自带的历史（`persistenceHead` / `persistenceHistory` /
  `persistenceCatalogCache` 与 `EPOCH2_META_TABLES`）；`platform/persistence/sqliteLogicalSourceWorkerHandler.ts` 在 Worker 初始化时按消息里可选的
  `history` 登记 head 与元数据表。
- 读取约 30 处、16 个文件：daemon 启动（`startCommand` 取 head 的版本号）、SQLite 客户端（`openDb` 的准入与开发期库身份）、provider 运行期
  （恢复解析、epoch-2 准备与 PostgreSQL 准备）、迁移前备份、迁移执行器与协调器、epoch 切换的指针替换、PostgreSQL 管理恢复、PostgreSQL
  逻辑源 / 逻辑目标、迁移历史加载、元数据快照（采集 / 校验 / 还原）、PostgreSQL schema 计划（epoch-2 契约）、SQLite 系统恢复、SQLite
  逻辑源的表枚举与 Worker 监管。已有的载体：bootstrap 的常量 `persistenceSchemaBinding`（RFC-545），以及收下 live 绑定的 provider 运行期选项、
  托管恢复安装、CLI 等入口；其余链路上没有载体，最近的载体在组合或 bootstrap。
- 用例与夹具改写登记来换历史：`rfc213-restore`、`rfc213-pre-migration-backup` 登记后继的 head 与历代版本，`rfc213-dev-database-reload` 登记改了
  摘要的 head，`rfc395-backup-metadata` 登记只含一张合成表的元数据表，事后各自复原；e2e 夹具 `epoch2-upgrade-start.ts` 登记后继版本后再
  import `main`，以“下一个版本”启动真实 daemon；`epoch2-future-backup.ts` 只读元数据表。

## 2. 机制与落位

落在 platform/persistence（历史类型与读取方）、system-operations（迁移、恢复、epoch 切换）、`db/client.ts` 与 bootstrap；不新增跨上下文
依赖，模块 public 不变。

### D1 绑定带上历史

- `RuntimeSchemaBinding` 多 `history: SchemaHistoryRuntime`；bootstrap 的 `persistenceSchemaBinding.history` 是二进制自带的历史。
- `runtime.ts` 只留类型与 `runtimeHistoryAdmission(history)`；删去 `binding`、`registerSchemaHistoryRuntime()` 与 `schemaHistoryRuntime()`。

### D2 读取方显式收下

- 已经收下 live 绑定的取 `liveSchema.history`；bootstrap 与 `db/client.ts` 取 bootstrap 的常量；其余读取方多一个 `schemaHistory` 参数（只要元数据表的读取方收 `metaTables`；按各自已有的
  参数形状：选项对象里多一个字段，或位置参数多一个），沿调用链交到最近的载体：迁移执行器与协调器、指针替换与它的调用方（遗留恢复适配器、
  启动时的待恢复、协调器、PostgreSQL 管理恢复）、迁移前备份、PostgreSQL 逻辑源 / 逻辑目标与它们的打开方、迁移历史加载与恢复源契约解析、
  元数据快照、PostgreSQL schema 计划（只有 epoch-2 契约读历史）、SQLite 系统恢复、SQLite 逻辑源与 Worker 监管。组合函数缺载体的，由 bootstrap
  交入。
- Worker：初始化消息的 `history` 改为必填，处理器把它交给逻辑源，不再登记。

### D3 下一版本启动的替换口

- bootstrap 持有二进制历史的来源，`persistenceSchemaBinding.history` 委托给它；bootstrap 导出一处替换口，把来源换成给定的历史（head 与历代版本，
  元数据表与目录缓存沿用原来的）。只服务 e2e 的“下一个版本启动”夹具，以及经 bootstrap 组合的路径（`openDb` 的开发期库身份）的用例；生产
  代码不调用它。bootstrap 是组合根，design §14 该行不计 bootstrap；platform 不再持有这份状态。

### D4 用例与锁

- 新增 `tests/rfc549-schema-history-runtime-explicit-boundary.test.ts`，登记 guard-manifest：① `runtime.ts` 顶层没有 `let`，模块级可变单例判据
  为空；删去的名字在生产代码里不出现；替换口在生产代码里只有定义、没有调用（语料下限 3,000）；② 行为：`runtimeHistoryAdmission` 按交入的
  历史给出 head、元数据表与目录缓存；bootstrap 的绑定带着二进制的历史；替换口换过之后绑定读到的是新的 head，复原后回到原来的；③ 带负对照。
- 随改：改写登记的 4 个用例改为把替换后的历史显式交给被测函数（经 `openDb` 的那一个用替换口）；直接调读取方的用例交入
  `persistenceSchemaBinding.history`；Worker 的用例在初始化消息里带历史；两个 e2e 夹具改用替换口与 bootstrap 的绑定。

## 3. 清单（退出门）

| 名字                                       | 之后                                                           |
| ------------------------------------------ | -------------------------------------------------------------- |
| `binding` / `registerSchemaHistoryRuntime` | 删去；bootstrap 的 `persistenceSchemaBinding.history` 显式交入 |

## 4. 用例

- ① ～ ③ 见 D4；既有用例覆盖迁移、恢复、备份、逻辑复制、启动准入与 Worker 的行为。

## 5. 失败模式

- **某条链路漏交历史**：参数必填，`tsc` 报出每一个调用点；没有回落到全局的路径。
- **替换口流进生产代码**：RFC-549 用例钉生产代码只有它的定义。
- **Worker 不带历史初始化**：协议的 schema 拒收；RFC-540 的 Worker 用例改为带历史初始化。

## 6. 取舍（可推翻）

1. **历史并进 live 绑定，而不是另起一个参数到处传**：两者都是“这个二进制对持久化 schema 的认知”，都由 `bootstrap/persistenceSchema.ts` 组合；
   并进去之后，RFC-545 已经接好的载体（provider 运行期、托管恢复、CLI 与句柄上下文）不必再加参数。
2. **替换口放在 bootstrap，而不是让 `main` 把绑定一路传下去**：daemon 的启动链上有十来个 bootstrap 文件直接取这份常量，一路传下去只为一个
   e2e 夹具；替换口留在组合根之内，platform 与模块里都没有可变的全局。
3. **保留 `history` / `catalogCache` 可选**：Worker 与只关心 head 和元数据表的调用方不必伪造历代版本与目录缓存，语义与原先相同。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合根交入历史，platform 不读全局。**C11**：模块 public 不变。**C12**：RFC-549 用例覆盖。**C13**：计数不升，模块级可变单例 39 → 37。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 4 项第十五步；RFC-546 “可迁移”一类拆完。
- **留下**：RFC-546 的两类（凭据 / 访问 / 完整性相邻 9 条、进程级 28 条）待用户确认；S12 第 4 项的退出门随之由用户的答复决定。
