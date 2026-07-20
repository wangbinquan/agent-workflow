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
| RFC-208-T9 | `beginBusy` 返回值带起始时间戳，供守卫判断软阈值 | PR-2 | 不新增全局状态容器 |
| RFC-208-T10 | `UnsavedChangesGuard` 软阈值后渲染「仍要离开」+ 风险文案；**点击时必须 abort/作废该 mutation 并让迟到的 `onSuccess` 导航失效** —— 设计门 §6-6 | T9 | T-7, T-15 |
| RFC-208-T11 | **更新**（非删除）`tests/unsaved-guard.test.tsx` 的既有锁定断言，注释写明为何改变并指回本 RFC | T10 | 旧意图可追溯 |
| RFC-208-T12 | 冻结中的表单/弹窗渲染取消按钮，接入 T4 的 signal | PR-2 | T-6 |
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
| RFC-208-T17 | 启动探针传 `timeoutMs`；超时**仍 fail-closed**（释放 PID 锁并退出），**不得**改成继续监听 —— 设计门 §6-4。修的是「拿着锁无限等待、重启也救不回来」，不是「退出得太早」 | — | T-B3 |
| RFC-208-T18 | `services/plantuml.ts` 三处 `fetch` 加 `AbortSignal.timeout` | — | 端点黑洞时快速失败 |
| RFC-208-T19 | `services/skill.ts:236` 的 `rmSync` 移入保护区 | — | 抛异常后锁仍释放 |
| RFC-208-T20 | `gitRepoCache.ts:716`/`:812` 改为**可 kill 的 git + 异步文件删除**；现有 `withTimeout`（`:56`）只是 `Promise.race`，不杀子进程、不释放队列，且同步 `rmSync` 会阻塞事件循环使定时器无法触发 —— 设计门 §6-5。顺带接上死配置 `gitCloneTimeoutMs` | — | T-B4 |
| RFC-208-T21 | merge agent 的 `runNode` 补 `defaultPerNodeTimeoutMs` | — | 与其余四处对齐 |

## PR 拆分建议

**建议按 PR-1 → PR-2 → PR-4 → PR-3 → PR-5 顺序落地。**
PR-3（逃生口）排在后面是因为它是唯一推翻既有安全语义的一步，且 PR-2 落地后
「无限期 busy」这个前提本身就消失了（最长 5 分钟），逃生口从"必需"降级为"体验优化"——
届时可以重新评估是否还值得做，或只保留取消按钮（T12）而不动守卫（T10/T11）。

**这是一个真实的决策点，实现到那一步时应再确认一次，而不是照本执行。**

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
