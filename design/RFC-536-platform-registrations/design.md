# RFC-536 技术设计

## 1. 现状（HEAD `bd3b4a323`，源码实读）

- **配置生效监听**（`platform/configuration/configAppliedListeners.ts`）：模块级 `const listenersByPath = new Map<string, Set<…>>()`；
  `registerConfigAppliedListener(configPath, listener)` 登记并返回注销函数；`notifyConfigApplied(configPath, config)` 同步调全部监听，监听抛错只记
  日志（带 `configPath`），有异步结果时返回一个等全部完成的 Promise（否则返回 `undefined`）。
  - 通知：system-operations `composition/applicationConfiguration.ts` 的 `composeApplicationConfigurationBinding` 在 `composeCommands` 里以
    `notificationKey`（选定来源的逻辑键或文件路径）通知；`composition.ts` 的 `composeFileApplicationConfiguration` 以 `configPath` 通知（生产里
    无调用方，用例用它）。
  - 登记：daemon 会话（`bootstrap/daemonSession.ts` 的仓库镜像刷新，键 `input.applicationConfiguration.notificationKey`）与维护服务
    （`platform/background/maintenanceService.ts` 的维护时间表，键 `options.configPath`；daemon 会话交的是同一个 `notificationKey`，这个选项只为
    登记存在）。
  - `notificationKey` 另用于运行时探针的配置栅栏（`composeRuntimeProbeConfigFence`），不在本 RFC 范围。
- **执行可用性**（`platform/http/executionAvailability.ts`）：模块级 `const readers = new WeakMap<object, () => ExecutionStatus>()`；
  `bindExecutionAvailability(app, read)` 绑定（已绑定则抛 `execution-availability-already-bound`）；`readExecutionStatus(app)`（未绑定抛
  `execution-availability-unbound`）供 `routes/daemon.ts`；`assertExecutionAvailable(app, group)` 供 `routes/registry.ts` 的处理链与
  `routes/clarify.ts`（未绑定的 app 不门控）。绑定处只有 `server.ts` 的 `mountApiRoutes`。
- **事务观察**（`db/transactionScope.ts`）：模块级 `const transactionObservers = new WeakMap<object, (ms) => void>()`；`bindTransactionObserver(client,
observe)` 由 `db/client.ts` 在建 SQLite 客户端、选项带 `observeTransactionMs` 时调（生产里只有维护 Worker 带）；`observeDbTransaction(client, ms)`
  由 `platform/persistence/databaseTransaction.ts` 与 `db/txSync.ts` 在事务结束时调。
- 架构报告的模块级可变单例清单里这三个文件各 1 条（`registerConfigAppliedListener`、`bindExecutionAvailability`、`bindTransactionObserver`），
  全仓 61 条。

## 2. 机制与落位

### D1 配置生效监听归应用配置

- `configAppliedListeners.ts` 删去模块级表与两个按路径的函数，改为 `createConfigAppliedListeners(key): ConfigAppliedListeners`（`register(listener)`
  返回注销函数、`notify(config)`；逻辑逐字搬进闭包，同步 / 异步契约不变，错误日志照旧带 `configPath: key`）。
- `ApplicationConfigurationBinding` 加只读的 `listeners`（只有 `register`；每份绑定以自己的 `notificationKey` 建一组）；`composeCommands` 的
  `applied.notify` 通知这一组。`composeFileApplicationConfiguration` 收一组监听（必填，用例交它自己的）。
- 登记：daemon 会话改为 `input.applicationConfiguration.listeners.register(…)`；维护服务的选项把只为登记存在的 `configPath` 换成
  `configApplied: Pick<ConfigAppliedListeners, 'register'>`，daemon 会话交同一组。

### D2 执行状态读取器随 app 走

- `executionAvailability.ts` 删去模块级表：读取器记在 app 对象上（模块常量的符号作键，`Object.defineProperty` 不可枚举、不可写，只读自有属性），
  绑定前已有该属性即抛 `execution-availability-already-bound`；`readExecutionStatus` / `assertExecutionAvailable` 从 app 本身读，未绑定时的两种
  结局不变。函数名改为 `attachExecutionAvailability`，表明它给 app 记读取器。

### D3 事务观察者随客户端走

- `transactionScope.ts` 删去模块级表：观察者记在客户端对象上（符号作键，不可枚举、不可写，只读自有属性），`observeDbTransaction` 从客户端本身读；
  函数名改为 `attachTransactionObserver`。`db/client.ts` 的调用处随改名。

### D4 用例与锁

- 新增 `tests/rfc536-platform-registrations-boundary.test.ts`，登记 guard-manifest：① 三个文件顶层没有 `let` 与 `new Map / Set / WeakMap / WeakSet`，
  架构报告的模块级可变单例判据在这三个文件里为空；生产代码不再引用删去的名字；daemon 会话在应用配置的那一组上登记、把同一组交给维护服务，
  应用配置绑定的通知只经它自己的那一组（语料下限 3,000）；② 行为：两组监听互不通知、注销后不再通知、异步监听被等完、监听抛错不影响别的；
  两个 app 各读各的读取器、重复绑定被拒、未绑定的两种结局；两个客户端各报各的事务耗时；带负对照。
- 读旧形状的用例随改：`rfc370-application-configuration-binding`、`rfc370-selected-settings-storage`、`rfc370-config-applied-ack`、
  `rfc266-concurrency-hot-apply`（经应用配置的那一组登记）、`rfc370-root-background-bindings`（钉登记点与维护服务的选项）、
  `rfc349-config-route-provider-boundary`（给 `composeFileApplicationConfiguration` 交一组）、`rfc370-m1-execution-authority` /
  `rfc370-v2-execution-authority`（改名）；构造维护服务选项与应用配置绑定的用例补字段。

## 3. 清单（退出门）

| 名字                                                                        | 之后                                                     |
| --------------------------------------------------------------------------- | -------------------------------------------------------- |
| `listenersByPath` / `registerConfigAppliedListener` / `notifyConfigApplied` | 删去；`createConfigAppliedListeners()`，每份应用配置一组 |
| `readers` / `bindExecutionAvailability`                                     | 删去；`attachExecutionAvailability` 把读取器记在 app 上  |
| `transactionObservers` / `bindTransactionObserver`                          | 删去；`attachTransactionObserver` 把观察者记在客户端上   |

## 4. 用例

- ① ～ ② 见 D4；既有用例覆盖设置保存后的热应用（`rfc266`、`rfc349-orphan-reconcile-hot-apply`、`rfc370-config-applied-ack`）、执行门控
  （`rfc370-m1` / `rfc370-v2-execution-authority`）与维护 Worker 的事务耗时观察。

## 5. 失败模式

- **登记与通知用了两组监听**：RFC-536 用例钉 daemon 会话在应用配置的那一组上登记、把同一组交给维护服务；通知只经 `composeCommands`。
- **以 `as unknown as` / `as never` 伪造的维护服务选项或应用配置绑定**：按 `docs/dev-gotchas.md` 全仓搜一遍补上。

## 6. 取舍（可推翻）

1. **监听归应用配置而不是会话**：通知方（保存设置）与登记方都拿得到同一份应用配置绑定；归会话要另开一条把通知交回 system-operations 的路。
2. **读取器与观察者记在各自的对象上**：它们本来就按对象一一对应、随对象一起消失；记成对象上不可枚举的自有属性不改变对象的内容与相等性，比改
   处理链与事务入口的签名小得多（与 RFC-535 的对照范围同一手法）。
3. **维护 Worker 的效果模块登记不在本步**：托管 Worker 入口在 init 之前登记、普通入口不带托管代码，Worker 根又有“只有一句”的薄入口锁；交入加载器
   要先改入口的形状，单列一步。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合层只把依赖往下交。**C11**：各模块 public 不变；system-operations 的应用配置绑定多一个只读成员。**C12**：RFC-536 用例覆盖。
  **C13**：计数不升，模块级可变单例 61 → 58。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 4 项第四步（platform 与 db 的三处进程级登记，3 条）。
- **留下**：其余 58 条（维护 Worker 的效果模块登记、已提交事件的即时投递泵、ws 的三处登记与遗留测试库标记、平台持久化的 schema 绑定、日志器、
  platform / util 的进程级缓存；后者需要保留的由后继 design 提出、经用户确认后修订 §14 口径）。
