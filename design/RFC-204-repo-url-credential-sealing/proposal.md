# RFC-204 — 仓库 Git 凭据的封存、出线脱敏与复用改造

状态：Draft（v4，2026-07-20；**三轮**设计门 Codex 审查后定稿，待实现批准）
作者：Claude（受权限系统审计 2026-07-15 P0-3 委派）
关联：审计 backlog（记忆 `project_permission_system_audit_2026_07_15`）P0-3；RFC-024（cached_repos）、RFC-054 W3-4（task 侧已脱敏落库）、RFC-066（task_repos 多仓）、RFC-036（secretBox）、RFC-159（scheduled_tasks）、RFC-165（file:// 走缓存）、**RFC-205（运行时沙箱——承接本 RFC 移出的 agent 凭据隔离，见 §2 非目标）**。

> **范围演进（三轮设计门审查修正；每轮 finding 均已折入或经用户拍板改范围）**
> - **v1→v2**：审查更正「task-wire 泄漏」不存在（`tasks.repo_url`/`task_repos.repo_url` 早由 RFC-054 W3-4 脱敏落库），并揭示 scheduled 载荷与镜像 origin 两个真实面。
> - **v2→v3**：第二轮审查证实 **P0-b「把凭据从 task agent 手里隔离」用加密+origin 清洗做不到**——agent 与 daemon 同 UID，可直接读 `~/.agent-workflow/secret.key`+`db.sqlite` 解出全部 `url_enc`，无需碰 origin；且 origin 注入子系统本身吞下 6 条正确性 finding。用户拍板：**P0-b 移出，另立 RFC-205 运行时沙箱**（FS/UID 隔离才是真边界，且能统一保护 key/DB/origin）。本 RFC 回到可达且有价值的核心。
> - **v3→v4（本版）**：第三轮审查发现 query 形凭据是深坑（`parseGitUrl` 把 query 留在 `parsed.path` → 泄进 cache slug/`local_path`（**在 wire 上**）/`url_hash`；历史 `redactGitUrl` 不脱 query 已污染 task 两列与三个 error 列），且 scheduled 契约有三处硬伤（单一校验器同时管请求/存储/响应→外部可投递密文；`cachedRepoId` 输入未处理；编辑往返丢凭据）；另纠正 v3 对 FF 日志"已脱敏"的错误假设（`task.ts:531` 返回原文）。用户拍板 query 走**轻量清理**（入口拒绝 + 展示脱敏 + 历史列 re-redact，**不改 hash/不改名目录/不 re-key**）。

---

## 1. 背景与真实泄漏面（v4 范围内）

平台接入私有仓的既定方式是把 Git 凭据塞进 URL（`https://x-access-token:TOKEN@host/o/p.git`，或 query 形 `?access_token=TOKEN`）。经三轮源码核对，本 RFC 处理**可由封存/脱敏关闭**的面：

### P0-a · cached_repos 明文 URL 跨用户泄漏（审计首要动因）
`cached_repos` 全局共享、无 owner（`db/schema.ts:666`）；`gitRepoCache.ts:169` `rowToCached` 把明文 `url` 与 `urlRedacted` 一起上 wire；`GET /api/cached-repos` 门 `repos:read ∈ USER_BASELINE`（`permission.ts:67`）→ **任何登录用户/最窄 PAT 拉全表明文凭据**。

### P1-a · scheduled_tasks.launch_payload 明文凭据
定时任务把整个 launch body（含明文 `repoUrl`）`JSON.stringify` 存 `scheduled_tasks.launch_payload`（`scheduledTasks.ts:251`），`rowToScheduledTask` 经 API 原样返回（`:119`）→ 明文落库、进备份、经 API 外泄。

### 静态明文（DB / WAL / 备份）
`cached_repos.url` 与上述 payload 明文落库；`POST /api/backup` 与 `agent-workflow backup` CLI 均 `VACUUM INTO` 打包 `db.sqlite`（`backup.ts:6`、`cli/backup.ts`），且 **backup 不含 `secret.key`**（经核对：仅 db.sqlite/config.json/skills/workflows）→ **封存对备份与「仅 db.sqlite 被拷走」真实有效**。SQLite 为 WAL 且未启 `secure_delete`（`db/client.ts:32`），逻辑清空不抹物理页。

### query 形凭据 URL 的深层泄漏（既有隐患，本 RFC 处理）
两个叠加缺陷：`redactGitUrl` 只脱 userinfo、**不脱 query**；且 `parseGitUrl` 把 `?access_token=TOKEN` 留在 `parsed.path`（`git-url.ts` https 分支 `path = body.slice(slashIdx+1)`）→ 泄进 cache slug → `cached_repos.local_path`（**在 wire 上**，`cachedRepo.ts:12`）+ worktree 路径 + `url_hash`；历史上还已把 token 写进 `tasks.repo_url`/`task_repos.repo_url` 与 error 列（`last_submodule_sync_error`/`submodule_init_error`/`scheduled_tasks.last_error`）。**处理（用户 2026-07-20 拍板「轻量清理」）**：going-forward 在 launch/schedule 入口**拒绝** query 凭据 URL（userinfo 形仍支持、封存已覆盖）；`redactGitUrl` 补 query 脱敏用于展示/日志；backfill re-redact 历史列 + wire 层脱敏 `local_path`；**不改 `canonicalForHash`、不改名缓存目录、不 re-key `url_hash`**（入口拒绝后无新 query slug/hash 产生，既有行经 `cachedRepoId` 复用仍命中原 hash）。

### 不是泄漏（v1 更正，保留）
`tasks.repo_url`/`task_repos.repo_url` 已脱敏落库（RFC-054 W3-4，`task.ts:1547/1609`）→ 任务读接口本就返回脱敏形；这两列无明文凭据静态残留。只加回归锁 + 修 query 盲区。

### 为什么一直没修
出线明文 `url` 是启动复用契约的承重件（`RepoSourceRow.tsx:90` option value=明文 url；`launch-repo-source.ts:131` `canonicalRepoKey(c.url)` 匹配；`refTaskCount` 明文 join）——删 `url` 会打断「选历史私有仓一键复用」。

---

## 2. 目标 / 非目标

### 目标
1. **消除 P0-a**：cached_repos 一切 wire 不再含明文 `url`；`repos:read` 保持 baseline（复用选择器需要），只让载荷安全。
2. **静态封存 cached_repos 凭据**：以 `secretBox`(AES-256-GCM) 封存 `cached_repos.url`（`url_enc`）；配合 `secure_delete`+WAL checkpoint/truncate+VACUUM，使 DB 文件与备份 tar 无明文凭据、无物理页残留。
3. **消除 P1-a**：`scheduled_tasks.launch_payload` 内凭据**自封存**（payload 内 `repoUrl` 明文→`repoUrlEnc` 密文 + `repoUrlRedacted` 展示），出线/备份不含明文；**自持凭据、不依赖 cache row**（避免升级需联网 clone / 删缓存断定时）。
4. **关闭 query 形凭据泄漏（轻量路线）**：① 入口**拒绝** query 凭据 URL（launch + schedule 保存）；② `redactGitUrl` 补敏感 query 脱敏（展示/日志/落库脱敏统一受益，含 task 列既有盲区）；③ wire 层脱敏 `cached_repos.local_path`；④ backfill re-redact 历史 `tasks.repo_url`/`task_repos.repo_url` 与 `last_submodule_sync_error`/`submodule_init_error`/`scheduled_tasks.last_error`。**不动 `canonicalForHash`/目录名/`url_hash`**。
5. **保留并修好复用/重启 UX**：交互启动 / relaunch / agent 启动 / workgroup 启动**四面**改按 `cachedRepoId` 引用镜像，服务端解封驱动 git，凭据永不再出后端；顺带修好 relaunch 私有仓（今天因 task 侧脱敏而 auth 失败）。
6. **迁移明文消费者**：`refTaskCount`、记忆 scope 解析（`memoryInject.ts:365`/`memoryDistillScheduler.ts:184` 现以 `cachedRepos.url==tasks.repoUrl` join）改走 `cached_repo_id`，顺带修私有仓记忆 scope（今天 redacted≠plaintext 已 latent 失效）。
7. **备份前置封存**：backfill 挪进 daemon 启动**与** backup CLI 都经过的共享、**网络无关**的 gate，杜绝「升级后首次备份仍含明文」，且不因联网/凭据阻塞升级。
8. **锁定既有脱敏**：为 task 侧 RFC-054 脱敏加回归锁。
9. **删除守卫顾及自持 schedule**：schedule 自封存后不引用 cache row，删缓存不影响定时（自然满足）。
10. **红→绿回归**：每面各写可复现测试，先红后绿。

### 非目标
- **P0-b「把凭据从 task agent 手里隔离」→ RFC-205**。二轮审查证实：agent 同 UID 可直读 `secret.key`+`db.sqlite` 解密，封存/origin 清洗非安全边界。真边界＝运行时 FS/UID 沙箱（隔离 agent 与 `~/.agent-workflow`），是独立较大工程，且能统一保护 key/DB/origin/worktree。本 RFC **不做 origin 清洗、不做 askpass 注入**；镜像 origin 保持现状（含凭据），由 RFC-205 承接。
- **每用户镜像隔离**（`url_hash` 剥 userinfo→共享镜像，首启者凭据被复用者 git 隐式使用）。既有属性，另立 RFC。
- **drop 空列**：`cached_repos.url` 清空后不 drop（rolling-upgrade 掉列风险），`0099` follow-up。
- 不改 `repos:read` 出 baseline；不改 `url_hash` 语义。

---

## 3. 用户故事
- **US-1 受害者**：我把凭据塞进 URL 跑过私有仓，同实例任何其他登录用户都不能从任何 API（cached-repos / 定时任务）读到我的 token。
- **US-2 复用者**：交互启动 / 重启 / agent / workgroup 四入口都能选历史私有仓一键复用，无需重输凭据，浏览器与请求体不出现明文凭据。
- **US-4 运维**：导出的 `db.sqlite`（含 WAL）不含明文 Git 凭据、无物理页残留；升级后**首次**备份即已封存；备份 tar 不含 `secret.key`（已核对）。
- **US-5 升级**：既有历史明文 cached 行与 scheduled 载荷升级后被一次性、**网络无关**的 backfill 封存/清除；幂等、可安全重启。
- **US-6（移交 RFC-205）**：平台跑的 agent 进程无法读出仓库凭据——本 RFC 明确**不承诺**，指向 RFC-205。

---

## 4. 验收标准
1. `GET /api/cached-repos` 对含凭据行（userinfo 形与历史 query 形）**整个响应体**无 token 子串——含 `urlRedacted` **与 `localPath`**；`CachedRepoSchema` 无 `url`。
1b. 新提交的 query 凭据 URL（launch 与 schedule 保存）被入口校验拒绝并给出可读错误；userinfo 形正常通过。
2. `GET /api/scheduled-tasks`（及 detail）对含凭据 payload 无 token；重放该定时任务仍认证成功；删除其引用的缓存后重放仍成功（自持凭据）；**以 `cachedRepoId` 创建的 schedule 同样自持**（保存时解析并重新封存）。
2b. 对含凭据 schedule 做**空编辑往返**（GET→PUT 原样回写）后，下次触发仍认证成功（凭据不被 `***` 覆盖）。
3. 启动后直查 sqlite：`cached_repos.url` 空、`url_enc` unseal 回原 URL（含 query token）；`wal_checkpoint(TRUNCATE)` 后**裸文件** `db.sqlite`+`-wal` grep 无 token。
4. 交互启动 / relaunch / agent / workgroup **四入口**选历史私有仓复用成功，请求体无明文 `repoUrl`。
5. `refTaskCount`、记忆 scope 解析改按 `cached_repo_id` 且计数/选仓正确（私有仓记忆 scope 修复）。
6. 升级后**首次** `POST /api/backup` 与 `agent-workflow backup` 产物均已封存（无明文）；backfill **不发起任何网络 clone**。
7. task 侧脱敏回归锁存在（`task.ts` 落库仍脱敏，且覆盖 query 形）。
8. 门禁：`typecheck && lint && test && format:check` 全绿；**全量** backend；单二进制 smoke；`_journal.json` 一致；CI 绿。
9. 源码锁：`CachedRepoSchema` 无 `url`；`rowToCached` 不 emit 明文；`RepoSourceRow` option value 非明文 url；scheduled 载荷不同存 `cachedRepoId`+`repoUrl`。

技术设计、失败模式、测试策略见 `design.md`；任务分解见 `plan.md`。RFC-205 仅在本 RFC 定稿后按需另启（本 RFC 只登记预留其编号与承接范围）。
