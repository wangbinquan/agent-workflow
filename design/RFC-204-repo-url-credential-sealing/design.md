# RFC-204 — 技术设计

关联 `proposal.md`。以下所有 file:line 均按 2026-07-19 主干核对；实现前按 CLAUDE.md 规则重读确认未被并发 session 动过。

---

## 1. 现状数据流（凭据的三条明文路径）

```
launch body {repoUrl: "https://x-access-token:TOKEN@github.com/o/p.git"}
   │
   ├─ services/task.ts:445  normalizeSources → spec.repoUrl (明文)
   │      │
   │      └─ resolveCachedRepo({url: spec.repoUrl})   services/gitRepoCache.ts
   │             ├─ parseGitUrl → gitUrlCacheKeyWith → url_hash (剥 userinfo, 确定性)
   │             ├─ 命中 row: git fetch 走镜像 origin (含首launcher凭据)
   │             └─ 未命中: git clone input.url → 存 cached_repos.url = 明文  ← 静态明文①
   │
   ├─ tasks.repo_url = spec.repoUrl (明文)            db/schema.ts:709          ← 静态明文②
   └─ task_repos.repo_url = spec.repoUrl (明文)       db/schema.ts:887          ← 静态明文③

出线明文：
  GET /api/cached-repos → rowToCached → {url: 明文, urlRedacted}   ← 泄漏A（跨用户，repos:read∈baseline）
  GET /api/tasks[/:id]  → {repoUrl: 明文}                          ← 泄漏B（成员，canViewTask）
  refTaskCount: WHERE tasks.repoUrl == cached_repos.url (明文 join)  ← 封存后会破
```

关键既有事实：
- `secretBox.seal` 用 `randomBytes` IV → **非确定性密文**，`seal(x) != seal(x)`。任何**去重 / join / 唯一约束**都不能建在密文上。
- `url_hash`（`cached_repos.url_hash`，8-hex sha1，唯一）是**确定性且凭据无关**的键（`canonicalForHash` 剥 userinfo）。它可安全留明文（sha1 不可逆，且逆出也只是 host/path，已在 `url_redacted` 里）。
- `secretBox` 已在 `AppDeps`（`server.ts:74 secretBox?: SecretBox`），真实启动在 `cli/start.ts:359 createSecretBox(Paths.secretKeyFile)` 无条件创建；仅测试可能省略。OIDC 的 `client_secret_enc`（`services/oidcProviders.ts:82/96`）是 seal/unseal 的参照实现与列命名范式（`*_enc`）。

---

## 2. 目标数据模型

### 2.1 列变更（migration 0098，全部 nullable，rolling-upgrade 安全）

`cached_repos`（`db/schema.ts:666`）：
| 列 | 类型 | 语义 |
| --- | --- | --- |
| `url` | text（保留） | **cutover 后清空为 `''`**；不再读；drop 列列为 follow-up（见 §6.3） |
| `url_enc` | text (nullable) | `secretBox.seal(明文URL)`；仅 git 操作时 `unseal` |
| `url_redacted` | text (nullable) | `redactGitUrl(明文URL)`；出线/展示/日志唯一来源 |
| `url_hash` | text（保留，唯一） | 不变；去重与 join 键 |

`tasks`（`db/schema.ts:709`，legacy 顶层镜像 task_repos[0]）与 `task_repos`（`db/schema.ts:887`）各加：
| 列 | 类型 | 语义 |
| --- | --- | --- |
| `repo_url` | text（保留） | cutover 后清空为 `''`；drop 列 follow-up |
| `repo_url_enc` | text (nullable) | `seal(明文repoUrl)`；null 表示 path/scratch/internal 源 |
| `repo_url_redacted` | text (nullable) | 出线唯一来源 |
| `cached_repo_id` | text (nullable) | 指向 `cached_repos.id`；确定性 ref 键，替代明文 join |

> 选 `cached_repo_id`（FK 语义）而非在 tasks 复制 `url_hash`：与本 RFC 的 reuse-by-id 天然一致（任务记录它复用了哪个镜像），并让 `refTaskCount`/删除守卫直接按 id 计数。`url_hash` 在 cached_repos 侧唯一 → id ↔ hash 一一对应，backfill 可确定性回填。

### 2.2 SQLite ALTER 注意

- SQLite 只支持 `ADD COLUMN`；0098 只做 `ALTER TABLE ... ADD COLUMN`（6 列，见 plan T2）。多语句 migration 必须 `--> statement-breakpoint` 分隔（记忆 `reference_migration_statement_breakpoint`），否则只应用第一条。
- **不在 0098 里 drop `url`/`repo_url`**：drop 需重建表，且 backfill 是 SQL 之后的 JS 步骤，无法在同一 migration 内保证 `*_enc` 已填。清空明文由 backfill 完成；drop 空列作为独立 follow-up migration（`0099`，本 RFC 不含，避免 rolling-upgrade 掉列风险）。

---

## 3. 接口契约

### 3.1 shared schema

`shared/schemas/cachedRepo.ts`：
```ts
export const CachedRepoSchema = z.object({
  id: z.string(),
  // url 字段删除。凭据永不出线。
  urlRedacted: z.string(),   // 唯一 URL 展示来源
  localPath: z.string(),
  // ...其余不变
})
```

`shared/schemas/task.ts`（三处响应形 :104/:193/:310）：
```ts
// repoUrl: z.string().nullable()   ← 删除（曾"may contain credentials"）
repoUrlRedacted: z.string().nullable(),   // 脱敏形，展示用
cachedRepoId: z.string().nullable(),      // 复用/重启预填用；path/scratch/internal 源为 null
```
> 采用**重命名**（`repoUrl`→`repoUrlRedacted`）而非“同名字段改载荷”：让每个消费点因编译错误被强制复核，杜绝“误当明文使用”的回归（符合 prefer-correct-over-minimal）。

`StartTaskRequest` 及多仓 `repos[]`（`shared/schemas/task.ts:398` 一带）：新增可选 `cachedRepoId: z.string().optional()`。每个仓源的互斥规则扩为：`{repoUrl} | {cachedRepoId} | {repoPath 已废} | scratch | internalSource` **恰好一个**（`superRefine`）。`cachedRepoId` 与 `repoUrl` 同时出现 → 校验失败。

### 3.2 backend — gitRepoCache

- `rowToCached`（:165）：删 `url: row.url`；`urlRedacted: row.urlRedacted`（改读存储列，不再实时 `redactGitUrl(row.url)`）。
- 写路径（clone 新行 :551 / 复用回写）：`url_enc = secretBox.seal(input.url)`、`url_redacted = redactGitUrl(input.url)`、`url = ''`（不再写明文）、`url_hash` 不变。
- 解封点：凡需真实 URL 驱动 git 的地方（clone 的 `cloneArgs.push(input.url,...)` :499、错误消息用 redacted 不变）。复用 fetch 走镜像 origin 不需要 DB url；只有**新克隆**与**按 id 复用时的兜底 re-clone** 需要解封。
- `refTaskCount(db, url)` → `refTaskCount(db, cachedRepoId)`：`WHERE task_repos.cached_repo_id == :id`（`services/gitRepoCache.ts` 内改签名，调用点 :465/:601/:656/:740 随改）。
- `SecretBox` 由 `deps` 传入且**必需**（git 缓存是核心路径）。`ResolveCachedRepoDeps` 加 `secretBox: SecretBox`。

### 3.3 backend — 启动（task.ts）

`normalizeSources`（:438-446）与解析：
```
if (spec.cachedRepoId) {
  row = load cached_repos by id            // 全体登录用户可见（共享池），但只拿 row.id/urlRedacted/localPath
  realUrl = secretBox.unseal(row.url_enc)  // 仅服务端内存
  → resolveCachedRepo({url: realUrl, ...}) // 命中同一 url_hash → 复用镜像
  stamp: task_repos.cached_repo_id = row.id
         repo_url_enc = row.url_enc (直接搬，不重封)
         repo_url_redacted = row.url_redacted
} else if (spec.repoUrl) {                 // 首次接入新仓
  resolveCachedRepo({url: spec.repoUrl})   // 内部 seal 落 cached_repos
  stamp: cached_repo_id = resolved.cachedRepoId
         repo_url_enc = seal(spec.repoUrl)  // 或搬 resolved 行的 url_enc
         repo_url_redacted = redactGitUrl(spec.repoUrl)
}
```
- 解封仅发生在启动的一瞬且只在内存；`realUrl` 不落日志、不进 prompt（既有 prompt 隔离测试 `rfc099-prompt-isolation` 覆盖归属，本 RFC 另加一条“凭据不进 prompt”锁）。
- 兼容：外部脚本/PAT 仍可用 `repoUrl` 首启；`cachedRepoId` 为纯增字段。

### 3.4 backend — task 序列化

task list/detail 组装响应处（`routes/tasks.ts` / 相关 service，plan T5 定位）：输出 `repoUrlRedacted = row.repoUrlRedacted`、`cachedRepoId = row.cachedRepoId`；删明文 `repoUrl`。多仓 `repos[i]` 同构。

### 3.5 frontend

- `components/launch/RepoSourceRow.tsx:82/90`：下拉 `options = items.map(it => ({value: it.id, label: it.urlRedacted}))`；当前值比较改按 id；选中 → `onChange({kind:'url-reuse', cachedRepoId: it.id})`（或复用现有 `RepoSource` 联合类型加 `cachedRepoId` 分支，见 `lib/launch-repo-source.ts:15`）。手输新 URL 分支不变（走 `repoUrl`）。
- `lib/launch-repo-source.ts:131`：复用匹配由 `canonicalRepoKey(c.url)` 改为按 `cachedRepoId`；`toLaunchBody`（:256 一带）对 reuse 源发 `{cachedRepoId}`，对新 URL 源发 `{repoUrl}`。
- `routes/repos.tsx:216`：`redactGitUrl(pendingDelete.url)` → `pendingDelete.urlRedacted`。
- `components/memory/MemoryDialogShell.tsx:167`：`label: r.url` → `label: r.urlRedacted`（顺带修 ux-audit §10-③）。
- 任务详情/列表展示 `repoUrl` 的组件 → `repoUrlRedacted`。

### 3.6 backfill（代码级，幂等，启动时）

放在 daemon 启动 migrate 之后的一次性 pass（参照仓内既有 backfill 模式；`cli/start.ts` 序列里 secretBox 已就绪后）。伪码：
```
for row in cached_repos where url_redacted IS NULL:
  plain = row.url
  update set url_enc=seal(plain), url_redacted=redactGitUrl(plain), url=''
for tr in task_repos where repo_url_redacted IS NULL and repo_url<>'' and repo_url IS NOT NULL:
  plain = tr.repo_url
  hash = gitUrlCacheKeyWith(parseGitUrl(plain)).hash   // JS，SQL 做不到
  cr = cached_repos where url_hash=hash                 // 唯一
  update set repo_url_enc=seal(plain), repo_url_redacted=redactGitUrl(plain),
             cached_repo_id=cr?.id ?? null, repo_url=''
// tasks 顶层镜像同构
```
- 幂等：以 `*_redacted IS NULL` 为哨兵；二次运行零命中。
- 不可解析 / 无匹配 cached 行的 legacy repoUrl：仍封存 + 脱敏，`cached_repo_id` 留 null 并 `log.warn`（不阻断启动）。
- path-mode 已由 RFC-165 退役；残留 `repo_url` 为 file:// 也走 cache，正常封存。

---

## 4. 失败模式

| 场景 | 行为 |
| --- | --- |
| `secret.key` 丢失 | 已封存 URL 不可 unseal → 该 cached repo 无法再 clone/re-fetch（镜像在盘仍可用直到需重认证）。恢复＝删除该 cached repo + 重新启动（重输凭据）。与 OIDC client_secret 同款 key-loss 语义，`secretBox.ts:2` 已文档化。启动 backfill 若 secretBox 缺失（测试）→ 跳过 backfill 且不封存，git 路径要求 secretBox 存在则 fail closed。 |
| `cachedRepoId` 指向不存在/已删行 | 启动校验 404（与既有 not-found 同形，不泄漏存在性）。 |
| `cachedRepoId` 与 `repoUrl` 同传 | schema `superRefine` 拒绝（互斥）。 |
| backfill 中途崩溃 | 幂等哨兵使重启从未完成行继续；已封存行跳过。 |
| 解封得到的 `realUrl` 意外进日志/错误 | 所有日志/错误既有 `redactGitUrl` 包裹（gitRepoCache 已如此）；新增源码锁断言 `unseal(` 结果不流入 `log.*`/错误 details。 |
| 非确定性密文被误用于 join/dedup | 设计上 join 走 `cached_repo_id`、dedup 走 `url_hash`，均确定性；加测试锁 refTaskCount 不 join 密文列。 |
| 旧 run / 升级窗口读到空 `repo_url` 但 `*_redacted` 未回填 | backfill 覆盖历史行；序列化对 `repoUrlRedacted==null` 退化为 `null`（前端已按 nullable 渲染）。 |

---

## 5. 与现有模块耦合点

- **RFC-024 cached_repos**：本 RFC 收敛其 wire 与静态存储；`url_hash` 语义不动。
- **RFC-066 task_repos 多仓**：每仓源独立封存 / stamp；legacy 顶层 `tasks.repo_url` 作镜像同步处理。
- **RFC-036 secretBox**：复用 `seal`/`unseal` 与 `secret.key`；把 `AppDeps.secretBox` 在 git/启动路径由“可选”提升为“必需”（测试注入 `createSecretBoxFromKey(fixedKey)`）。
- **RFC-165 file://**：file 源亦走 cache → 一并封存；不改其 legacy re-key 逻辑。
- **RFC-099 prompt 隔离**：凭据从不进 prompt；新增专锁与既有 `rfc099-prompt-isolation` 并列。
- **备份**：无需改 `services/backup.ts`——封存后 `db.sqlite` 自然不含明文。

---

## 6. Rolling-upgrade / 迁移策略

1. **0098 加列**（nullable）→ 旧代码读新库：忽略新列，读旧 `url`/`repo_url`（backfill 前仍在）→ 正常。
2. **新代码 + backfill**：填 `*_enc`/`*_redacted`/`cached_repo_id`，清明文列为 `''`。
3. **follow-up（非本 RFC）**：确认全实例已过 backfill 后，`0099` drop 空的 `url`/`repo_url` 列。本 RFC 交付后在 `plan.md` 记一条 deferred。
4. `_journal.json` 必须与 migration 文件同步；改后跑**全量** backend 套件（记忆 `feedback_full_suite_after_migration`：journal↔files 不一致会级联数千 DB 测试红）。`upgrade-rolling.test.ts` 的 `HEAD_TOTAL_MIGRATIONS` 为动态 `entries.length`，不含硬编码计数，但仍须本地全量验证。

---

## 7. 残留风险（诚实声明，列 follow-up）

- **R1 镜像 `.git/config` 明文凭据**：git 把 origin URL 明文存 `~/.agent-workflow/repos/*/.git/config`。本 RFC 不清洗。缓解思路（follow-up）：clone 后把 origin 改为无 userinfo 的 URL + 配 credential helper/askpass 注入。同属本机 chmod 目录、不经 wire，严重度低于 DB/备份。
- **R2 共享镜像凭据复用**：`url_hash` 凭据无关 → 首启者凭据服务全体复用者的 fetch。既有属性，非本 RFC 引入；若需隔离另立 RFC（每用户镜像或按凭据分桶）。
- **R3 空列残留**：`url`/`repo_url` 清空但未 drop（见 §6.3），cosmetic debt，`0099` follow-up 处理。

---

## 8. 测试策略（CLAUDE.md：改动必带测试；以下为必写 case）

**后端（`bun test`，先红后绿）**
- `rfc204-cross-user-cred-leak.test.ts`（P0 红锚）：userA 启动带 `TOKEN` 的私有 URL；userB `GET /api/cached-repos` → 响应 JSON 全文**不含 `TOKEN` 子串**，含 `urlRedacted`。
- `rfc204-task-wire-cred-leak.test.ts`（P1 红锚）：含凭据 repoUrl 的任务，成员 `GET /api/tasks/:id` 与列表 → 无 `TOKEN`，有 `repoUrlRedacted`+`cachedRepoId`。
- `rfc204-at-rest-sealing.test.ts`：启动后直查 sqlite 行——`url`/`repo_url` 为 `''`，`url_enc`/`repo_url_enc` `unseal` 回原 URL，全行字节不含明文 token。
- `rfc204-reuse-by-id.test.ts`：以 `cachedRepoId` 启动（body 无 `repoUrl`）→ 复用命中同 `url_hash` 镜像、git 认证成功、task 正确 stamp；`cachedRepoId`+`repoUrl` 互斥被拒；未知 id → 404 同形。
- `rfc204-backfill.test.ts`：植入 legacy 明文行（直插 `url`/`repo_url`，`*_redacted` NULL）→ 跑 backfill → 封存+脱敏+`cached_repo_id`+明文清空；二次运行 no-op；不可解析 URL 仍封存、id 留 null 且 warn。
- `refTaskCount` / 删除守卫：改按 `cached_repo_id` 计数正确（复用既有 `cached-repos*.test.ts` 扩断言）。
- 源码锁：`CachedRepoSchema` 无 `url` 字段；`rowToCached` 源码不出现 `url: row.url`；`refTaskCount` 不 join `url_enc`/`repo_url_enc`。
- 迁移：0098 apply + 全量套件绿 + journal 一致。

**shared（vitest/bun）**
- `cachedRepo`/`task` schema：`url`/`repoUrl` 已删、`urlRedacted`/`repoUrlRedacted`/`cachedRepoId` 就位；`StartTaskRequest` 互斥 `superRefine` 正反例。

**前端（vitest）**
- `RepoSourceRow`：下拉 option `value===it.id`、label 为 `urlRedacted`；选中产出 `{cachedRepoId}` 源；源码锁“option value 不得为明文 url / `it.url` 不作 value”。
- `MemoryDialogShell`：scope 标签用 `urlRedacted`（findByRole/文本断言无明文）。
- `repos.tsx`：删除确认展示 `urlRedacted`。
- 任务视图：repoUrl 展示点渲染 `repoUrlRedacted`。

**门槛**：`typecheck && lint && test && format:check` 全绿；全量 backend 套件；单二进制 build smoke；推后按 `feedback_post_commit_ci_check` 查 CI。
