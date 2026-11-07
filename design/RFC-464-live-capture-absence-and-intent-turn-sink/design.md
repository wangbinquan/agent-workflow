# RFC-464 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`，`L/` = `S/services/`，`RM/` = `S/modules/runtime-management/`，
`TE/` = `S/modules/task-execution/`，`IN/` = `S/modules/intent/`。

## 0. 架构落位（RFC-294 第 8 条）

- RFC-294 plan §4.6 W9-D：`services/` 实现文件按 owner 归位，运行时驱动一族先重画 task-execution ↔ runtime-management 的驱动接缝。本 RFC 收
  驱动接缝上两处「借道」：task-execution 借 opencode 驱动的 no-op 句柄去补 runtime-management 合同里的可选能力；intent 经 `services/` 取
  runtime-management 的会话事件合同（intent → runtime-management 不是目标 DAG 给的边）。
- 两处都只改消费方：task-execution 按 runtime-management 合同的原意处理可选能力；intent 在自己的端口里声明它实现的 sink 合同（消费方拥有
  端口，依赖倒置），不新增任何 context 边。

## 1. task-execution：无实时捕获按缺席处理

`TE/application/taskAgentRun.ts`：

```ts
const livePoller = materialEvidence.startLiveCapture?.({ … })   // 原：… ?? NOOP_HANDLE
spawnedCleanupHooks.push(() => livePoller?.stop())              // 原：livePoller.stop()
…
liveCtrl.abort()
livePoller?.stop()                                              // 原：livePoller.stop()
…
await materialEvidence.captureSessions({
  …,
  ...(livePoller === undefined
    ? {}
    : { alreadyInsertedPartIds: livePoller.stats().insertedPartIdsBySession }),
})
```

删去 `import { NOOP_HANDLE } from '@/services/runtime'`，就近注释改写（RFC-143 的「claude 省略 `startLiveCapture`」现在意味着不起捕获）。
行为：有 `startLiveCapture` 的驱动（opencode，含 `pollMs === 0` 时它自己返回的关停句柄）一切照旧；没有的驱动（claude、托管执行）原先拿 no-op
句柄、`stop()` 空转、给会话捕获传一张空去重表，现在不 stop、不传。去重表唯一的读者是 opencode 的会话捕获
（`alreadyInsertedPartIds?.get(sess.id)`，缺席与空表等价，`session-capture-sqlite` 有「省略即 RFC-027 字节级行为」的用例）；
runtime-management 的本地材料证据只在请求带了该键时转发（`'alreadyInsertedPartIds' in request`）。

`L/runtime/index.ts` 删去 `export { NOOP_HANDLE } from './opencode/subagentLiveCapture'`（唯一的使用者就是上面那处）；opencode 驱动自己的
`NOOP_HANDLE`（`pollMs === 0` 的关停路径）与直接从 `subagentLiveCapture` 取它的用例不变。`L/runtime/types.ts` 里 `startLiveCapture?` 的注释
「claude omits this → runner uses NOOP_HANDLE」改写为不起捕获。

## 2. intent：自持轮次事件 sink 合同

`IN/application/ports/intentSystemAgent.ts` 新增（类型全部由同目录 `intentPersistence.ts` 的记录类型派生）：

```ts
/** 轮次捕获的终态与未完成原因（持久化端口的 `captureState` / `captureIncompleteReason`）。 */
export type IntentTurnCaptureTerminalState = Exclude<
  IntentTurnRecord['captureState'],
  'live' | null
>
export type IntentTurnCaptureIncompleteReason = NonNullable<
  IntentTurnRecord['captureIncompleteReason']
>
/** 系统代理运行观测到的一条事件，即轮次事件日志落库的那几个字段。 */
export type IntentTurnObservedEvent = Pick<
  IntentTurnEventRecord,
  'ts' | 'kind' | 'payload' | 'sessionId' | 'parentSessionId' | 'source'
> & {
  readonly externalEventId?: string
}
/** 轮次交给系统代理运行的事件 sink（只观测，不影响业务结果）。 */
export interface IntentTurnEventSink {
  append(event: IntentTurnObservedEvent): Promise<void>
  markRootSessionResetPending?(sessionId: string): Promise<void>
  setRootSessionId(sessionId: string, previousSessionId?: string): Promise<void>
  markTerminal(
    state: IntentTurnCaptureTerminalState,
    reason?: IntentTurnCaptureIncompleteReason,
  ): Promise<void>
}
```

`IntentSystemAgentRunRequest.eventSink` 改为 `IntentTurnEventSink`，删去对 `../turnSession` 的反向 import。`IN/application/turnSession.ts`：
`IntentTurnSessionEventSink implements IntentTurnEventSink`，`append` 的参数与终态记忆的类型改用上面的形状，删去取 `@/services/sessionEventSink`
的 import；行为不变（落库字段一一对应原样）。

与 runtime-management 合同的一致性：装配根把 task-execution 的系统代理运行族（要 `SystemAgentEventSinkV1`）接给 intent 的端口，赋值检查对方法是
双变的，锁不住参数收窄。RFC-464 用例按函数类型逐项锁：两个联合类型与 `SessionCaptureTerminalState` / `SessionCaptureIncompleteReason` 双向相等，
`source` 与 `SessionEventSource` 双向相等，`IntentTurnEventSink` 的四个成员作为函数类型可赋给 `SystemAgentEventSinkV1` 对应成员（严格函数类型
下参数逆变：runtime-management 发来的事件 intent 都收得下）。

## 3. 用例与锁

- **新用例** `T/rfc464-live-capture-absence-and-intent-turn-sink.test.ts`：`taskAgentRun` 不取 `@/services/runtime`、源码不含 `NOOP_HANDLE`、
  两处 `stop()` 是可选调用、去重表只在有句柄时带上（census AST + 源码锚点，带负对照）；intent application 零取 `@/services/`、端口不取
  `../turnSession`；上节的编译期合同锁；行为：没有 `startLiveCapture` 的材料证据下，会话捕获请求不带 `alreadyInsertedPartIds`（源码锚点）。
- 改指的锁：`rfc143-runtime-driver-capability` 的「`?? NOOP_HANDLE` 兜底」改为「缺席不起、可选 stop」；`subagent-live-capture-source` 的
  `liveCtrl.abort()` → `livePoller.stop()` 顺序锚点改为可选调用（去重表转发锚点不变）；`rfc454` 钉的 `services/sessionEventSink` 生产消费方精确
  清单删去 intent `turnSession`。
- 账本：`commons-debt.json` 的 `R2` 2 条按实测销账；钉住「还剩下的」的用例与精确清单按全量守卫实测同批更新；guard-manifest 按实测刷新。

## 4. 留下的债

- `R2` 余 1 条：runtime-management `agentMaterialEvidence` 取会话捕获 / 清扫上下文（带 task-execution 的会话捕获持久化端口）。下一步先把
  会话捕获持久化端口的归属定下来（runtime-management 定义捕获写入的端口、task-execution 实现），随后驱动一族归 runtime-management。

## 5. 失败模式

- 实时捕获缺席的分支改形：`stop()` 原本对 no-op 句柄是空转，改为可选调用不改变可观测行为；去重表只有 opencode 读，缺席与空表等价。
- intent sink 合同漂移：runtime-management 若给终态、未完成原因或事件来源加了值，RFC-464 用例的双向相等在编译期红，intent 的持久化形状要
  同步扩（这正是该锁的用意）。

## 6. 测试策略

受影响用例全部复跑（SQLite 全量 + PostgreSQL 受影响面）；新用例见 §3；P0 变异 lane 两引擎各 17 阶段。
