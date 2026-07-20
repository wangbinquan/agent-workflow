# RFC-204 — 任务分解（v3）

关联 `proposal.md` / `design.md`。commit 前缀 `feat(security): RFC-204 仓库 Git 凭据封存/脱敏/复用改造`。遵守 CLAUDE.md 多人并发保留原则与「改动必带测试」。**v3 范围**（两轮设计门 + 用户拍板后）：cached_repos 封存 + wire 删 url + scheduled 自封存 + 四交互启动面 cachedRepoId + 记忆 join 迁移 + 备份 gate + WAL 抹除 + redactGitUrl query 修补。**P0-b（origin 清洗/凭据注入）已移出 → RFC-205**。

---

## 依赖图
```
T0 redactGitUrl+canonical query ─┐
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

### RFC-204-T0 · redactGitUrl / canonicalForHash query 修补
- `shared/git-url.ts`：`redactGitUrl` 追加敏感 query 脱敏（复用 `redactSensitiveString` key 集）；`canonicalForHash` 忽略敏感 query（保 hash 稳定）。
- 测试：`rfc204-redact-query` 正反例（userinfo×query 组合）；确认 `hash(redact(u))==hash(u)` 仍成立。

### RFC-204-T1 · shared schema
- `cachedRepo.ts` 删 `url`。`task.ts` 三响应形加 `cachedRepoId`（`repoUrl` 保留＝已脱敏，更新注释）。`StartTaskRequest`/`repos[]`/`StartAgentTaskSchema`/`StartWorkgroupTaskSchema`/`LaunchSpaceFields` 加可选 `cachedRepoId`+互斥 superRefine。scheduled 载荷 schema 接受 `{repoUrlEnc,repoUrlRedacted}` 封存变体（不进交互 StartTask、不同存 cachedRepoId）。
- 测试：schema 正反例、四启动 schema 互斥、scheduled 封存变体 reparse 有效。

### RFC-204-T2 · migration 0098（加列）
- `0098_rfc204_repo_cred.sql`：cached_repos `ADD url_enc/url_redacted`；task_repos `ADD cached_repo_id`+`CREATE INDEX idx_task_repos_cached_repo_id`；tasks `ADD cached_repo_id`。逐句 `--> statement-breakpoint`。同步 `_journal.json`+`schema.ts`。
- 测试：`migration-0098-*`（列/索引/幂等）；**全量** backend 套件。

### RFC-204-T3 · gitRepoCache 封存/脱敏/refCount
- 写路径 `url_enc/url_redacted/url=''`；`rowToCached` 删 `url`；file:// re-key(`:338`)、refresh/delete 诊断(`:685`/`:782`) 改读 `url_redacted`；`refTaskCount` 改按 `cached_repo_id`（:465/:601/:656/:740）；`ResolveCachedRepoDeps` 加 `secretBox`。**不改 clone/fetch URL、不碰 origin**。
- 测试：封存后 row 无明文、rowToCached 无 url、refTaskCount 按 id、file:// re-key 仍工作。

### RFC-204-T4 · 四交互启动面 cachedRepoId 贯通
- `task.ts` normalizeSources cachedRepoId 分支（unseal→resolve→stamp）；agentLaunch/workgroupLaunch/applySpaceFields 透传；`task-wizard.ts` relaunch 重建 `{cachedRepoId}`（单/多仓）。FF 警告点确认已脱敏（加锁）。
- 测试：`rfc204-reuse-by-id`（四入口）、prompt 无凭据锁。

### RFC-204-T5 · scheduled 自封存
- `scheduledTasks.ts` create/patch：存前把带凭据 `repoUrl`→`{repoUrlEnc,repoUrlRedacted}`；触发/run-now unseal 启动；`rowToScheduledTask` 出 redacted + 旧行即时兜底 redact。不引用 cache row、不 clone。
- 测试：`rfc204-scheduled-payload-cred`（无 TOKEN、重放成功、删缓存后重放仍成功）。

### RFC-204-T6 · 记忆 scope join 迁移
- `memoryInject.ts:360-365` / `memoryDistillScheduler.ts:179-184` 改按 `cached_repo_id`。
- 测试：`rfc204-memory-scope-cached-id`（私有仓命中 + 不误选）。

### RFC-204-T7 · backfill gate + WAL 抹除 + 备份前置
- `ensureCredentialsSealed(db, secretBox)` 幂等、**网络无关**：封存 cached_repos + 回填 task/tasks `cached_repo_id`（按 url_hash）+ scheduled 自封存 + `secure_delete`/`wal_checkpoint(TRUNCATE)`/`VACUUM`。
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
- [ ] `GET /api/cached-repos` 对 userinfo 形与 query 形均无 token；`CachedRepoSchema` 无 `url`。
- [ ] `GET /api/scheduled-tasks` 无 token；重放成功；删缓存后重放仍成功。
- [ ] `cached_repos.url` 空、`url_enc` unseal 回原（含 query token）；WAL checkpoint 后裸文件无 token。
- [ ] 四交互启动入口选历史私有仓复用成功、请求体无明文 repoUrl。
- [ ] refTaskCount / 记忆 scope 按 `cached_repo_id` 正确（私有仓记忆修复）。
- [ ] 升级后首次 `POST /api/backup` 与 `agent-workflow backup` 均已封存；backfill 零 clone。
- [ ] task 侧脱敏回归锁存在（覆盖 query）。
- [ ] `typecheck && lint && test && format:check`；全量 backend；单二进制 smoke；`_journal.json` 一致；CI 绿。
- [ ] 源码锁齐（schema 无 url / rowToCached 不 emit / RepoSourceRow value 非明文 / scheduled 不同存 id+url）。
- [ ] RFC-205 已在索引预留。
- [ ] 设计门 + 实现门 Codex review findings 折入。
