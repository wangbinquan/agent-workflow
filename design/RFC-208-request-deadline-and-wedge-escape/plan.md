# RFC-208 · 请求截止时间与卡死逃生口 —— plan

## 任务分解

### PR-1 · 后端 permit 泄漏（最高优先，用户无感但必须重启才能恢复）

| 编号 | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| RFC-208-T1 | `scheduler.ts:1083` 先 `releaseGlobal()` 再 `await discardNodeIso`，与 `:3645`/`:5098`/`:5464` 对齐；**并给清理路径加界**（限时 + kill git 子进程，或改 detached），否则 `runTask` 仍永不 resolve —— 设计门 §6-3 | — | T-B1 先红后绿（含 `runTask` 可 resolve / 可 cancel） |
| RFC-208-T2 | `scheduler.ts:2875` 的 `await persistIsoBase(...)` 移入带 `finally { releaseGlobal() }` 的保护区 | — | T-B2 先红后绿 |
| RFC-208-T3 | 新增 `globalSem` permit 计数的回归网（该处目前零覆盖） | T1,T2 | 注入挂起/抛异常两种故障后可用 permit 数回到初值 |

**为什么独立成 PR**：这两条是纯顺序修正，改动面小、风险低、收益最大，不应被 WS-A 的
产品讨论阻塞。

### PR-2 · 前端传输层截止时间

| 编号 | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| RFC-208-T3b | **前置**：盘点全部绕开 `api/client.ts` 的裸 `fetch` 边界（已知 `ImportZipPanel` 私有 `authedFetch`，commit 路径无 signal 却握 busy 令牌），产出清单 —— 设计门 §6-7 | — | 清单进 design §1.1；无遗漏才可开 T4 |
| RFC-208-T4 | `api/client.ts` 引入档 A 常数 + `payloadDeadlineMs()` 纯函数 + `deadlineMs` 选项；四个入口统一 `AbortSignal.any([caller, timeout])`；`apiPostMultipart`/`apiGetBlob` 走档 B | T3b | T-1, T-4, T-11, T-12 |
| RFC-208-T4b | 把 T3b 盘出的裸 fetch 边界并入统一入口（或至少接上同一套截止/signal） | T3b,T4 | T-14 |
| RFC-208-T5 | deadline 覆盖 body 读取（`res.json` / `res.blob` / `cappedErrorText`） | T4 | T-2 |
| RFC-208-T6 | `TimeoutError` → `ApiError(0,'request-timeout')` + 中英文案 | T4 | 错误横幅显示本地化文案 |
| RFC-208-T7 | 跨包不等式锁：硬截止 > daemon `idleTimeout`×1000 | T4 | T-3 |
| RFC-208-T8 | 用户层集成：创建代理遇永不 settle 的 fetch → 到点解冻、草稿不丢 | T4-T6 | T-5 |

### PR-3 · 逃生口（产品行为变更，需最谨慎）

| 编号 | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| RFC-208-T9 | 定义共享**操作句柄** `{startedAt, abort(), generation}` 并**贯通所有守卫调用方**（含不走 `beginBusy` 的 `SettingsDraftProvider` / `workgroups.detail`）。仅加时间戳不可实现 T10/T15 —— 设计门 §6-10 | PR-2 | 守卫能 abort 请求并作废迟到回调 |
| RFC-208-T9b | **前置**：逐个登记可取消的 mutation 及其**幂等性**；非幂等面若无对账/幂等键则**不提供取消按钮** —— 设计门 §6-11 | — | 清单进 design；无清单不得开 T12 |
| RFC-208-T10 | `UnsavedChangesGuard` 软阈值后渲染「仍要离开」+ 风险文案；**点击时必须 abort/作废该 mutation 并让迟到的 `onSuccess` 导航失效** —— 设计门 §6-6 | T9 | T-7, T-15 |
| RFC-208-T11 | **更新**（非删除）`tests/unsaved-guard.test.tsx` 的既有锁定断言，注释写明为何改变并指回本 RFC | T10 | 旧意图可追溯 |
| RFC-208-T12 | 冻结中的表单/弹窗渲染取消按钮，接入 T4 的 signal。**非幂等 mutation 取消后进 outcome-unknown，不得呈现为"已取消可随便重试"** —— 设计门 §6-11 | PR-2, T9b | T-6；重复启动任务的路径必须被用例排除 |
| RFC-208-T13 | `ConfirmDialog` pending 移入 `finally`；请求终结后四出口恢复 | — | T-8 |

### PR-4 · 失败分类与 signal 补齐

| 编号 | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| RFC-208-T14 | 失败分类按**幂等性**切分（definitive / retriable / unknown）；**非幂等写的超时/abort 仍归 unknown** —— 设计门 §6-2 | — | T-9, T-13 |
| RFC-208-T15 | 接线：`skills.detail` 让 unknown **有界且可解除**（而非重分类为安全） | T14, PR-2, PR-3 | 保存时 daemon 重启不再永久锁死，且不跳过对账 |
| RFC-208-T16 | `useActor` 等全局 queryFn 补 `signal` | — | T-10 |

### PR-5 · 后端其余无界等待

| 编号 | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| RFC-208-T17 | opencode **与 git** 两个启动门禁都传 `timeoutMs`（`gitVersion.ts:92` 的 `runGit(['--version'])` 同样无超时且在持锁期间执行 —— 设计门 §6-12）；超时**仍 fail-closed**（释放 PID 锁并退出），**不得**改成继续监听 —— 设计门 §6-4。修的是「拿着锁无限等待、重启也救不回来」，不是「退出得太早」 | — | T-B3, T-B5 |
| RFC-208-T18 | `services/plantuml.ts` 三处 `fetch` 加 `AbortSignal.timeout` | — | 端点黑洞时快速失败 |
| RFC-208-T19 | `services/skill.ts:236` 的 `rmSync` 移入保护区 | — | 抛异常后锁仍释放 |
| RFC-208-T20 | git 缓存四条路径统一改为**可 kill 的 git + 异步文件删除**：手动 `refresh`(`:716`) / `delete`(`:812`) **以及 `resolveCachedRepo` 的 warm fetch 与 cold clone**（真正用着 `withTimeout` 的是它，且两者同在一个 URL 队列内 —— 设计门 §6-13）。现有 `withTimeout`（`:56`）只是 `Promise.race`，不杀子进程、不释放队列，且同步 `rmSync` 会阻塞事件循环使定时器无法触发 —— 设计门 §6-5。顺带接上死配置 `gitCloneTimeoutMs` | — | T-B4（四条路径各一条） |
| RFC-208-T21 | merge agent 的 `runNode` 补 `defaultPerNodeTimeoutMs` | — | 与其余四处对齐 |

## PR 拆分建议

**建议按 PR-1 → PR-2 → PR-4 → PR-3 → PR-5 顺序落地。**
PR-3（逃生口）排在后面是因为它是唯一推翻既有安全语义的一步。

> **⚠️ 初稿在此写了「PR-2 落地后逃生口可降级为体验优化，届时可重新评估是否还做」——
> 该判断已被设计门二轮否掉（§6-3 的同类错误）。**
> 原因：`skills.detail.tsx:138-149` 的 `outcomeUnknown` 令牌是在**网络 promise 已经
> settle 之后**另行获取的，只有一次稳定对账才释放 —— **PR-2 的截止时间对它完全不起作用**。
> 跳过 T10/T11 会原封不动地保留本 RFC 要修的那个实例。
>
> 故：**逃生口（或等价的"有界令牌释放"机制）是 T15 的必需验收项，不是可选项。**

## 未纳入本 RFC 的 backlog

均已确认为真但属独立主题，另行立项：

- WS 层无心跳/失活探测（半开 TCP → 实时推送静默死亡；20+ 处轮询兜底，属降级）
- dev 模式 daemon 换端口使 vite 代理指向死端口（`cli/start.ts:380` 的 `?? 0` +
  `vite.config.ts:75` 一次性解析）。**已核实 vite 快速回 500 而非挂起**；给 `config.json`
  加固定 `bindPort` 即可，属独立小改
- `util/git.ts:1155` 每个 untracked 文件一个 `git diff --no-index` 子进程，无上限
- `ws/registry.ts:288` 的 `?since=N` 回放无上界
- `claudeCode/config.ts:60` 的 `Bun.spawnSync` keychain 调用阻塞 event loop
- 全局无 `unhandledRejection` / `uncaughtException` handler
- `gc.ts:432` / `eventsArchive.ts:217` 的 `loadConfig()` 在 try 之外求值
- 关停竞态（`cli/start.ts:600` vs `cli/stop.ts:52`），dev `--watch` 下高频

## 总验收清单

- [ ] AC-1 … AC-8（见 proposal）逐条对应到上表任务
- [ ] `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿
- [ ] CI：单二进制 build smoke + Playwright e2e 不红
- [ ] 后端全量 `bun test`（不只定向子集）
- [ ] Codex 复审两道门：RFC 文档写完（设计门）、代码改完（实现门）
- [ ] `design/plan.md` 的 RFC 索引登记；`STATE.md` 顶部「进行中 RFC」→ 完工后翻 Done
