# RFC-204 — 任务分解（v4）

关联 `proposal.md` / `design.md`。commit 前缀 `feat(security): RFC-204 仓库 Git 凭据封存/脱敏/复用改造`。遵守 CLAUDE.md 多人并发保留原则与「改动必带测试」。**v4 范围**（三轮设计门 + 用户拍板后）：cached_repos 封存 + wire 删 url + scheduled 自封存 + 四交互启动面 cachedRepoId + 记忆 join 迁移 + 备份 gate + WAL 抹除 + query 入口拒绝+展示脱敏+历史列 re-redact。**P0-b（origin 清洗/凭据注入）已移出 → RFC-205**。

---

## 依赖图
```
T0 query 拒绝+展示脱敏      ─┐
T1 shared schema ────────────────┼─> T3 gitRepoCache 封存/脱敏/refCount
T2 migration 0098 ───────────────┤   T4 四启动面 cachedRepoId
                                 ├─> T5 scheduled 自封存
                                 ├─> T6 记忆 scope join 迁移
                                 └─> T7 backfill gate + WAL + 备份前置 + SecretBox threading
T0 ─> T1/T3/T5 ; T2 ─> T3/T6/T7 ; T3 ─> T4
T0..T7 ─> T8 frontend ─> T9 回归+文档+STATE+RFC-205 预留
```
建议顺序：T0→T1→T2→T3→T4→T5→T6→T7→T8→T9。

## 子任务

### RFC-204-T0 · query 形凭据：入口拒绝 + 展示脱敏（轻量路线）
- `shared/git-url.ts`：新增 `assertNoQueryCredential(url)`（敏感 key 集）；`redactGitUrl` 追加敏感 query 脱敏。**`canonicalForHash` 不改**（改则触发既有 query 行 re-key + 唯一 hash 碰撞合并——三轮 #4）。
- 接入拒绝器：`StartTaskRequest`/四启动 schema 仓源校验 + schedule 保存校验。
- `rowToCached` 输出 `localPath` 前过 `redactSensitiveString`（历史 slug 可能含 token，且 `localPath` 在 wire 上）。
- 测试：`rfc204-query-credential`（拒绝器/redact 正反例/**canonicalForHash 未变锁**/localPath 无 token）。

### RFC-204-T1 · shared schema
- `cachedRepo.ts` 删 `url`。`task.ts` 三响应形加 `cachedRepoId`（`repoUrl` 保留＝已脱敏，更新注释）。`StartTaskRequest`/`repos[]`/`StartAgentTaskSchema`/`StartWorkgroupTaskSchema`/`LaunchSpaceFields` 加可选 `cachedRepoId`+互斥 superRefine。scheduled 拆 Request/Storage/Response 三套 schema（见 T5；Request 拒 `repoUrlEnc`、不进交互 StartTask）。
- 测试：schema 正反例、四启动 schema 互斥、scheduled 三套 schema 转换与 reparse 有效。

### RFC-204-T2 · migration 0098（加列）
- `0098_rfc204_repo_cred.sql`：cached_repos `ADD url_enc/url_redacted`；task_repos `ADD cached_repo_id`+`CREATE INDEX idx_task_repos_cached_repo_id`；tasks `ADD cached_repo_id`。逐句 `--> statement-breakpoint`。同步 `_journal.json`+`schema.ts`。
- 测试：`migration-0098-*`（列/索引/幂等）；**全量** backend 套件。

### RFC-204-T3 · gitRepoCache 封存/脱敏/refCount
- 写路径 `url_enc/url_redacted/url=''`；`rowToCached` 删 `url`；file:// re-key(`:338`)、refresh/delete 诊断(`:685`/`:782`) 改读 `url_redacted`；`refTaskCount` 改按 `cached_repo_id`（:465/:601/:656/:740）；`ResolveCachedRepoDeps` 加 `secretBox`。**不改 clone/fetch URL、不碰 origin**。
- 测试：封存后 row 无明文、rowToCached 无 url、refTaskCount 按 id、file:// re-key 仍工作。

### RFC-204-T4 · 四交互启动面 cachedRepoId 贯通
- `task.ts` normalizeSources cachedRepoId 分支（unseal→resolve→stamp）；agentLaunch/workgroupLaunch/applySpaceFields 透传；`task-wizard.ts` relaunch 重建 `{cachedRepoId}`（单/多仓）。
- **FF 警告显式脱敏**：`task.ts:1010-1014` 的 `repoUrl: r.repoUrl` 改 `redactGitUrl(...)`（`r.repoUrl` 来自 `:531` 的 `spec.repoUrl` **原文**——三轮 #3 纠正 v3 错误假设）。
- 测试：`rfc204-reuse-by-id`（四入口）、`rfc204-ff-warning-redacted`（断言实际日志载荷）、prompt 无凭据锁。

### RFC-204-T5 · scheduled 自封存（三套 schema + 两种输入 + 编辑保凭据）
- **拆三套 schema**（三轮 #5）：Request（只收明文 `repoUrl`⊕`cachedRepoId`，**拒** `repoUrlEnc`）/ Storage（只存 `{repoUrlEnc,repoUrlRedacted}`）/ Response（只出 `repoUrlRedacted` + 不透明 edit handle）+ 两处转换。
- **两种输入都封存**（三轮 #6）：`repoUrl`→直接封存；`cachedRepoId`（wizard 复用 `buildImmediateBody` 时发的）→ load+`unseal`+重新封存进 schedule（不 clone、不留引用）。
- **编辑往返保凭据**（三轮 #7）：PUT 携带 edit handle 时保留原 `repoUrlEnc`；仅显式给新源才重封。
- 触发/run-now unseal 启动；旧行读出即时兜底 redact。
- 测试：`rfc204-scheduled-payload-cred`（无 TOKEN、重放成功、删缓存后仍成功）、`rfc204-scheduled-contract`（拒外部密文/by-id 自持/空编辑往返）。

### RFC-204-T6 · 记忆 scope join 迁移
- `memoryInject.ts:360-365` / `memoryDistillScheduler.ts:179-184` 改按 `cached_repo_id`。
- 测试：`rfc204-memory-scope-cached-id`（私有仓命中 + 不误选）。

### RFC-204-T7 · backfill gate + WAL 抹除 + 备份前置
- `ensureCredentialsSealed(db, secretBox)` 幂等、**网络无关**：封存 cached_repos + 回填 task/tasks `cached_repo_id`（按 url_hash）+ scheduled 自封存 + **历史 query-token 污染列 re-redact**（`tasks.repo_url`/`task_repos.repo_url`/`cached_repos.last_submodule_sync_error`/`task_repos.submodule_init_error`/`scheduled_tasks.last_error`——三轮 #2，必须在物理抹除**前**改写）+ `secure_delete`/`wal_checkpoint(TRUNCATE)`/`VACUUM`。
- daemon 启动（`cli/start.ts`）与 backup CLI（`cli/backup.ts` VACUUM 前）都调用；`AppDeps.secretBox` 于 git/启动/备份路径提升为必需并 thread。
- 测试：`rfc204-backfill`（幂等/回填/scheduled/**零 clone 断言**/裸文件无明文）、`rfc204-backup-gate`、`rfc204-at-rest-sealing`。

### RFC-204-T8 · frontend
- `RepoSourceRow`（value=id/label=redacted/产 `{cachedRepoId}`）、`launch-repo-source`+`toLaunchBody`（复用按 id）、`task-wizard` relaunch、`repos.tsx:216`、`MemoryDialogShell.tsx:167`。
- 测试：各点断言 + 源码锁（option value 非明文 url）。

### RFC-204-T9 · 收口
- 补 `rfc204-cross-user-cred-leak`（P0-a 红锚）+ task 侧脱敏回归锁（覆盖 query）+ §7 余项。
- STATE.md 进行中→Done + 已完成表加行；plan.md RFC 索引状态更新。
- **预留 RFC-205**：在 plan.md RFC 索引加一行「RFC-205 运行时沙箱（agent 凭据/FS 隔离）· Reserved」指向本 RFC §2 移出范围，防编号复用、供后续 session 发现。
- 记 deferred：`0099` drop 空 `url`（R3）；R2 共享镜像凭据隔离。

---

## PR 拆分建议
默认**单 PR**（schema 删 `url` 牵连全链编译）。若过大：**P1 后端闭环（T0–T7）**整体落（wire+存储+封存+启动+scheduled+备份自洽），**P2 前端+回归（T8–T9）**紧随。四交互启动面（T4）+ scheduled（T5）不得漏。

## 验收清单（对齐 proposal §4）
- [ ] `GET /api/cached-repos` 整个响应体（含 `urlRedacted` **与 `localPath`**）对 userinfo 形与历史 query 形均无 token；`CachedRepoSchema` 无 `url`。
- [ ] 新提交的 query 凭据 URL 在 launch 与 schedule 保存被拒并给出可读错误；userinfo 形通过；`canonicalForHash` 未变（锁）。
- [ ] 历史 query-token 污染列（task×2 + error×3）经 gate 后已 re-redact，相应 API 无 token。
- [ ] `GET /api/scheduled-tasks` 无 token；重放成功；删缓存后重放仍成功；**以 `cachedRepoId` 创建的 schedule 亦自持**；**空编辑往返后触发仍成功**；Request schema 拒外部投递 `repoUrlEnc`。
- [ ] FF 警告实际日志载荷无 userinfo/query 凭据。
- [ ] `cached_repos.url` 空、`url_enc` unseal 回原（含 query token）；WAL checkpoint 后裸文件无 token。
- [ ] 四交互启动入口选历史私有仓复用成功、请求体无明文 repoUrl。
- [ ] refTaskCount / 记忆 scope 按 `cached_repo_id` 正确（私有仓记忆修复）。
- [ ] 升级后首次 `POST /api/backup` 与 `agent-workflow backup` 均已封存；backfill 零 clone。
- [ ] task 侧脱敏回归锁存在（覆盖 query）。
- [ ] `typecheck && lint && test && format:check`；全量 backend；单二进制 smoke；`_journal.json` 一致；CI 绿。
- [ ] 源码锁齐（schema 无 url / rowToCached 不 emit / RepoSourceRow value 非明文 / scheduled 不同存 id+url）。
- [ ] RFC-205 已在索引预留。
- [ ] 设计门 + 实现门 Codex review findings 折入。
