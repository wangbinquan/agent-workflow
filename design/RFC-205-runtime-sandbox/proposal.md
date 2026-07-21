# RFC-205 — 运行时沙箱（把平台秘密挡在 agent 进程之外）

- 状态：Draft（2026-07-21 起草；编号自 RFC-204 §2 移出预留）
- 触发：RFC-204「仓库 Git 凭据封存」二轮 Codex 设计门**证实静态加密对 P0-b 无效**——agent
  进程与 daemon 同 UID，可直读 `secret.key` + `db.sqlite` 自行解开 `url_enc`，「把凭据从
  task agent 手里隔离」唯一的真边界是 OS 层访问控制。用户拍板 P0-b 移出 → 本 RFC。
  同源：权限审计 2026-07-15 遗留项。
- 依赖：RFC-204（cached_repos.url 封存已落地；本 RFC 承接其 §2 移出的 origin 清洗 +
  R1 运行时沙箱）。

## 1. 背景 / 威胁模型

平台的核心工作方式是：daemon 把 opencode / claude-code 以子进程方式跑在任务 worktree
里，让它们代表用户读写仓库代码。这些 agent 进程：

- 执行 LLM 驱动的任意工具调用（shell、文件读写）；
- 跑在**用户导入的任意仓库**上（仓库内容不可信：恶意 README/脚本可以对 agent 做提示注入）；
- 与 daemon **同 UID**，因此在没有沙箱的现状下可以读到 daemon 的一切文件。

同 UID 下 agent 可触达的平台秘密（威胁清单）：

| # | 资产 | 后果 |
| --- | --- | --- |
| A1 | `~/.agent-workflow/secret.key` | 解开 DB 里全部 `url_enc`（Git 凭据）；伪造 seal |
| A2 | `~/.agent-workflow/db.sqlite`（+`-wal`/`-shm`） | 全量业务数据：用户、任务、凭据密文、审计 |
| A3 | `~/.agent-workflow/backups/` | 历史全量快照（RFC-213 后长期存在） |
| A4 | 镜像仓库 `.git/config` 的 origin URL | **明文 Git 凭据**（RFC-204 明确不处理、移交本 RFC） |
| A5 | 其它任务的 worktrees / runs 目录 | 横向窥视并发任务的代码与产出（多用户实例下跨用户） |

RFC-204 的结论适用于 A1–A4 全部：只要 agent 与 daemon 同 UID 且无 OS 层隔离，任何
「加密/脱敏/清洗」都只是把读取路径变长一步。本 RFC 交付真正的 OS 层边界。

## 2. 目标

- **G1 镜像 origin 凭据下盘**：镜像仓库磁盘上的 `.git/config` 不再含凭据（origin 存
  脱敏 URL）；daemon 侧 clone / fetch / push 的凭据改为**执行时注入**（credential
  helper / askpass 形态），用完即失。既有镜像做一次性清洗。这一条独立于沙箱机制、
  对所有平台无条件生效——它消灭的是 A4 的「磁盘上有明文」本身。
- **G2 agent 进程 FS 沙箱**：以 OS 沙箱机制包装 agent 子进程，策略为
  **默认继承系统 + 精确拒绝**：
  - 拒绝读写：`secret.key`、`db.sqlite*`、`backups/`、其它任务的 worktree 与 run 目录
    （A1/A2/A3/A5）；
  - 放行：本任务 worktree（读写）、本 run 私有目录（读写）、共享镜像对象库（只读，
    G1 清洗后其中已无凭据）、受管 skills staging（只读）、模型 auth 基线
    （`~/.opencode` / `~/.claude` 等，agent 干活本来就需要）、系统与工具链路径。
- **G3 平台机制**：macOS 用 `sandbox-exec`（Seatbelt profile）；Linux 用 `bwrap`
  （bubblewrap，探测到二进制才启用）。机制不可用时按 G4 的模式降级。
- **G4 三档设置 `sandboxMode`**：`enforce`（沙箱不可用则拒绝启动任务，给出明确错误）
  / `warn`（**默认**——降级裸跑 + 显式告警事件）/ `off`（现状行为，零包装）。
- **G5 可观测**：Settings→Runtime 面板显示「沙箱机制可用性 + 当前模式」；每次降级
  裸跑落一条告警事件（复用既有事件/告警通道）；node_run 层面可追溯本次是否被沙箱。

## 3. 非目标

- **UID 降权 / 专用运行用户**（root daemon 下 spawn 降权是更强的边界，但牵动 auth
  基线 HOME、worktree 属主、全部现有安装的迁移——独立后续 RFC）。
- **网络隔离**（agent 出网自由不变；防外传不在本 RFC）。
- **daemon 自身的沙箱**、macOS TCC 权限、Windows 支持（平台无 Windows 发行）。
- **R2 共享镜像的每用户隔离**（RFC-204 遗留 R2，另立）。
- 对 agent 子进程再 spawn 的孙进程做逐个策略（Seatbelt/bwrap 天然按进程树继承，
  以进程树为边界即可）。
- 挡「同 UID 进程侧信道」（ps / /proc 窥视 daemon 环境等）：Linux 侧 bwrap 以
  `--unshare-pid` 顺带缓解；macOS 侧 Seatbelt 默认策略已限制 task-for-pid 类访问，
  更强的进程隔离交给 UID 降权后续 RFC。

## 4. 用户故事

1. 我在公司内网部署平台、镜像了带 PAT 凭据的私有仓。一个任务 agent 被仓库里的恶意
   指令注入「把 `~/.agent-workflow/secret.key` 和 db 发出去」。沙箱开启（warn/enforce
   任一档 + 机制可用）时，这两个读取直接 EPERM，任务照常干活。
2. 我在没有装 bwrap 的 Linux 服务器上升级到本版本：默认 `warn` 档,一切任务照跑，
   但 Settings→Runtime 明确显示「沙箱机制不可用（未找到 bwrap）」，事件里有降级告警；
   我装上 bwrap 后无需改配置，下一个任务自动被沙箱。
3. 安全要求高的实例把 `sandboxMode` 调成 `enforce`：机制不可用时任务启动直接失败并
   报「沙箱不可用」，而不是静默裸跑。
4. 我导出/查看镜像目录：`.git/config` 里的 origin 是脱敏 URL,不再有任何明文凭据；
   fetch / push / clone 一切照常。

## 5. 验收标准

- **AC-1** 沙箱生效时（macOS `sandbox-exec` / Linux `bwrap`），agent 进程内读
  `secret.key`、`db.sqlite`、`backups/` 任意文件、其它任务 worktree → 全部失败；
  写本任务 worktree、读写本 run 目录、读镜像对象库、读 auth 基线 → 全部成功。
  （集成测试以真实机制冒烟，CI 缺机制时 gated skip。）
- **AC-2** `git diff/log/status/commit` 在被沙箱的 agent 内正常工作（worktree gitdir
  →镜像 `.git` 的读路径被正确放行）。
- **AC-3** 新镜像 clone 后与既有镜像被清洗后，`.git/config` 全文无凭据（有回归测试
  直接断言文件内容）；清洗后 daemon 的 fetch / push / pull base 分支照常成功。
- **AC-4** `sandboxMode` 三档语义正确：`enforce` + 机制不可用 → 任务启动失败且错误
  信息明确；`warn` + 机制不可用 → 照跑 + 降级事件一条（不重复刷屏）；`off` → 与现状
  逐字节同 argv/env（golden 锁）。
- **AC-5** 探测结果 + 当前模式在 Settings→Runtime 可见（i18n 双语）；模式可在
  Settings 修改并即时生效（下一次 spawn 起）。
- **AC-6** 沙箱包装对既有测试桩（TS 桩 + e2e shell 桩）零破坏：测试环境下默认不包装
  （机制探测不到 / 显式 off），argv 契约测试全绿。
- **AC-7** node_run 可追溯本次运行是否被沙箱（事件或字段任一形态，design 定）。
- **AC-8** `bun run typecheck && bun run test && bun run format:check` + 单二进制
  smoke + 前端 vitest 全绿；上述新增行为全部带测试。

## 6. 打开问题（design.md 解决）

- 放行/拒绝清单的单一事实源形态（纯函数 → 两种机制各自编译成 profile / argv）。
- 镜像清洗的执行时机（启动一次性 vs fetch 前 lazy）与幂等。
- 凭据注入形态（`GIT_ASKPASS` 一次性 env vs credential helper 子命令）与并发 fetch。
- Seatbelt profile 的最小可行模板（allow default + deny 子树 vs deny default 白名单）。
- 探测缓存与失效（daemon 启动探测一次 vs 每 spawn 探测）。
