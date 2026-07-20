# RFC-204 — 技术设计（v3）

关联 `proposal.md`。file:line 按 2026-07-20 主干核对；实现前重读确认未被并发 session 动过。**v3 相对 v2 的差异**：删除 P0-b（origin 清洗 / `runGitAuthed` / askpass 注入 / 所有 fetch-submodule-working-branch 认证改造）→ RFC-205；scheduled 改**自封存**（不引用 cache row，避免 v2 的 #5/#8/#9）；folds redactGitUrl query 盲区。

---

## 1. 现状核对
| 存储 | 现状 | 结论（v3） |
| --- | --- | --- |
| `cached_repos.url` | 明文 | 封存 `url_enc` + `url_redacted`；wire 删 `url` |
| `scheduled_tasks.launch_payload` | 明文 JSON 内 repoUrl | 载荷内**自封存** `repoUrlEnc`+`repoUrlRedacted` |
| `tasks.repo_url` / `task_repos.repo_url` | 已脱敏（RFC-054） | 只加锁 + 加 `cached_repo_id` + 补 query 脱敏 |
| 镜像 `.git/config` origin | 明文 | **不处理**（→ RFC-205） |
| `redactGitUrl` | 只脱 userinfo，漏 query | 扩展脱敏敏感 query |
| `url_hash` | sha1(canonical, 剥 userinfo) | 确定性、凭据无关，留明文 |

关键既有事实：
- `secretBox.seal` 随机 IV → 密文非确定性，不可 join/dedup；参照 OIDC `client_secret_enc`（`oidcProviders.ts:82/96`）、`AppDeps.secretBox`（`server.ts:74`，`cli/start.ts:359` 无条件建）。
- `canonicalForHash` 剥 userinfo（且下修后忽略敏感 query）⇒ `hash(redact(u))==hash(u)` → 可从**已脱敏** task 行反推 `url_hash` 回填 `cached_repo_id`，backfill 无需明文、**无需联网 clone**。
- backup 仅打包 db.sqlite/config.json/skills/workflows，**不含 secret.key**（`backup.ts`）→ 封存对备份真实有效。

---

## 2. 数据模型（migration 0098，全 nullable）
`cached_repos`：`url`（保留，backfill 后清空 `''`，drop=0099）；`url_enc`（seal 明文URL）；`url_redacted`（redact 明文URL，出线唯一源）；`url_hash`（不变唯一）。
`task_repos`+`tasks`：各加 `cached_repo_id`（→cached_repos.id，确定性 ref）；`task_repos.cached_repo_id` **加索引** `idx_task_repos_cached_repo_id`（refTaskCount 每 cache row 求值，避免全表扫）。
`scheduled_tasks`：**不加列**——自封存改的是 `launch_payload` JSON 内容（`repoUrl`→`repoUrlEnc`/`repoUrlRedacted`），非 schema 列。

SQLite 仅 `ADD COLUMN`；0098 = cached_repos×2 + task_repos×1+index + tasks×1，逐句 `--> statement-breakpoint`（记忆 `reference_migration_statement_breakpoint`）。不在 0098 drop 旧列。

---

## 3. 接口 / 组件契约

### 3.1 redactGitUrl 扩展（fold 二轮 #2）
`shared/git-url.ts`：`redactGitUrl` 在现 userinfo 脱敏后，追加**敏感 query 脱敏**（复用 `redactSensitiveString` 的 key 集：`token|access_token|password|secret|api_key|…` 的 `?k=v`/`&k=v`）。`canonicalForHash` 亦忽略敏感 query（避免同仓不同 token 的 query 形分裂 hash）。新增单测正反例。**注意**：这同时补全 RFC-054 task 列对 query 形的既有盲区。

### 3.2 shared schema
- `cachedRepo.ts`：删 `url`，留 `urlRedacted`（唯一 URL 展示源）。
- `task.ts`（响应形 :104/:193/:310）：`repoUrl` 保留（已脱敏，注释更新）；新增 `cachedRepoId: z.string().nullable()`（relaunch/复用/记忆）。
- `StartTaskRequest`+`repos[]`（:398）+ `StartAgentTaskSchema` + `StartWorkgroupTaskSchema` + `LaunchSpaceFields`：全部新增可选 `cachedRepoId`；每仓源 `{repoUrl}⊕{cachedRepoId}⊕scratch⊕internalSource` 恰一（superRefine）。
- **scheduled 载荷 schema**：源对象里 `repoUrl` 允许被替换为 `{ repoUrlEnc: string; repoUrlRedacted: string }` 变体（**仅** scheduled 变体，不进交互 StartTask）；`scheduledPayloadSchemaFor` 接受该封存形，reparse 不失败（fold 二轮 #5——不把 cachedRepoId 塞进受校验 source、不同存两者）。

### 3.3 backend — gitRepoCache
- `rowToCached`（:169）删 `url`；`urlRedacted: row.urlRedacted`。
- 写路径：`url_enc=seal(input.url)`、`url_redacted=redactGitUrl(input.url)`、`url=''`。**不改 clone/fetch 的 URL**（origin 仍含凭据——P0-b 属 RFC-205）。
- file:// 旧行 re-key（`:338` 用 `parseGitUrl(cand.url)`）、refresh/delete 诊断（`:685`/`:782`）：改读 `url_redacted`（canonical 判定 hash 不变仍成立）。
- `refTaskCount(db,url)`→`refTaskCount(db,cachedRepoId)`：`WHERE task_repos.cached_repo_id==:id`；调用点 :465/:601/:656/:740 随改。
- `ResolveCachedRepoDeps` 加 `secretBox`（必需）。

### 3.4 backend — 四交互启动面 cachedRepoId 贯通
- `task.ts` `normalizeSources`：`cachedRepoId` 分支 = load row → `unseal(url_enc)` → `resolveCachedRepo({url:realUrl})`（命中同 url_hash 复用）→ stamp `task_repos.cached_repo_id`（tasks 顶层镜像同）。`repoUrl` 分支照旧（task 侧继续脱敏落库）。
- agent 启动（`agentLaunch.ts`）/ workgroup 启动（`workgroupLaunch.ts`）/ `applySpaceFields`：透传 `cachedRepoId`（fold 一轮 #6）。
- relaunch（`task-wizard.ts:321`）：从 task 行 `cachedRepoId` 重建 `{cachedRepoId}`（单/多仓）；不再发脱敏 `repoUrl`（今天对私有仓 auth 失败，顺带修）（fold 一轮 #9）。
- 解封 `realUrl` 仅内存传给 `resolveCachedRepo`；**FF 警告**（`task.ts:1010-1014` 现 log `r.repoUrl`）——因 origin 不清洗、且我们不在此引入解封 URL 入日志，`r.repoUrl` 此处已是脱敏值，保持即可（无新暴露）；加锁确认其为脱敏。

### 3.5 backend — scheduled 自封存（P1-a，fold #5/#8/#9）
- 保存（`scheduledTasks.ts` create/patch，`:232/:251/:296`）：若 payload 源含带凭据 `repoUrl` → 存前替换为 `{repoUrlEnc: seal(url), repoUrlRedacted: redact(url)}`。
- 触发/run-now：读回、`unseal(repoUrlEnc)` → 作为普通 `repoUrl` 启动（进 resolveCachedRepo，clone 发生在**触发时**、非升级时）。
- `rowToScheduledTask`（:119）：对含 `repoUrlEnc` 的行只出 `repoUrlRedacted`；对**尚未迁移**的旧行即时 `redactGitUrl` 兜底（迁移滞后也不出线明文）。
- **不引用 cache row** → 删缓存不断定时（fold #9）；**不 clone** → 升级/备份不联网（fold #8）；**不同存 id+url** → reparse 有效（fold #5）。

### 3.6 backend — 记忆 scope 迁移（fold 一轮 #5）
`memoryInject.ts:360-365` / `memoryDistillScheduler.ts:179-184` 现 `where(eq(cachedRepos.url, taskRow.repoUrl))`（redacted==plaintext，私有仓已 latent 失效，清空 url 后公有仓亦失效）→ 改按 `taskRow.cachedRepoId` 直取 `cached_repos.id`；补私有仓 scope 命中回归。

### 3.7 backend — 备份 gate + WAL 抹除（fold 一轮 #3/#4）
- `ensureCredentialsSealed(db, secretBox)` 幂等、**网络无关** gate（§4 backfill 主体）。daemon 启动（`cli/start.ts` migrate 后）**与** backup CLI（`cli/backup.ts` migrate 后、`VACUUM INTO` 前）**都调用** → 杜绝「升级后首次备份含明文」。
- 末尾：`PRAGMA secure_delete=ON` 后重写受影响行、`wal_checkpoint(TRUNCATE)`、`VACUUM` → 主库物理页无残留（VACUUM INTO 产物天然新库无 free page）。裸文件校验测试（§7）。

### 3.8 frontend
- `RepoSourceRow.tsx:82/90`：option `value=it.id`/`label=it.urlRedacted`；选中产 `{cachedRepoId}` 源。手输新 URL 分支不变。
- `launch-repo-source.ts:131`+`toLaunchBody`：复用按 id；reuse 发 `{cachedRepoId}`、新 URL 发 `{repoUrl}`。
- `task-wizard.ts` relaunch：见 §3.4。
- `routes/repos.tsx:216`：用 `urlRedacted`。
- `MemoryDialogShell.tsx:167`：label 用 `urlRedacted`（顺带修 ux-audit §10-③）。
- task 视图仍显示 `repoUrl`（已脱敏，无需改）。

---

## 4. Rolling-upgrade / backfill（`ensureCredentialsSealed`，代码级、幂等、网络无关）
migrate 后、secretBox 就绪后运行（daemon 启动 + backup CLI 共享）：
```
// cached_repos：哨兵 url_redacted IS NULL
for row where url_redacted IS NULL:
  plain=row.url; url_enc=seal(plain); url_redacted=redactGitUrl(plain); url=''   // 不 clone、不碰 origin
// task_repos/tasks：哨兵 cached_repo_id IS NULL 且 repo_url 非空
for tr: hash=gitUrlCacheKeyWith(parseGitUrl(tr.repo_url)).hash                    // 已脱敏，hash 仍成立
        cached_repo_id = (cached_repos where url_hash=hash)?.id ?? null(+warn)
// scheduled_tasks：解析 launch_payload；含带凭据 repoUrl→替换 {repoUrlEnc,repoUrlRedacted}（不建 cache row、不 clone）
// 末尾一次性：PRAGMA secure_delete=ON; 重写受影响行; wal_checkpoint(TRUNCATE); VACUUM
```
- 幂等：全部哨兵；二次运行零命中。不可解析/无匹配：cached 侧仍封存、task 侧 `cached_repo_id` 留 null+warn，不阻断。
- `_journal.json` 与 0098 同步；改后跑**全量** backend 套件（记忆 `feedback_full_suite_after_migration`）。`upgrade-rolling.test.ts` 的 `HEAD_TOTAL_MIGRATIONS` 动态 `entries.length`。
- follow-up `0099` drop 空 `cached_repos.url`。

---

## 5. 失败模式
| 场景 | 行为 |
| --- | --- |
| `secret.key` 丢失 | `url_enc`/`repoUrlEnc` 不可 unseal → 该仓/定时无法再 clone/fetch（镜像在盘只读可用直到需认证）。恢复＝删 cached repo/重存定时（重输凭据）。同 OIDC key-loss。 |
| `cachedRepoId` 不存在/已删 | 启动 404 同形。 |
| `cachedRepoId`+`repoUrl` 同传 | superRefine 拒。 |
| backfill 中途崩 | 哨兵重启续做；已处理跳过。**永不联网**故不受远端可用性影响。 |
| 升级后首次 backup CLI | 先过 `ensureCredentialsSealed` 再 VACUUM → 产物已封存。 |
| scheduled 迁移前旧行被读 | `rowToScheduledTask` 即时兜底 redact，不出线明文。 |
| 非确定性密文误用于 join | join 走 `cached_repo_id`、dedup 走 `url_hash`；加锁测不 join 密文。 |
| query-token URL | redactGitUrl 扩展后脱敏；封存保原始（含 query token）以复用。 |

---

## 6. 与现有模块耦合点 & 残留
RFC-024（wire+静态收敛，`url_hash` 不动）；RFC-054 W3-4（task 脱敏——加锁+补 query，不改机制）；RFC-066（加 `cached_repo_id`）；RFC-036（复用 seal/unseal，`AppDeps.secretBox` 于 git/启动/备份路径提升为必需，测试注入 `createSecretBoxFromKey(fixedKey)`）；RFC-159（scheduled 载荷自封存）；RFC-165（file:// re-key 改读 redacted）；RFC-099（凭据从不进 prompt，加锁）。
**残留（→ 独立 RFC）**：**R1 = RFC-205 运行时沙箱**（agent 同 UID 读 key/DB/origin——本 RFC 明确不解决）；R2 共享镜像凭据复用（`url_hash` 凭据无关）；R3 空列 `0099` drop。

---

## 7. 测试策略（必写；先红后绿）
**后端**
- `rfc204-cross-user-cred-leak`（P0-a 红锚）：userA 带 userinfo 形 + query 形 TOKEN 启动；userB `GET /api/cached-repos` → 无 TOKEN、有 `urlRedacted`。
- `rfc204-scheduled-payload-cred`（P1-a 红锚）：存含 TOKEN 定时任务 → `GET /api/scheduled-tasks` 无 TOKEN；重放认证成功；**删其缓存后重放仍成功**（自持凭据）。
- `rfc204-at-rest-sealing`：启动后 `cached_repos.url` 空、`url_enc` unseal 回原（含 query token）；`wal_checkpoint` 后**裸文件**无 TOKEN。
- `rfc204-reuse-by-id`：四入口（task/agent/workgroup/relaunch）以 `cachedRepoId` 复用成功、无明文 repoUrl；互斥违背拒；未知 id 404。
- `rfc204-backfill`：植入 legacy 明文 cached 行 + 已脱敏 task 行 + 明文 scheduled → gate 后封存/回填/scheduled 自封存/清空；幂等 no-op；**断言零 git clone**（mock spawn 计数）；不可解析 warn。
- `rfc204-memory-scope-cached-id`：私有仓记忆 scope 按 `cached_repo_id` 命中；`memoryDistillScheduler` 不误选。
- `rfc204-backup-gate`：升级后**首次** backup CLI 产物已封存（无 TOKEN）。
- `rfc204-redact-query`：`redactGitUrl`/canonicalForHash 对 `?access_token=` 正反例。
- `refTaskCount`/删除守卫按 `cached_repo_id` 计数正确。
- 源码锁：`CachedRepoSchema` 无 `url`；`rowToCached` 不 emit `url: row.url`；**task 侧脱敏锁**（落库仍脱敏、覆盖 query）；scheduled 载荷不同存 `cachedRepoId`+`repoUrl`；join 不落密文列。
- 迁移：0098 apply + 全量套件绿 + journal 一致。

**shared**：`cachedRepo` 无 `url`；`task` 加 `cachedRepoId`；四启动 schema 互斥 superRefine；scheduled 封存变体 reparse 有效；redactGitUrl query。

**前端**：`RepoSourceRow`（value=id/label=redacted/产 `{cachedRepoId}`/源码锁 option value 非明文）；relaunch 走 cachedRepoId；`MemoryDialogShell`/`repos.tsx` 用 redacted。

**门槛**：`typecheck && lint && test && format:check`；全量 backend；单二进制 smoke；推后查 CI；设计门 + 实现门 Codex review。
