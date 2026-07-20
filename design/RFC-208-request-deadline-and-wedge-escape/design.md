# RFC-208 · 请求截止时间与卡死逃生口 —— design

## 0. 范围划分

本 RFC 覆盖同一个主题的两条工作线，二者独立可并行，但共享同一条验收原则
（**没有任何等待可以是无界的**）：

- **WS-A（前端）** —— 传输层截止时间 + 可发现的逃生口 + 失败分类修正。需要产品决策，是本 RFC
  的设计主体。
- **WS-B（后端）** —— daemon 侧无界等待与 semaphore permit 泄漏。**全部是纯 bug 修复**
  （同文件内已存在正确写法），不含产品决策；放在本 RFC 里只是为了让"卡死且只能重启"这一类
  有单一事实源。

## 1. 现状事实（全部经源码核对，非推测）

### 1.1 前端

| 事实 | 位置 |
| --- | --- |
| 四个请求入口无任何 deadline；`grep AbortSignal.timeout` 全仓 0 命中 | `api/client.ts:51,92,183,223` |
| `api` facade 每个动词都已透传可选 `signal` —— 天然的注入点 | `api/client.ts:243-259` |
| busy → 路由器全局导航拦截，且 busy 时隐藏 Discard，只剩「留下」 | `split/UnsavedChangesGuard.tsx:47,88` |
| 首次加载中挂起的 query 永远无法被取代（invalidate/refetch 返回同一 promise） | `query-core/query.js:186-194` |
| 未消费 `signal` 时卸载不 abort，重新导航回来仍是同一挂起 promise | `query-core/query.js:161-162` |
| mutation 层无 AbortController，`isPending` 不可取消 | `query-core/mutation.js` |
| ESC / overlay / × 由单一 `dismissDisabled` 一刀切 | `Dialog.tsx:140,260,280` |
| `ConfirmDialog` 的 pending 只在 `catch` 清、无 `finally` | `ConfirmDialog.tsx:62` |
| 「确定性失败」只认 4xx → 5xx 与传输失败被误判为"结果未知" | `lib/skill-composite-draft.ts:350` |
| outcomeUnknown 持有**持久** busy 令牌（绑 state 而非 promise） | `routes/skills.detail.tsx:141-152` |
| config 读被写队列 tail 挡住；挂起的 PUT 让读永不 reject → retry/isError 都不触发 | `lib/config-receipts.ts:209` |
| 全局 `useActor` 的 queryFn 未传 `signal` | `hooks/useActor.ts:44` |

**已证伪、不做**：`SkillVersionHistory.tsx:97` 的 `useEffect` 确实无 cleanup，但不可达 ——
`skills.detail.tsx:218` 的 `historyBlockedForNav` 有意排除 `restorePending`（`:827` 有注释
说明就是为了防这个），且 `TabPanels.tsx` 用 `hidden` 而非卸载。**不改。**

### 1.2 后端（P0 均已逐行核对）

| 事实 | 位置 |
| --- | --- |
| `releaseGlobal()` 排在无界 `await discardNodeIso` 之后 → permit 永久泄漏 | `services/scheduler.ts:1083-1089` |
| 同文件另三处顺序正确（先 release 再 await），证明是笔误非设计 | `scheduler.ts:3645`、`:5098`、`:5464` |
| `await persistIsoBase(...)` 裸露在 acquire 与 try/finally 之间；该函数抛异常有文档+测试锁定 | `scheduler.ts:2875` |
| `runGit` 无 timeout / 无 AbortSignal / 不 kill 子进程 | `util/git.ts:132-158` |
| `Semaphore.acquire()` 无超时、不感知 abort；`globalSem` 是 daemon 级共享 | `util/semaphore.ts:41-50`、`services/processNodeConcurrency.ts:12-21` |
| 启动探针不传 `timeoutMs` → 裸 `await proc.exited` | `cli/start.ts:85`、`util/opencode.ts:93-117` |
| plantuml 三段回退全是裸 `fetch()`，无 AbortSignal | `services/plantuml.ts:110,119,131` |
| merge agent 是唯一不传 `defaultPerNodeTimeoutMs` 的 runNode，且跑在 `writeSem` 内 | `scheduler.ts:2390-2421` |

**已证伪、不做**：plantuml 连接池耗尽假说在本机不成立 —— `plantumlEndpoint`
指向 `127.0.0.1:9999`，实测无进程监听、连接 0ms 被拒 → 立即 reject 而非挂起。该项按**潜在
风险**（配置成可连但慢的远端时才触发）修，不作为本次事故的解释。

## 2. WS-A 核心设计

### D1 —— 截止时间按"传输是否还在推进"分档，而不是一个总时长常数

> **设计门修正（Codex，见 §6-1）。** 本节初稿的论证是错的，保留原文教训：初稿主张
> "后端 `cli/start.ts:394` 的 Bun `idleTimeout: 255s` 是服务端天花板，故前端硬截止取 300s
> 便构造上不可能误杀，也就不需要白名单"。
> **错在把 `idleTimeout` 当成了请求总时长上限。** Bun 的 `idleTimeout` 量的是**空闲**
> （连接上多久没有字节流动），而 `AbortSignal.timeout` 量的是**总时长**。二者不可比。
> 反例已核实：`services/upload.ts:42` 的默认 `perRequest` 是 **200 MiB**，一个持续活跃但
> 带宽较低的上传可以远超 300s 而**从不空闲** —— 300s 总时长会在约 **5.6 Mbit/s** 以下
> 直接掐断合法上传。

因此改为按"这次请求的时长是否随载荷线性增长"分两档：

**档 A —— 固定截止（绝大多数请求）**
`CLIENT_HARD_DEADLINE_MS = 300_000`。适用于所有请求体/响应体大小有界的 JSON 接口。
对这一档，255s 的 `idleTimeout` 论证**仍然成立**——它们不可能因为"传得慢"而超时，只可能
因为"卡住"而超时。

**档 B —— 按载荷推导的截止（上传 / blob 下载）**
凡时长随字节数增长的调用（`apiPostMultipart`、`apiGetBlob`），截止时间由公式给出：

```
deadlineMs = BASE_MS + bytes / MIN_THROUGHPUT_BYTES_PER_MS
```

取 `BASE_MS = 60_000`、`MIN_THROUGHPUT ≈ 64 KiB/s`（即容忍 512 Kbit/s 的劣质链路）。
200 MiB 上限对应约 55 分钟，足够宽松；而**任何**大小的载荷都有界。

**为什么用公式而不是白名单**：白名单要人去维护、会漂移、漏一条就是一次误杀事故；公式的
输入（字节数）在调用点天然已知，新增上传接口自动继承正确行为，无需任何人记得登记。
这保留了初稿"不要白名单"的意图，但换了一个真正成立的机制。

**残留风险（诚实记录）**：档 B 仍是总时长而非真正的"无进展"检测。真正的 inactivity 语义
需要 `ReadableStream` 上传进度回调，浏览器对 `fetch` 上传侧支持不完整。公式档的宽松度
（55 分钟 / 200 MiB）使其在实践中等价于安全网，但它**不是**构造上不可误杀 —— 不得再
写出初稿那种绝对化断言。

### D2 —— 软阈值只做"可发现的出口"，不自动取消

`SOFT_HINT_MS = 10_000`。到达后**不做任何自动行为**，只把一个事实暴露给 UI 层：这次请求
已经超过 10s。UI 据此渲染"仍在处理…"与**取消**按钮。取消是用户动作，不是超时。

这样拆分的理由：自动取消无法区分"卡死"与"合法的慢"，而人可以。D1 负责有界性（正确性），
D2 负责体验，互不干扰。

### D3 —— busy 逃生口是知情选择，不是放宽默认

> **设计门补充（Codex，见 §6-6）**：逃生口**必须同时取消或作废那次 mutation**。
> 否则用户点了「仍要离开」、导航到 B 页，而在途请求随后成功 —— `agents.new.tsx:104-115`
> 的 `onSuccess` 依然会 `navigate` 到新建的代理，把用户从他自己选的目的地拽走
> （TanStack 的 mutation 回调在组件卸载后仍会执行）。故 T10 必须连带：abort 该请求，
> 并让迟到的 `onSuccess`/`onSettled` 的副作用（尤其是导航）失效。

`UnsavedChangesGuard` 当前 `if (busy) return true` 的安全语义**保留**。仅在软阈值到达后，
额外渲染一个「仍要离开」按钮，并配以明确文案（大意：这次写入的结果未知，离开后你看到的状态
可能与服务端不一致，建议稍后刷新确认）。软阈值之前，行为与今天**逐字节一致**。

被这条改动影响的既有锁定测试（`tests/unsaved-guard.test.tsx` 的 "busy mutation blocks even an
allowed section change and offers no discard"）必须**更新而非删除**，并在测试注释里写明
"为什么这条断言变了"，指回本 RFC。

### D4 —— 失败分类修正

> **设计门修正（Codex，见 §6-2）。** 初稿把整个 `status === 0` 归为"请求未被服务端接受、
> 安全重试"。**这是错的**：超时与 abort 完全可能发生在服务端已经收到并提交之后（响应在回程
> 丢失、或用户在提交后取消）。浏览器无法可靠区分"连接从未建立"与"已发出但响应丢失"。
> 把这些当作安全重试会跳过对账、放掉导航令牌，可能导致重复启动任务或状态分叉。

`isDefinitiveSkillWriteError` 的二分（4xx = 确定 / 其余 = 未知）确实过粗，但正确的切法不是
按 HTTP 状态，而是按**该请求是否幂等**：

| 分类 | 判据 | 语义 | 是否持有导航令牌 |
| --- | --- | --- | --- |
| `definitive` | 4xx | 服务端明确拒绝，客户端状态可信 | 否 |
| `retriable` | 传输失败 **且** 该调用幂等（GET / 显式声明幂等的写） | 重放无副作用 | 否 |
| `unknown` | 5xx，或**非幂等写**遇到传输失败 / 超时 / abort | 服务端可能已提交 | 是，但**有界且可解除** |

**真正解决用户那条 skills 卡死的，不是把它重分类为"安全"，而是让 `unknown` 不再等于
"永久"**：
- D1 保证等待有界（不会无限期停在 pending）；
- D3 在软阈值后提供知情逃生口；
- 既有的「重新检查」仍是首选恢复路径。

这样既修好了"保存技能时 daemon 重启 → 永久锁死"，又不会用"假装请求没落地"去换取解锁。

### D5 —— 让 react-query 的取消路径真正可用

给全局与关键 queryFn 补 `signal`（`useActor` 起步）。这不是可有可无的整洁性：如 §1.1 所述，
**未消费 `signal` 的 query 在卸载后重新导航回来仍是同一个挂起 promise**，补上 `signal` 才能
让"离开页面"真正成为一条恢复路径。

### 2.1 接口契约

```ts
// api/client.ts
export const CLIENT_HARD_DEADLINE_MS = 300_000 // 档 A：体积有界的 JSON 接口
export const SOFT_HINT_MS = 10_000
export const PAYLOAD_DEADLINE_BASE_MS = 60_000 // 档 B：BASE
export const PAYLOAD_MIN_BYTES_PER_MS = 64 // 档 B：≈64 KiB/s

/** 档 B 的纯函数——独立可测，新增上传接口自动继承。 */
export function payloadDeadlineMs(bytes: number): number {
  return PAYLOAD_DEADLINE_BASE_MS + Math.ceil(bytes / PAYLOAD_MIN_BYTES_PER_MS)
}

export interface RequestOptions {
  method?: string
  body?: unknown
  query?: Record<string, string | number | undefined>
  signal?: AbortSignal
  /** 覆盖截止。省略即按档 A / 档 B 自动推导。 */
  deadlineMs?: number
}
```

`apiPostMultipart` / `apiGetBlob` **必须**同样接受 `deadlineMs`，且默认走 `payloadDeadlineMs`
（初稿只给 `RequestOptions` 加了字段，multipart 入口没有覆盖手段——设计门 §6-1 指出的漏洞）。

内部统一构造：`AbortSignal.any([callerSignal, AbortSignal.timeout(deadlineMs)].filter(Boolean))`。
已验证 `AbortSignal.any` / `AbortSignal.timeout` 在 happy-dom 测试环境可用，**无需 polyfill**。

超时触发时 `fetch` 抛 `TimeoutError`（一种 `DOMException`）。`fetchOrNetworkError` 现有逻辑
把 `AbortError` 原样抛出、其余转 `network-unreachable`；需新增分支把 `TimeoutError` 映射为
**`ApiError(0, 'request-timeout')`**，并新增中英文案（与既有 `network-unreachable` 同一命名
空间，`resolveApiError` 自动复用）。

**deadline 必须同时覆盖 body 读取**：`res.json()` / `res.blob()` / `cappedErrorText` 的
reader 循环同样无界。实现上把同一个 signal 透传给这些读取（或在 signal abort 时
`res.body.cancel()`），否则"响应头到了、body 不结束"这条路径仍然漏。

### 2.2 失败模式

| 失败模式 | 结果 |
| --- | --- |
| 调用方自己的 signal 先 abort | 抛 `AbortError`（现状不变），不转成超时 |
| 硬截止先到 | `ApiError(0,'request-timeout')`，走既有错误呈现层 |
| 两者同时 | `AbortSignal.any` 取先到者；语义无歧义 |
| daemon 在 255s 掐断 socket | `fetch` reject → `network-unreachable`（**早于**我们的 300s，符合预期） |
| 合法 60s 的 `npm install` | 正常返回，不受影响（AC-5 覆盖） |

## 3. WS-B 设计（后端，纯 bug 修复）

| 编号 | 修法 | 依据 |
| --- | --- | --- |
| B1 | `scheduler.ts:1083` 改为**先** `releaseGlobal()` **再** `await discardNodeIso`，**并且**给 `discardNodeIso` 加截止/abort（见下方修正） | 与 `:3645` / `:5098` / `:5464` 三处对齐 |
| B2 | 把 `:2875` 的 `await persistIsoBase(...)` 移入带 `finally { releaseGlobal() }` 的保护区 | 与 `:743` / `:4943` / `:5336` 三处对齐 |
| B3 | `cli/start.ts:85`(+`:144`) 探针传 `timeoutMs`；**超时仍按探测失败 fail-closed**（释放锁并退出），不得改成继续监听 | `util/opencode.ts:93-117` 已支持 `timeoutMs` |
| B4 | `services/plantuml.ts:110/119/131` 三处 `fetch` 加 `AbortSignal.timeout` | 与 WS-A 同一原则 |
| B5 | `services/skill.ts:236` 的 `rmSync` 移入保护区，使 `abandonOperation` 必达 | 同 B1/B2 模式 |
| B6 | `gitRepoCache.ts:716` / `:812` **不能只套现有 `withTimeout`**（见下方修正） | `gitRepoCache.ts:56` |
| B7 | merge agent 的 `runNode` 补 `defaultPerNodeTimeoutMs` | 与其余四个调用点对齐 |

> **设计门修正（Codex，见 §6-3/6-4/6-5）——三条初稿修法不充分：**
>
> **B1：只调换顺序治标不治本。** 在 T-B1 那个"`discardNodeIso` 永不 settle"的故障下，
> 先 release 确实避免了 `globalSem` 耗尽，但 `runHostNode` 进而 `runTask` **仍然永不 resolve**，
> 任务永远留在 `activeTasks` 里 —— cancel / resume 依旧无效，还是只能重启 daemon。
> 故 B1 必须**同时**给清理路径加界：要么给 `discardNodeIso` 传截止时间并 kill 底层 git 子进程，
> 要么把它改成 lifecycle-safe 的 detached 清理（不阻塞 `runHostNode` 的 resolve）。
>
> **B3：初稿写"超时后继续启动到监听"是错的。** `cli/start.ts:81-111` 与
> `design/design.md:1369` 明确要求 opencode 运行时门禁 **fail-closed** —— 探测不通过就不该启动。
> 继续监听等于对外提供一个跑不了必需运行时的 daemon。正确修法：**限时，但超时仍然
> 释放 PID 锁并退出**（这已经修好了原症状：原缺陷是"拿着锁无限等待、连重启都救不回来"，
> 而不是"退出得太早"）。fail-open 只对可选的 Claude 探针适用。
>
> **B6：现有 `withTimeout`（`gitRepoCache.ts:56`）只是 `Promise.race`。** 它 reject 之后
> **不杀 `runGit` 子进程、不释放 per-URL 串行队列**；更糟的是 delete 路径里的 `rmSync` 是
> **同步**的，会阻塞 Bun 事件循环 —— 定时器根本没机会触发，超时形同虚设。故 B6 必须换成
> **可 kill 的 git 调用 + 异步文件删除**，而不是在外面裹一层 race。

B1/B2 是本 RFC 里唯二"用户完全无感、但一旦发生就必须重启 daemon"的项，优先级最高。

## 4. 与现有模块的耦合点

- **RFC-203 错误呈现层**：新增的 `request-timeout` 码走既有 `resolveApiError` 通道，
  不新建呈现路径。
- **`ResourceSplitPage` busy 令牌**：D2/D3 需要把"软阈值已到"这个事实传到守卫。倾向在
  `beginBusy` 的返回值/上下文里带一个起始时间戳，由守卫自行判断，**不新增全局状态容器**。
- **`config-receipts` 单例**：D1 生效后，挂起的 PUT 会在 300s 后 reject，写队列 tail 随之
  settle，设置页自动恢复 —— 该项**不需要单独改动**，是 D1 的下游收益。

## 5. 测试策略（每条都必须有）

| 编号 | 用例 | 类型 |
| --- | --- | --- |
| T-1 | mock 永不 settle 的 fetch + 假时钟 → `apiRequest` 在硬截止 reject 为 `ApiError(0,'request-timeout')` | 单元 |
| T-2 | 同上，但**只有 body 不结束**（响应头已到）→ 同样 reject | 单元（专防 §2.1 那条漏网） |
| T-3 | `CLIENT_HARD_DEADLINE_MS > cli/start.ts` 的 `idleTimeout` × 1000 | 跨包不等式锁（AC-2） |
| T-4 | 调用方 signal 先 abort → 仍抛 `AbortError` 而非超时 | 单元 |
| T-5 | 创建代理 + 永不 settle fetch → 到点后表单解冻、草稿仍在、可再次提交 | 集成（用户层） |
| T-6 | 软阈值后渲染取消按钮；点击真的 abort 且 UI 立即恢复 | 集成 |
| T-7 | busy 守卫在软阈值后出现「仍要离开」并可导航；之前只有「留下」 | 集成（需更新既有锁定测试） |
| T-8 | `ConfirmDialog` 请求 reject 后四个出口恢复可用 | 集成 |
| T-9 | 失败分类三分表逐行断言，重点：`status 0` **不**置 outcomeUnknown | 单元（纯函数） |
| T-10 | `useActor` 的 queryFn 消费了 `signal` | 单元 |
| T-11 | 档 B：`payloadDeadlineMs(200 MiB)` 远大于 300s；纯函数逐点断言 | 单元（防 §6-1 复发） |
| T-12 | 200 MiB 的 multipart 在慢速但持续活跃的链路上**不被**掐断 | 单元（假时钟） |
| T-13 | 非幂等写遇超时 → 归 `unknown`（**不**归 retriable） | 单元（防 §6-2 复发） |
| T-14 | ZIP 导入 commit（走私有 `authedFetch`）挂起 → busy 令牌仍在有界时间内释放 | 集成（防 §6-7） |
| T-15 | 点「仍要离开」后，迟到的 `onSuccess` **不得**再触发导航 | 集成（防 §6-6） |
| T-B1 | 注入一个永不 settle 的 `discardNodeIso` → permit 仍归还，**且 `runTask` 仍能 resolve / 可被 cancel** | 后端单元（先红后绿） |
| T-B2 | 注入抛异常的 `persistIsoBase` → permit 仍归还（先红后绿） | 后端单元 |
| T-B3 | 探针挂起 → daemon **释放 PID 锁并退出**（不是继续监听），且不无限等待 | 后端集成（按 §6-4 修正） |
| T-B4 | git 缓存 refresh 超时 → 底层 git 子进程**确实被 kill**、串行队列被释放 | 后端单元（防 §6-5） |

T-B1 / T-B2 需要对 `globalSem` 的可用 permit 数做断言 —— 目前**该处零测试覆盖**，属于本 RFC
新增的回归网。

## 6. 设计门修正记录（Codex，2026-07-20，RFC 提交 `d4f0b293`）

初稿的七处问题，全部经本地源码核对属实后修正。逐条留档，防止后续 session 把已被否掉的
方案重新提出来：

1. **`idleTimeout` ≠ 请求总时长上限** —— 初稿据此得出的"300s 构造上不可能误杀、无需白名单"
   是错的。反例已核实：`services/upload.ts:42` 默认 `perRequest` = 200 MiB，慢速但活跃的上传
   从不空闲。→ D1 改为固定档 + 载荷推导档；`apiPostMultipart` 补 `deadlineMs`。
2. **`status === 0` 不等于"请求没落地"** —— 超时/abort 可能发生在服务端已提交之后。
   → D4 改为按**幂等性**切分；靠"让 unknown 不再永久"而非"重分类为安全"来解锁。
3. **B1 只调换 release 顺序不够** —— permit 是救回来了，但 `runTask` 仍永不 resolve，
   任务卡在 `activeTasks`，依旧只能重启。→ 必须同时给清理路径加界或改 detached。
4. **B3 不能改成 fail-open** —— opencode 探针是必需运行时门禁（`start.ts:81-111`、
   `design/design.md:1369`）。→ 限时但仍 fail-closed（释放锁 + 退出）。
5. **现有 `withTimeout` 只是 `Promise.race`** —— 不杀子进程、不释放队列；且 delete 路径的
   同步 `rmSync` 会阻塞事件循环使定时器无法触发。→ 需可 kill 的 git + 异步删除。
6. **逃生口必须取消/作废 mutation** —— 否则迟到的 `onSuccess` 会把用户从他选的目的地拽走。
7. **裸 `fetch` 边界绕过全部四个入口** —— `ImportZipPanel` 的私有 `authedFetch` 已核实：
   parse 路径（`:183`）传了 `signal`、commit 路径没传，却握着 busy 令牌。→ PR-2 必须先做
   裸 fetch 边界盘点再改。
