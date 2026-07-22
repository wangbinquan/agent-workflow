# Codex Adversarial Review

Target: branch diff against 194f067d
Verdict: needs-attention

NO-SHIP：RFC-208 的关键不变量仍未闭环。前端仍有永久 busy、迟到导航和重复任务入口；后端 permit、URL 队列与 PID 锁仍存在无界等待。现有测试多为源码字符串断言，未覆盖这些真实故障链。

Findings:
- [high] 隔离创建仍可永久占用 daemon 级 permit (packages/backend/src/services/scheduler.ts:731-748)
  触发路径：取得 globalSem 后进入 createIsoUnderLock；其下游 isGitWorkTree、snapshotFullState、createIsolatedWorktree 和 submodule 更新均调用未设 timeout 的 runGit。网络文件系统或子模块黑洞时不会抛错，因此 catch 永远无法执行，globalSem 与 writeSem 一直被占用，容量耗尽后全 daemon 停摆。另一路径中 persistIsoBase 在 iso 已创建后抛错时，这个 catch 直接返回且不 discard，留下 worktree/ref；重试可能撞上同一路径。当前测试只检查 try 的源码结构，无法发现 pending 不 settle 或残留资源。
  Recommendation: 给整个 iso setup 传递统一 deadline/signal，并把所有 snapshot/worktree/submodule git 调用纳入剩余预算；使用外层 finally 释放 permit，并清理已创建及半创建的 worktree、ref、临时 index。增加注入永不 settle 的 createIso 和抛错 persistIsoBase 的行为测试。
- [high] Git 缓存只限制了主 fetch/clone，URL 队列仍可永久卡住 (packages/backend/src/services/gitRepoCache.ts:397-478)
  warm 路径在受限 fetch 前执行无 timeout 的 isValidGitDir，之后的 classifyBaseRef、syncBranchToRemote、listAvailableRefs 与 syncSubmodules 同样无界；manual refresh 的 submodule、cold clone 后的默认分支探测也未受限，delete 的 await rm 亦无 deadline。它们都位于 withUrlLock 内，而外层 withTimeout 只是 Promise.race，不会取消 work，因此超时响应后同 URL 队列仍被占用。并且实际任务启动在 task.ts:561-593 未传 cloneTimeoutMs，配置只接到了手动 refresh。
  Recommendation: 在线程内传递一个总 deadline/signal，覆盖校验、ref、submodule、clone 后探测和删除，并保证超时后 queue turn 真正结束；把 gitCloneTimeoutMs 加入 StartTaskDeps 并传给两次 resolveCachedRepo。用挂起 submodule、post-clone probe、rm 和后继同 URL 请求做行为测试。
- [high] Claude 默认运行时探针仍会持 PID 锁无限等待 (packages/backend/src/cli/start.ts:163-165)
  daemon 已取得单实例锁后，如果 defaultRuntime 为 claude-code，会调用未传 timeoutMs 的 ccDriver.probe。该 probe 只有收到 timeoutMs 才启用 detached 进程组与 kill；挂起的 PATH wrapper 会让启动永远到不了 listen，同时后续 start 只会看到锁已占用。PR-5 测试只源码匹配 opencode 与 git，漏掉了同形状的第三个启动探针。
  Recommendation: 向 Claude probe 传 BOOT_PROBE_TIMEOUT_MS，并在超时后按既有 soft-probe 语义告警后继续；增加真实挂起 probe 的启动测试，断言不会长期持锁。
- [high] 已知 ZIP commit 仍绕过截止时间并永久持有 busy (packages/frontend/src/components/skills/ImportZipPanel.tsx:222-260)
  onCommit 先取得 split-page busy token，再调用私有 authedFetch；该 helper 是裸 fetch，既无 deadline 也无 signal，随后 res.json() 也无 body deadline。半开连接时 finally 永不执行，busy token 永不释放，且 skills.new 传入的 beginBusy 没有 abort handle。这正是 RFC 明列的 T-14 路径，但新增请求测试没有覆盖它。
  Recommendation: 改走 apiPostMultipart，传入可由 operation handle 触发的 AbortController，并让响应体共享同一截止时间；增加 never-settling fetch 与 headers-only body 测试，断言 abort 生效、token 释放且无迟到副作用。
- [high] 共享 operation handle 未实现，旧新令牌竞态与非 split 守卫仍未解锁 (packages/frontend/src/components/split/ResourceSplitPage.tsx:153-184)
  令牌实际只有 {startedAt, abort?}，没有 RFC 要求的 generation；阈值使用整段 busySince，而 abortBusy 会取消 Map 中所有令牌。旧令牌超过 10s 后若新令牌刚开始，用户会误 abort 新操作。除 agents.new 外，beginBusy 调用方均未提供 abort，force-leave 却仍无条件 proceed，迟到的 skills/MCP/plugin onSuccess 可再次导航。更严重的是 SettingsDraftProvider 与 workgroups.detail 把 outcomeUnknown 设为 busy，却不给守卫 busySince/onForceLeave，因此这些持久未知状态永远不会出现逃生按钮。
  Recommendation: 实现并贯通非可选的 {startedAt, abort, generation} 操作句柄；按具体 token 判断软阈值，只取消被确认的代，并让所有 onSuccess/onSettled 在副作用前校验 generation。覆盖 settings、workgroup、重叠旧/新 token 和迟到导航测试。
- [high] 任务创建超时后直接允许重试，可产生重复任务 (packages/frontend/src/routes/tasks.new.tsx:832-865)
  三类任务启动都是非幂等 POST，但 mutation 没有 idempotency key、outcome-unknown 状态或提交后对账；请求超时后 isPending 变回 false，同一 Launch 按钮立即可再次 mutate。服务端若已创建任务而响应丢失，重试会启动第二个任务。大 multipart 更容易合法触发：payloadDeadlineMs 使用 max(300s, 60s + bytes/64)，在最低允许吞吐下只给上传完成后的仓库解析、冷 clone 与 worktree 创建留下 60s，而该服务工作可以合法超过 60s。
  Recommendation: 为创建任务生成稳定的客户端请求 ID，并在后端建立唯一幂等约束；超时后先按该 ID 对账，再允许重试。将载荷预算改为固定处理预算加传输预算，并加入慢速持续上传、延迟服务处理及“提交成功但响应丢失”测试。
- [medium] runGit 的 timeout 仍会留下孤儿进程和管道读取 (packages/backend/src/util/git.ts:169-199)
  定时器只在 deadline 到达时杀进程组。如果直接 git/wrapper 先退出，但后台子进程仍持有 stdout/stderr，250ms 的 Promise.race 会返回 fallback，finally 随即清除尚未触发的 kill 定时器；后台子进程及两个败选的 Response.text() 继续存活并持有 FD。反之，若直接子进程在 SIGKILL 后仍未 reap，代码会无限等待 proc.exited。重复触发可累积孤儿/FD，甚至让所谓有界调用继续卡死。
  Recommendation: 复用 runner 的进程治理：设置独立 reap deadline、可取消的流 pump、超时后 unref，并在直接子进程退出但管道未 EOF 时清理剩余进程组。测试 wrapper 后台化并持有管道，以及 proc.exited 不 settle 的注入 seam。
- [medium] 10 秒逃生按钮不会随时间自动出现 (packages/frontend/src/components/split/UnsavedChangesGuard.tsx:90-98)
  stalled 直接在 render 中读取 Date.now()，没有 timer 或状态在阈值到达时触发重渲染。用户在请求开始后立即尝试导航时会看到只有“留下”的弹窗；若请求永不 settle，等待超过 10s 也不会出现逃生按钮，除非偶然发生其他渲染或用户先关闭再重试。现有测试只用已过期的 busySince 初始化，未推进时钟验证按钮出现。
  Recommendation: 按剩余阈值设置可清理的 timer/state，并在 token 变化时重算；使用假时钟测试弹窗在 fresh 状态打开后，到 10s 自动出现出口。
- [medium] ConfirmDialog 的命名逃生路径完全未落地 (packages/frontend/src/components/ConfirmDialog.tsx:62-107)
  确认开始后 requestClose 直接返回，同时 Dialog 的 ESC/overlay/关闭按钮及 Cancel/Confirm 全部被 pending 禁用。没有 AbortController、软阈值取消，也没有 finally 清理；网络调用会把焦点陷阱锁到硬截止，任何未走统一 client 的 Promise 仍可永久锁住。这与 RFC 的 US-3、AC-5 和 T-13 直接冲突。
  Recommendation: 为可取消确认操作提供 signal/operation generation，在软阈值后恢复明确的取消出口，并在 finally 中清理 pending；非幂等操作取消后进入 outcome-unknown。增加永不 settle、abort/reject 和迟到 resolve 的集成测试。

Next steps:
- 先将 RFC-208 从 Done 回退并修复上述高优先级路径；不要以增加源码字符串断言代替故障注入测试。
- Question：PR-4 是否有意只接入 skills.detail？当前 classifyWriteOutcome(idempotent: true) 没有生产调用，而任务、创建、删除和升级仍缺少逐入口幂等性登记。
- Question：生产支持范围是否保证 git/ssh/credential wrapper 不会后台化或调用 setsid？若无此保证，runGit/spawnGit 必须按不可信进程树实现 bounded reap 与 FD 清理。

Codex session ID: 019f8759-51c8-7551-81c3-5acd910c51cb
Resume in Codex: codex resume 019f8759-51c8-7551-81c3-5acd910c51cb
