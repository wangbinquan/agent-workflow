# Codex Adversarial Review

Target: branch diff against b7cacf4c
Verdict: needs-attention

NO-SHIP：当前实现存在多条在 enforce 下仍可触发的凭据泄露、跨任务读取和未沙箱化执行链；三态切换与 G1 网络 Git 也未闭环。

Findings:
- [critical] P0 — enforce 既不实时生效，也会在 resume/retry 上静默裸跑 (packages/backend/src/services/sandbox/index.ts:26-36)
  `sandboxActive` 将 enforce+unavailable 与 warn+unavailable 一样判为 false，`wrapSandbox` 随即返回原命令。唯一的 409 门只在 `task.ts:1317-1330` 的新建路径；`resumeTask`、`retryNode` 和 boot auto-resume 直接重入 scheduler，因此 enforce 主机仍会执行未沙箱化 agent。另有 `start.ts:263-270` 只在启动时快照 mode，而 `PUT /api/config` 仅写文件，Settings 从 off 切到 enforce 后 provider、状态 API 和后续 spawn 都继续使用旧值。
  Recommendation: 把 enforce 判定放到每次 spawn 的单一决策点并 fail-closed；provider 每次读取当前配置或由配置写路由原子更新。覆盖 launch、resume、retry、auto-resume 及三种在线切换。
- [critical] P0 — askpass 不绑定目标远端，恶意仓库可把 PAT 引向攻击者 (packages/backend/src/services/gitCredential.ts:23-30)
  helper 完全忽略提示中的 URL，对任何 Username/Password 请求都返回同一租约秘密。默认冷 clone 又在同一 env 下执行 `--recurse-submodules`（`gitRepoCache.ts:590-607`），恶意 `.gitmodules` 可让攻击者主机获得父仓 PAT；agent 也可修改可写的共享 Git config/origin，随后 auto-push 在 `commitPushRunner.ts:333-338` 注入真实凭据。多仓任务还由 `start.ts:518-524` 始终取主仓 `tasks.cachedRepoId`，会把主仓凭据用于次仓远端。
  Recommendation: 让凭据 broker 校验精确的 scheme/host/port/path，并拒绝不匹配提示；保护 `.git/config`、hooks 和 URL rewrite 配置不被 agent 修改；push 按具体 task_repo 解析凭据；父仓 clone 与子模块认证分离。
- [critical] P0 — macOS allow-default 策略漏掉真实 workspace 和凭据租约路径 (packages/backend/src/services/sandbox/policy.ts:45-68)
  Seatbelt 只拒绝这份枚举清单，并未遮蔽 appHome。真实业务 cwd 位于 `nodeIsolation.ts:148-156` 的 `{appHome}/iso/...`，但 `iso/` 不在清单，因此任一 agent 可读写其他任务的隔离树；`scratch/`、`fusions/` 和 `.restore-pending.failed-*` 同样遗漏。`gitCredential.ts:75-90` 的明文 `.gitcred-*` 也未被拒绝，沙箱中的并发 agent 可直接 glob+读取；SIGKILL/掉电后 best-effort cleanup 还会留下永久明文。0600 对同 UID agent 无效。
  Recommendation: macOS 改为拒绝整个 appHome，再只回放当前任务的精确 workspace/run/mirror；凭据改用非落盘 broker，至少放入整树 deny 的专用目录并在启动时清扫残留。加入双任务横向读取和活跃/崩溃租约测试。
- [critical] P0 — memory distiller 仍以可调用工具的裸进程处理不可信内容 (packages/backend/src/services/memoryDistiller.ts:948-969)
  distiller 会把 source-agent transcript 和 reviewed document body 原样送入 prompt（`memoryDistiller.ts:653-676`），但这里直接 `Bun.spawn(plan.cmd)`，没有任何 RFC-205 wrapper。system-agent inline config 只有 prompt/model，也没有工具 deny；提示词中的“Do NOT call tools”不是安全边界。恶意任务输出或评审文档一旦提示注入成功，即可用同 UID shell 读取 secret.key、DB 和备份。
  Recommendation: 所有 runtime spawn 统一经过同一沙箱边界；distiller 使用仅放行 attemptDir 的上下文并在 runtime 配置层禁用 shell/文件工具。增加带恶意 transcript 的真实进程回归测试。
- [critical] P0 — Linux 可经宿主 /proc 绕过 appHome tmpfs (packages/backend/src/services/sandbox/policy.ts:109-117)
  bwrap 将宿主 `/` 整体 bind 进命名空间，未使用独立 PID namespace 或新 `/proc`。在允许同 UID ptrace-read 的合法主机配置上，agent 可经 `/proc/<daemonPid>/root/.../secret.key` 看到 daemon 的原始 mount view，或读取 `/proc/<daemonPid>/fd/<sqlite-fd>`，完全绕开 appHome tmpfs。该行为及权限条件见 [proc_pid_root(5)](https://man7.org/linux/man-pages/man5/proc_pid_root.5.html) 和 [Yama 文档](https://www.kernel.org/doc/html/latest/admin-guide/LSM/Yama.html)；probe 没有验证宿主是否阻断此路径。
  Recommendation: 使用 `--unshare-pid --proc /proc`，通过外层 bwrap PID/进程组维持 kill/reap；否则 probe 必须实测 daemon-root/fd 不可达并在不满足时判 unavailable。
- [critical] P0 — 存量 origin 清洗失败被无条件吞掉 (packages/backend/src/services/gitRepoCache.ts:446-456)
  `runGit` 对 Git 非零退出码返回结果而不会 reject，所以这里的 `.catch()` 不会捕获常见的 set-url 失败。只读、锁定或损坏的 config 会继续进入 fetch；旧 credentialed origin 可能仍可成功 fetch，任务随后照常使用镜像，而明文凭据永久留在 `.git/config`。测试只锁定源码中存在 set-url 字符串，没有断言其结果。
  Recommendation: 检查 set-url 的 exitCode，随后读取并验证全部 remote URL/config 不含 userinfo；无法证明已清洗时 fail-closed 或隔离重建镜像，不能继续复用。
- [high] P1 — 清洗 origin 后仍有多条私仓网络 Git 路径没有凭据 (packages/backend/src/services/gitRepoCache.ts:809-837)
  手动刷新及周期 refresh 直接对 credential-free origin 执行 fetch；私有 HTTPS 镜像会稳定 502。相同遗漏还存在于 `commitPushRunner.ts:383-397` 的 non-fast-forward repair fetch，以及 `util/git.ts:976-983` 的 working-branch ls-remote/fetch。以前这些路径依赖含凭据 origin，RFC-205 清洗后已失效，造成刷新长期失败、远端已有分支被误判不存在、auto-push 只能留本地提交。
  Recommendation: 建立按 cachedRepoId/taskRepoId 解析秘密的唯一 authenticated-network-git executor，收编所有 clone/fetch/ls-remote/push 调用；用真实私有 HTTP fixture 覆盖手动刷新、周期刷新、working branch 和 non-FF repair。
- [high] P1 — Linux 多仓节点只回放主仓 iso worktree (packages/backend/src/services/sandbox/index.ts:85-100)
  此启发式仍假设旧的 `worktrees/multi/{taskId}/{repo}` 布局；RFC-130 的真实路径是 `iso/{taskId}/{nodeRunId}/{repo}`，其 parent basename 是 nodeRunId，因此只把传入的主仓路径加入 `taskWorktrees`。bwrap 先用 tmpfs 遮住 appHome，随后只 bind 主仓；prompt 中列出的次仓路径全部消失，Linux 沙箱启用后多仓 agent 无法完成跨仓任务。
  Recommendation: 由 scheduler 从可信的 isoHandle.repos 显式传入当前任务全部 worktree/mirror 路径，删除 cwd 猜测；增加 Linux bwrap 多仓读写/跨任务拒绝测试。
- [high] P1 — 409 sandbox-unavailable 绕过已物化 workspace 的清理协议 (packages/backend/src/services/task.ts:1313-1344)
  enforce 门在 `StartTaskOwnership` 构造和 try/catch 之前抛错。multipart、fusion 等调用者会先物化 workspace；命中 409 后 `cleanupMaterializedSpaceLease` 和 `materializingSpaces.delete` 均不会执行，反复拒绝会遗留 worktree/scratch 与占用记录。文件上方注释明确要求任何初始校验都必须先接管 cleanup。
  Recommendation: 先构造 ownership，再在受 cleanup catch/finally 保护的区域执行 sandbox gate；更优是在物化前做一次 UX preflight，同时保留受保护的服务层兜底。补 preCreatedWorktree/materializedSpace 两条 409 清理测试。
- [medium] P2 — e2e 全局 off 使生产接线和 realpath 修复可被无声删除 (e2e/harness.ts:294-304)
  所有 e2e daemon 都强制 off；所谓真实机制测试又直接调用 policy renderer，并预先 realpath fixture，而不是启动 daemon/runNode。因而删除 `start.ts` 的 provider 安装、删除 runner 的 `wrapSandbox`、删除 `wrapSandbox` 的 realpath、破坏在线 mode 更新或继续遗漏 `iso/`，现有测试仍可全绿；Linux CI 也没有真实 bwrap 行为覆盖。
  Recommendation: 普通 e2e 可继续 off，但必须增加专用 daemon-level shard：真实启动 provider、执行 RFC-130 iso 业务节点、验证跨任务拒绝与 git 操作，并覆盖 warn/enforce/off 在线切换；Linux CI 安装并实际运行 bwrap。

Next steps:
- 阻断发布，优先关闭所有 P0：远端绑定凭据、deny-whole-appHome、Linux PID/proc 隔离、全 spawn 接线和 enforce fail-closed。
- 统一盘点并收编全部 daemon 网络 Git 调用，同时补每仓凭据解析。
- 补 dedicated daemon-level 双平台安全 e2e 和租约崩溃/并发测试。
- 修复后重新进行 RFC-205 实现门对抗复审。

Codex session ID: 019f8743-f58d-7bf2-9a74-13f2be40764b
Resume in Codex: codex resume 019f8743-f58d-7bf2-9a74-13f2be40764b
