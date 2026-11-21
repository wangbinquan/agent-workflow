# RFC-529 设计：业务模块的周期定时器改走平台定时原语

## 1. 现状（HEAD，源码实读）

生产代码里直接调全局 `setInterval` 的文件：

| #   | 位置                                                                                                             | 用途                             | 停止点                                           | `unref`            |
| --- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------ | ------------------ |
| 1   | `modules/integration/application/mrTerminalControlWorker.ts`                                                     | 恢复扫描（`RECOVERY_SCAN_MS`）   | worker 的停止                                    | 起后就 `unref?.()` |
| 2   | `modules/resource-catalog/infrastructure/local/mcpDiagnosticsEffects.ts`                                         | 诊断 effect 端口的 `setInterval` | 交出的 `cancel`                                  | 交出的 `unref`     |
| 3   | `modules/resource-catalog/infrastructure/crewstation/mcpDiagnosticsEffects.ts`                                   | 同上（托管）                     | 交出的 `cancel`                                  | 交出的 `unref`     |
| 4   | `modules/task-execution/infrastructure/childBudget.ts`                                                           | 子任务预算告警                   | 告警结束                                         | 无                 |
| 5   | `modules/runtime-management/infrastructure/drivers/opencode/subagentLiveCapture.ts`                              | 子会话实时抓取的轮询             | 抓取结束（两处）                                 | 无                 |
| 6   | `modules/task-execution/engine/node/shared/child-call/runChildCallNode.ts`                                       | 子调用节点的观测                 | 节点结束                                         | 无                 |
| 7   | `modules/task-execution/infrastructure/executionWatch.ts`                                                        | 执行看门                         | 看门结束                                         | 无                 |
| 8   | `modules/task-execution/infrastructure/taskDriverLifecycle.ts`                                                   | 任务驱动的 owner 心跳            | 换代、驱动结束与全部停止（句柄存在模块级 `Map`） | 起后就 `unref?.()` |
| —   | `platform/background/{maintenanceService,maintenanceTicker,maintenanceWorkerRuntime,providerBackupScheduler}.ts` | 平台的定时原语本身               | —                                                | —                  |

resource-catalog 的 application（`runtimeDiagnostics.ts`）调的是诊断 effect 端口上的 `setInterval` 方法，不是全局函数。S12 第 5 项点名的是 1～4；
5～8 是执行局部的计时，各有停止点。已有的账本：架构报告按语法树数“直接 `setInterval` 的位置”（`counts.json` 的 `direct-setinterval-sites` 上限
14），`rfc376-structural-guards` 的 `KNOWN` 逐条列着这 14 处（上表 8 处加 `platform/background` 的 6 处），新加一处会红；但账本只数
`setInterval`，不管 `clearInterval` 与 `globalThis.` 的写法，也不区分业务模块与平台。

## 2. 机制与落位

### D1 平台定时原语

- 新增 `platform/background/intervalTimer.ts`：`startInterval({ owner, everyMs, tick })` 返回 `IntervalTimer = { owner, stop(), unref() }`。实现就是
  `setInterval(tick, everyMs)`；`stop()` 调 `clearInterval` 且幂等；`unref()` 转给句柄（句柄没有 `unref` 时什么都不做，同此前的 `unref?.()`）。
  `owner` 是只读的名字（模块与用途，例如 `integration.mr-terminal-control`），不登记进任何全局表（不新增模块级可变状态）。
- 计时在调用时取全局 `setInterval`，用例里对全局定时器的替身照旧生效。

### D2 8 处改走原语

- 每处把 `setInterval(cb, ms)` 换成 `startInterval({ owner, everyMs: ms, tick: cb })`，`clearInterval(h)` 换成 `h.stop()`，`h.unref?.()` 换成 `h.unref()`，
  句柄的类型从 `ReturnType<typeof setInterval>` 换成 `IntervalTimer`；回调、周期与停止时机原样。
- 两个诊断 effect 照旧交出 `{ cancel, unref }`（端口合同不变），内部改调原语。
- owner 心跳的模块级 `Map` 照旧（S12 第 4 项），存的句柄换成 `IntervalTimer`。

### D3 门与账本

- 账本收紧：`rfc376-structural-guards` 的 `KNOWN` 删去 8 处业务模块的条目、加平台定时原语的一处，`direct-setinterval-sites` 按实测 14 → 7。
- 架构报告的后台作业清单（`backgroundDefinitions`）认出 `startInterval`（种类 `platform-interval`），8 处改走原语的计时照旧在清单里；
  `direct-setinterval-sites` 另按全局 `setInterval` 数，不受影响。
- 新增 `packages/backend/tests/rfc529-module-interval-timers-boundary.test.ts`，登记 guard-manifest：按语法树扫生产代码（语料下限 3,000），直接调全局
  `setInterval` / `clearInterval`（标识符或 `globalThis.` 取的）的文件与清单逐条相等——平台定时原语与 `platform/background` 的 4 个既有文件；
  每处 `startInterval` 的 `owner` 是字符串字面量；业务模块不声明 `ReturnType<typeof setInterval>`；带负对照。

## 3. 清单（退出门）

| 名字                                                       | 之后             |
| ---------------------------------------------------------- | ---------------- |
| 业务模块的 8 处直接 `setInterval` 与它们的 `clearInterval` | 改调平台定时原语 |
| `platform/background/intervalTimer.ts` 的 `startInterval`  | 新增             |
| 诊断 effect 端口、心跳的 `Map`                             | 不变             |

## 4. 用例

- ① 门与账本（D3）；② 原语的行为（用替身计时器）：就是 `setInterval(tick, everyMs)`，`stop` 只调一次 `clearInterval`、可重复调用，`unref` 转给
  句柄、停止后不再转，`owner` 原样交出；③ 改动处的行为由既有用例覆盖（MR 终止控制、MCP 诊断、预算告警、实时抓取、子调用、看门与心跳；
  监看全局定时器的被动装配用例照旧生效），读这些文件源码的锁随改。

## 5. 失败模式

- **改变频率或停止时机**：原语就是 `setInterval` / `clearInterval`，每处只换调用；用例覆盖。
- **用例的定时器替身失效**：原语在调用时取全局定时器。
- **漏掉一处**：门按语法树扫全部生产代码。

## 6. 取舍（可推翻）

1. **一个固定频率的原语，而不是把这些计时改成不重叠的周期作业**（`createManagedPeriodicJob`）：后者在上一轮跑完才重新布置，改变了频率语义；
   本 RFC 只收拢形状，不改行为。
2. **全部 8 处都走原语，而不是给执行局部计时另立登记表**：一种形状、一把锁；owner 名字随调用处给出。
3. **owner 不进全局表**：登记表本身就是模块级可变状态（S12 第 4 项要清的那类）。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合层不变。**C11**：public 不变。**C12**：RFC-529 用例覆盖全部生产代码的直接全局定时器。**C13**：计数不升，
  `direct-setinterval-sites` 按实测收紧。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 5 项：直接 `setInterval` 只出现在平台定时原语（含 `platform/background` 的既有几处），业务模块的周期计时都带 owner 与 stop。
- **留下**：S12 第 3、4、6 项。
