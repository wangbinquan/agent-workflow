# RFC-204 — 仓库 Git 凭据的全链路封存、隔离与出线脱敏

状态：Draft（v2，2026-07-19 设计门 Codex 审查后重写；范围扩大经用户拍板）
作者：Claude（受权限系统审计 2026-07-15 P0-3 委派）
关联：审计 backlog（记忆 `project_permission_system_audit_2026_07_15`）P0-3；RFC-024（cached_repos）、RFC-054 W3-4（task 侧已脱敏落库）、RFC-066（task_repos 多仓）、RFC-034（submodule）、RFC-036（secretBox）、RFC-159（scheduled_tasks）、RFC-165（file:// 走缓存）。

> **v2 更正记录**：v1 草案的问题陈述有一处错误、并漏了两个真实凭据面，均由设计门 Codex 审查（2026-07-19，commit `848db382`）捕获：
> - **更正**：`tasks.repo_url` / `task_repos.repo_url` **早已由 RFC-054 W3-4 脱敏落库**（`task.ts:1547`/`:1609` 存 `redactGitUrl(...)`）。故 v1 §1.2「task 接口泄漏」不存在，对 task 两列做封存**有害**（会加密已打码值）。task-wire 部分从本 RFC 删除，降级为一条锁定既有脱敏的回归测试。
> - **新增面①**：镜像 `.git/config` 的 origin 明文凭据可被 **agent 进程**（在 worktree 内 `git remote get-url origin`）读出——封 DB 挡不住。
> - **新增面②**：`scheduled_tasks.launch_payload` 把含明文 `repoUrl` 的整个 launch body JSON 落库、经 API 返回、进备份。

---

## 1. 背景与真实泄漏面

平台接入私有仓的既定方式是把 Git 凭据塞进仓库 URL（`https://x-access-token:TOKEN@host/o/p.git`）。经核对源码，**当前真实存在**的凭据面为：

### P0-a · cached_repos 明文 URL 跨用户泄漏（审计首要动因）
`cached_repos` 是全局共享镜像池、无 owner（`db/schema.ts:666`）。`gitRepoCache.ts:169` `rowToCached` 把明文 `url` 与 `urlRedacted` 一起上 wire；`GET /api/cached-repos` 门为 `repos:read`，而 `repos:read ∈ USER_BASELINE`（`shared/schemas/permission.ts:67`）→ **任何登录用户 / 最窄 PAT 都能拉全表明文凭据**，越权 clone/push 他人私有仓。

### P0-b · 镜像 origin 凭据被 agent 进程可读
`resolveCachedRepo` 用 `git clone <含凭据 URL>` 建镜像（`gitRepoCache.ts:499`），镜像 `origin` remote 明文含凭据；worktree 由 `git worktree add` 从镜像派生（`util/git.ts:661`），agent（opencode 子进程）在 worktree 内运行（`runner.ts:827`），可直接 `git remote get-url origin` 读出**首启者凭据**。这比 DB 泄漏更贴近平台初衷（「别让 agent 看到凭据、以免注入/审计 agent 外泄」）。

### P1-a · scheduled_tasks.launch_payload 明文凭据
定时任务把整个 launch body（含明文 `repoUrl`）`JSON.stringify` 存入 `scheduled_tasks.launch_payload`（`scheduledTasks.ts:251`），`rowToScheduledTask` 经 API 原样返回（`:119`）→ 明文凭据落库、进备份、经 owner/admin API 面外泄。

### 静态明文（DB / WAL / 备份）
`cached_repos.url` 与上述 payload 明文落库；`POST /api/backup` 与 `agent-workflow backup` CLI 均 `VACUUM INTO` 打包 `db.sqlite`（`services/backup.ts:6`、`cli/backup.ts`）→ 凭据随备份外流。SQLite 为 WAL 且未启 `secure_delete`（`db/client.ts:32`），逻辑清空不抹物理页。

### 不是泄漏（v1 更正）
`tasks.repo_url` / `task_repos.repo_url` 已脱敏落库（RFC-054 W3-4）→ 任务读接口本就返回脱敏形，**无** task-wire 凭据泄漏；这两列也**无**明文凭据静态残留。

### 为什么一直没修
出线明文 `url` 是启动复用契约的承重件（前端 `RepoSourceRow.tsx:90` option value=明文 url、`launch-repo-source.ts:131` 用 `canonicalRepoKey(c.url)` 匹配、后端 `refTaskCount` 明文 join），删 `url` 会打断「选历史私有仓一键复用（免重输 token）」。审计标为「触及 launch 复用契约、待用户拍板」，历轮上线前加固均跳过。

---

## 2. 目标 / 非目标

### 目标
1. **消除 P0-a**：`GET /api/cached-repos` 及一切 cached_repos wire 不再含明文 `url`；`repos:read` 保持 baseline（复用选择器需要），只让载荷安全。
2. **消除 P0-b**：镜像 `origin` 存**无 userinfo** 形；凭据改由**受控 git 操作在命令时经 `GIT_ASKPASS` 注入**（密钥走 chmod-600 临时通道、用后即删），使 agent 在 worktree 内 `git remote get-url origin` 读不到任何凭据。覆盖 clone / fetch（reuse+refresh）/ push / submodule 全部认证 git 操作。
3. **消除 P1-a**：`scheduled_tasks.launch_payload` 内凭据封存/改引用（存 `cachedRepoId` + 脱敏 `repoUrl`），出线/备份不再含明文。
4. **静态封存**：`cached_repos` 的凭据以 `secretBox`(AES-256-GCM) 封存落库；配合 `secure_delete`+WAL checkpoint/truncate+VACUUM，使 DB 文件与备份 tar 内无明文凭据、且无物理页残留。
5. **保留并修好复用/重启 UX**：启动 / relaunch / agent 启动 / workgroup 启动 / 定时启动**全部**改按 `cachedRepoId` 引用镜像，服务端解封驱动 git，凭据永不再出后端。顺带修好 relaunch 私有仓（今天因 task 侧脱敏而 auth 失败）。
6. **迁移明文消费者**：`refTaskCount`、记忆 scope 解析（`memoryInject.ts:365` / `memoryDistillScheduler.ts:184` 现以 `cachedRepos.url==tasks.repoUrl` join）改走 `cached_repo_id`，顺带修好私有仓记忆 scope（今天 redacted≠plaintext 已 latent 失效）。
7. **备份前置封存**：backfill 挪进 daemon 启动**与** backup CLI 都经过的共享 gate，杜绝「升级后首次备份仍含明文」。
8. **锁定既有脱敏**：为 task 侧 RFC-054 脱敏加回归锁，防未来 refactor 回退成明文落库。
9. **红→绿回归**：为每个泄漏面各写能稳定复现的测试，先红后绿。

### 非目标
- **每用户镜像隔离**。`canonicalForHash` 剥 userinfo → `url_hash` 凭据无关 → 同 host/path 全体共享一条镜像，「首启者凭据」被后续复用者 git 操作隐式使用。既有属性，本 RFC 不改（若需隔离另立 RFC）。
- **/proc 侧信道**：本 RFC 关闭「worktree 内 `git config` 读 origin」这一稳定、在 worktree 内的泄漏；agent 若要抓框架**瞬时** git 子进程的 env/argv（同 uid、需竞态命中 `/proc/<pid>/environ`）是更深残留，列 §7 R1。
- **drop 空列**：`cached_repos.url` 清空后不 drop（rolling-upgrade 掉列风险），列 `0099` follow-up。
- 不改 `repos:read` 出 baseline；不改 `url_hash` 语义；不改 task 侧已脱敏的存储/wire（只加锁）。

---

## 3. 用户故事
- **US-1 受害者**：我把 PAT 塞进 URL 跑过私有仓，同实例任何其他登录用户都不能从任何 API（cached-repos / 任务 / 定时任务）读到我的 token。
- **US-2 复用者**：我在启动 / 重启 / agent / workgroup / 定时各入口都能选历史私有仓一键复用，无需重输凭据，且浏览器与请求体不出现明文凭据。
- **US-3 agent 隔离**：平台跑的 agent 进程在其 worktree 内无法通过 git 读出仓库凭据（`git remote get-url origin` 只见无 userinfo 的 URL）。
- **US-4 运维**：我导出的 `db.sqlite`（含 WAL）不含任何明文 Git 凭据、也无物理页残留；升级后**首次**备份即已封存。
- **US-5 升级**：既有历史明文行升级后被一次性 backfill 封存 + 镜像 origin 清洗 + 明文清除；backfill 幂等、可安全重启。

---

## 4. 验收标准
1. `GET /api/cached-repos` 对含凭据行无 token 子串；`CachedRepoSchema` 无 `url`。
2. 任一镜像/worktree 内 `git remote get-url origin` 无凭据；clone/fetch/push/submodule 经 `GIT_ASKPASS` 注入后认证成功。
3. `GET /api/scheduled-tasks`（及 detail）对含凭据 payload 无 token；重放该定时任务仍认证成功。
4. 启动后直查 sqlite：`cached_repos.url` 为空且 `url_enc` unseal 回原 URL；WAL checkpoint 后裸文件（`db.sqlite`+`-wal`）grep 无 token。
5. 启动 / relaunch / agent / workgroup / 定时**五入口**选历史私有仓复用成功，请求体/payload 无明文 `repoUrl`。
6. `refTaskCount`、记忆 scope 解析改按 `cached_repo_id` 且计数/选仓正确（私有仓记忆 scope 修复）。
7. 备份：升级后**首次** `POST /api/backup` 与 `agent-workflow backup` 产物均已封存（无明文）。
8. task 侧脱敏回归锁存在（`task.ts` 落库仍 `redactGitUrl`）。
9. 门禁：`typecheck && lint && test && format:check` 全绿；**全量** backend 套件；单二进制 build smoke；`_journal.json` 一致；推后查 CI 绿。
10. 源码防回归锁：`CachedRepoSchema` 无 `url`；`rowToCached` 不 emit 明文；镜像 origin 无 userinfo；`RepoSourceRow` option value 非明文 url。

技术设计、失败模式、测试策略见 `design.md`；任务分解见 `plan.md`。
