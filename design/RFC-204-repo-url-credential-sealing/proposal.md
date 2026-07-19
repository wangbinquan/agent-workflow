# RFC-204 — 仓库 URL 凭据的静态封存与出线脱敏

状态：Draft
作者：Claude（受权限系统审计 2026-07-15 P0-3 委派）
日期：2026-07-19
关联：`design/permission-*` 审计 backlog（记忆 `project_permission_system_audit_2026_07_15`）P0-3；`design/ux-functional-audit-2026-07-16.md` §10-③（MemoryDialogShell 明文 url 标签，同源）；RFC-024（cached_repos）、RFC-066（task_repos 多仓）、RFC-036（secretBox）、RFC-165（file:// 走缓存）。

---

## 1. 背景

平台接入**私有仓库**的既定方式，是让用户把 Git 凭据直接塞进仓库 URL（例如 `https://x-access-token:ghp_xxxx@github.com/org/private.git`）。这一点在 schema 注释里写明（`shared/schemas/cachedRepo.ts:7`、`shared/schemas/task.ts:190` 都标注 “may contain credentials”）。

问题在于：这个**带凭据的原始 URL 目前在多处以明文离开服务端 / 明文落库**，形成跨用户与跨成员的凭据泄漏：

### 1.1 P0 —— 跨用户明文凭据泄漏（本 RFC 的首要动因）

- `cached_repos` 是**全局共享**的远程仓库镜像池，**无 owner、不按用户隔离**（`db/schema.ts:666`，无 `owner_user_id`）。
- `services/gitRepoCache.ts:165` `rowToCached` 把明文 `url: row.url` 与 `urlRedacted` **一起**上 wire。
- `GET /api/cached-repos`（`routes/cached-repos.ts`）返回全表 `items`，门是 `resourcePermissionGate('repos')` → GET 需 `repos:read`，而 `repos:read ∈ USER_BASELINE`（`shared/schemas/permission.ts:67,84`）→ **任何登录用户、乃至只勾 `repos:read` 的最窄 PAT 都能拉全表**。

后果：用户 A 用带 PAT 的 URL 跑过一次私有仓 → 该凭据落进 `cached_repos.url` → 用户 B 直接调 `GET /api/cached-repos` 即拿到 A 的 Git 凭据，进而越权 clone/push A 的私有仓。UI 的 `urlRedacted` 脱敏防不住——绕过 UI 直接打接口就拿到原始 `url`。

### 1.2 P1（同源，成员范围）—— 任务读接口泄漏 repoUrl

`tasks` 与 `task_repos` 存明文 `repo_url`（`db/schema.ts:709`、`db/schema.ts:887`），task list/detail wire 以明文 `repoUrl` 字段序列化（`shared/schemas/task.ts:104/193/310`）。任务是成员制私有，门是 `canViewTask`，但**任务协作者**可借此读到 owner 塞进 URL 的 token——比 §1.1 窄，但仍是同源缺陷。

### 1.3 静态明文（DB / 备份）

即便出线脱敏，`cached_repos.url` / `tasks.repo_url` / `task_repos.repo_url` 仍是**明文落库**。`POST /api/backup`（`backup:run`）通过 `VACUUM INTO` 把 `db.sqlite` 打进 tar（`services/backup.ts:6`）→ 凭据随备份外泄；admin 直读 DB、磁盘失窃同理。

### 1.4 为什么一直没修

出线明文 `url` 是**启动复用契约**的承重件：前端下拉 `components/launch/RepoSourceRow.tsx:90` 的 option `value` 就是明文 `it.url`（只 label 脱敏）；`lib/launch-repo-source.ts:131` 用 `canonicalRepoKey(c.url)` 做复用匹配；后端 `refTaskCount` 用 `tasks.repoUrl == cached_repos.url` 明文 join。直接删 `url` 会打断“选历史私有仓一键复用（免重输 token）”。故审计把它标为“触及 launch 复用契约、待用户拍板”，历轮上线前加固均跳过。

用户 2026-07-19 拍板：采用**正解**（复用改按 `cachedRepoId` + 出线脱敏 + 一并 secretBox 静态封存 + 一并处理 task wire）。

---

## 2. 目标 / 非目标

### 目标

1. **消除 §1.1 跨用户泄漏**：`GET /api/cached-repos` 及一切 cached_repos wire 不再含明文 `url`，仅留 `urlRedacted`。
2. **消除 §1.2 成员泄漏**：task list/detail wire 不再含明文 `repoUrl`，仅留脱敏形。
3. **静态封存**：`cached_repos` / `tasks` / `task_repos` 的凭据型 URL 用现有 `secretBox`（AES-256-GCM）封存落库；DB 文件与备份 tar 内**不再有明文凭据**。
4. **保留复用 UX**：启动历史私有仓仍一键复用、免重输 token——改为前端发 `cachedRepoId`、服务端按 id 解封真实 URL 驱动 git；凭据**永不再出后端**。
5. **凭据只在 git 操作时解封**：clone/fetch 之外的任何路径（列表、详情、日志、错误、审计、prompt）只见 `urlRedacted`。
6. **红→绿回归**：为 §1.1/§1.2 各写一条能稳定复现的跨主体泄漏测试，先红后绿。

### 非目标

- **不做每用户镜像隔离**。`canonicalForHash`（`shared/git-url.ts`）对 http/ssh **剥离 userinfo**，故 `url_hash` 与凭据无关 → 同一 host/path 的仓在全体用户间**共享一条 cache row**，“首次启动者的凭据”被后续复用者的 git fetch 隐式使用。这是既有属性；本 RFC 只阻断**明文回读**，不改变共享镜像的信任模型。
- **不消除镜像 `.git/config` 内的凭据**。git 把 `origin` remote URL 明文存在 `~/.agent-workflow/repos/{hash}-{slug}/.git/config`，clone 时从首次启动者的 URL 写入。封存 DB **不会**清洗该文件（同属本机 chmod 目录、不经任何 wire）。列为残留风险与 follow-up（见 design §7）。
- **不改 `POST /api/tasks` 对新 URL 的兼容**：首次接入一个新私有仓仍可直接传 `repoUrl`（含凭据）；只有**复用**改走 `cachedRepoId`。
- **不收紧 `repos:read` 出 USER_BASELINE**：普通用户仍需列出 cached repos 以在启动器里选择，只把载荷改安全即可。
- **不动 `url_hash` 语义**（保持凭据无关的去重键）。
- 不引入 toast/MutationCache 等错误呈现变更（属 RFC-203/后续）。

---

## 3. 用户故事

- **US-1（受害者视角）**：作为把 PAT 塞进 URL 跑过私有仓的用户 A，我不希望同实例的任何其他登录用户能从 `GET /api/cached-repos` 或任务接口读到我的 token。
- **US-2（复用者视角）**：作为普通用户，我在“启动任务”页仍能从历史仓下拉里选中一个私有仓一键复用，**无需重输凭据**，且我的浏览器与后续请求里都不出现明文凭据。
- **US-3（协作者视角）**：作为被拉进某任务的协作者，我能看到该任务用的是哪个仓（脱敏形），但读不到 owner 塞进 URL 的 token。
- **US-4（运维视角）**：作为导出备份的 admin，我导出的 `db.sqlite` 里不含任何明文 Git 凭据；即便备份 tar 外泄也不直接泄露凭据（凭据以 AES-256-GCM 封存，密钥在 `~/.agent-workflow/secret.key`、chmod 600、不在备份内）。
- **US-5（升级视角）**：作为已有历史 cached_repos / tasks 明文行的既有用户，升级后一次性 backfill 把历史凭据封存并清除明文，无需我手动重建；backfill 幂等、可安全重启。

---

## 4. 验收标准

1. `GET /api/cached-repos` 响应体（对含凭据 URL 的行）**不含 token 任何子串**，只含 `urlRedacted`；`CachedRepoSchema` 无 `url` 字段。
2. task list/detail wire（对含凭据 repoUrl 的任务）**不含 token 任何子串**；wire 暴露 `repoUrlRedacted`（+ 复用所需的 `cachedRepoId`），无明文 `repoUrl`。
3. 一次启动后，直接读 sqlite 行：`cached_repos` / `tasks` / `task_repos` 的凭据列**无明文 token**；对应 `*_enc` 列 `unseal` 回原始 URL。
4. 前端“启动任务”历史仓下拉的 option `value` 是 `cachedRepoId`（非明文 url）；选中后复用成功，请求体不含明文 `repoUrl`，git clone/fetch 由服务端解封驱动、认证成功。
5. `MemoryDialogShell` 记忆 scope 下拉、`repos.tsx` 删除确认等展示面均用 `urlRedacted`，无明文 url。
6. backfill：植入一条“升级前明文行”，启动后其凭据被封存、明文列清空、`cached_repo_id`/`url_redacted` 就位；重复运行 no-op。
7. `refTaskCount` / 删除守卫（“被 N 个任务引用”）在改按 `cached_repo_id` 后计数正确。
8. 门禁：`bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；**全量** backend 套件（非仅 migration 子集）通过；单二进制 build smoke 通过；`_journal.json` 与 migration 文件一致。
9. 源码层防回归锁：CachedRepoSchema 无 `url`、`rowToCached` 不 emit 明文、`RepoSourceRow` option value 非明文 url 各有断言。

---

## 5. 影响面速览

- **DB**：新增 migration `0098`（cached_repos +`url_enc`/`url_redacted`；tasks/task_repos +`repo_url_enc`/`repo_url_redacted`/`cached_repo_id`）+ 一次性代码级 backfill。
- **shared**：`CachedRepoSchema` 删 `url`；task schema `repoUrl`→`repoUrlRedacted`+`cachedRepoId`；`StartTaskRequest`/多仓 `repos[]` 新增可选 `cachedRepoId`。
- **backend**：`gitRepoCache`（封存写 / 解封读 / rowToCached）、`task` 启动（reuse-by-id、封存 repo_url、stamp cached_repo_id、refTaskCount 改 join）、task 序列化脱敏、SecretBox 由可选改为 git 路径必需并 thread 进相关 deps、startup backfill。
- **frontend**：`RepoSourceRow`、`launch-repo-source`、`repos.tsx`、`MemoryDialogShell`、任务详情/列表 repoUrl 展示点。
- **无** WS 协议变更；无产品行为变更（复用 UX 等价保留）。

技术细节、失败模式与测试策略见 `design.md`；任务分解与 PR 拆分见 `plan.md`。
