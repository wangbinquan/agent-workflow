# RFC-204 — 任务分解（v2）

关联 `proposal.md` / `design.md`。commit 前缀 `feat(security): RFC-204 仓库 Git 凭据全链路封存/隔离/脱敏`。遵守 CLAUDE.md 多人并发保留原则与「改动必带测试」。范围经 2026-07-19 设计门 + 用户拍板扩为：cached_repos 封存 + wire 脱敏 + **origin 清洗/凭据注入** + **scheduled 封存** + 记忆 join 迁移 + 全启动面 cachedRepoId + 备份 gate + WAL 抹除。

---

## 依赖图
```
T1 shared schema ─┬─> T4 gitRepoCache 封存/脱敏/refCount
T2 migration 0098 ┤   T5 凭据注入+origin清洗 (util/gitCredentials)
                  ├─> T6 启动/relaunch/agent/workgroup/scheduled cachedRepoId 贯通
                  ├─> T7 记忆 scope join 迁移
                  └─> T8 backfill gate + WAL 抹除 + 备份前置 + SecretBox threading
T4,T5 ─> T6 ; T2 ─> T4/T7/T8 ; T5 ─> T8(scrub 既有镜像)
T1..T8 ─> T9 frontend ─> T10 回归+文档+STATE
```
建议顺序：T1→T2→T5→T4→T6→T7→T8→T9→T10（T5 凭据注入先落，T4 clone 即用它 scrub）。

## 子任务

### RFC-204-T1 · shared schema
- `cachedRepo.ts` 删 `url`。`task.ts` 三响应形加 `cachedRepoId`（`repoUrl` 保留＝已脱敏，更新注释）。`StartTaskRequest`/`repos[]`/`StartAgentTaskSchema`/`StartWorkgroupTaskSchema`/`LaunchSpaceFields` 加可选 `cachedRepoId` + 仓源互斥 `superRefine`。
- 测试：schema 正反例、四启动 schema 互斥。

### RFC-204-T2 · migration 0098（加列）
- `0098_rfc204_repo_cred.sql`：cached_repos `ADD url_enc/url_redacted`；task_repos `ADD cached_repo_id` + `CREATE INDEX idx_task_repos_cached_repo_id`；tasks `ADD cached_repo_id`。逐句 `--> statement-breakpoint`。同步 `_journal.json` + `schema.ts`。
- 测试：`migration-0098-*`（列/索引/幂等）；**全量** backend 套件。

### RFC-204-T5 · 凭据注入 + origin 清洗
- 新 `util/gitCredentials.ts`：`scrubOrigin(dir, redactedRemote)`、`runGitAuthed(cwd,args,{plaintextUrl})`（GIT_ASKPASS + chmod-600 临时脚本 + 仅子进程 env + finally 删；无 userinfo 直通 `runGit`）。
- 接入 clone(`gitRepoCache:499`)、fetch reuse(`:362`)、refresh(`:703`)、submodule、commit-push(`commitPushRunner:285/330`)；clone/backfill 后 `scrubOrigin`。
- 测试：`rfc204-agent-origin-scrub`（origin 无 userinfo、注入认证成功、mock askpass 断言不落 config）。

### RFC-204-T4 · gitRepoCache 封存/脱敏/refCount
- 写路径 `url_enc/url_redacted/url=''`；`rowToCached` 删 `url`；file:// re-key(`:338`)、refresh/delete 诊断(`:685`/`:782`) 改读 `url_redacted`；`refTaskCount` 改按 `cached_repo_id`（调用点 :465/:601/:656/:740）；`ResolveCachedRepoDeps` 加 `secretBox`。
- 测试：封存后 row 无明文、rowToCached 无 url、refTaskCount 按 id、file:// re-key 仍工作。

### RFC-204-T6 · 五启动面 cachedRepoId 贯通
- `task.ts` normalizeSources cachedRepoId 分支（unseal→resolve→stamp）；agentLaunch/workgroupLaunch/applySpaceFields 透传；`task-wizard.ts` relaunch 重建 `{cachedRepoId}`（单/多仓）；scheduled 保存载荷改写 + 启动解封；FF 警告 `task.ts:1010` redact。
- 测试：`rfc204-reuse-by-id`（五入口）、`rfc204-scheduled-payload-cred`、`rfc204-ff-warning-redacted`、prompt 无凭据锁。

### RFC-204-T7 · 记忆 scope join 迁移
- `memoryInject.ts:360-365` / `memoryDistillScheduler.ts:179-184` 改按 `cached_repo_id`。
- 测试：`rfc204-memory-scope-cached-id`（私有仓命中 + 不误选）。

### RFC-204-T8 · backfill gate + WAL 抹除 + 备份前置
- `ensureCredentialsSealed(db, secretBox)` 幂等：封存 cached_repos + scrubOrigin 既有镜像 + 回填 task/tasks `cached_repo_id`（按 url_hash）+ scheduled 载荷改写 + `secure_delete`/`wal_checkpoint(TRUNCATE)`/`VACUUM`。
- daemon 启动（`cli/start.ts`）与 backup CLI（`cli/backup.ts` VACUUM 前）都调用；`AppDeps.secretBox` 于 git/启动/备份路径提升为必需并 thread。
- 测试：`rfc204-backfill`（幂等/scrub/回填/scheduled/裸文件无明文）、`rfc204-backup-gate`、`rfc204-at-rest-sealing`。

### RFC-204-T9 · frontend
- `RepoSourceRow`（value=id/label=redacted/产 `{cachedRepoId}`）、`launch-repo-source`+`toLaunchBody`（复用按 id）、`task-wizard` relaunch、`repos.tsx:216`、`MemoryDialogShell.tsx:167`。
- 测试：各点断言 + 源码锁（option value 非明文 url）。

### RFC-204-T10 · 收口
- 补 `rfc204-cross-user-cred-leak`（P0-a 红锚）+ task 侧脱敏回归锁 + §8 余项。
- STATE.md 进行中→Done + 已完成表加行；plan.md RFC 索引状态更新。
- 记 deferred：`0099` drop 空 `url`（R3）；R1 注入 env 侧信道（askpass 改 fd）；R2 共享镜像凭据隔离。

---

## PR 拆分建议
默认**单 PR**（schema 重命名会牵连全链编译）。若过大，可拆两 PR：**P1 后端凭据闭环（T1–T8）**必须整体落（wire+存储+注入+启动+备份自洽），**P2 前端消费+回归（T9–T10）**紧随（其间 wire 已安全）。scheduled/agent/workgroup 启动面（T6）不得漏——否则复用在这些模式静默失败。

## 验收清单（对齐 proposal §4）
- [ ] `GET /api/cached-repos` 无 token；`CachedRepoSchema` 无 `url`。
- [ ] 镜像/worktree `git remote get-url origin` 无凭据；clone/fetch/push/submodule 注入认证成功。
- [ ] `GET /api/scheduled-tasks` 无 token；重放认证成功。
- [ ] `cached_repos.url` 空、`url_enc` unseal 回原；WAL checkpoint 后裸文件无 token。
- [ ] 五启动入口选历史私有仓复用成功、请求体/payload 无明文 repoUrl。
- [ ] refTaskCount / 记忆 scope 按 `cached_repo_id` 正确（私有仓记忆修复）。
- [ ] 升级后首次 `POST /api/backup` 与 `agent-workflow backup` 均已封存。
- [ ] task 侧脱敏回归锁存在。
- [ ] `typecheck && lint && test && format:check` 全绿；全量 backend；单二进制 smoke；`_journal.json` 一致；CI 绿。
- [ ] 源码锁齐（schema 无 url / rowToCached 不 emit / origin 无 userinfo / RepoSourceRow value 非明文）。
- [ ] 设计门 + 实现门 Codex review findings 折入。
