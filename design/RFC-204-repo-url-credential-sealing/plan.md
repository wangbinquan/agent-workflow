# RFC-204 — 任务分解

关联 `proposal.md` / `design.md`。默认单 RFC 单 PR；commit 前缀 `feat(security): RFC-204 仓库 URL 凭据静态封存与出线脱敏`。全程遵守 CLAUDE.md 多人并发保留原则（精确路径 `git add`、只描述本人改动）与“改动必带测试”。

---

## 依赖图

```
T1 (shared schema) ──┬─> T3 (gitRepoCache 封存/脱敏)
                     ├─> T4 (启动 reuse-by-id + 封存 + refCount)
                     └─> T5 (task 序列化脱敏)
T2 (migration 0098) ─┴─> T3, T4, T6
T3, T4 ──> T5
T6 (backfill + SecretBox threading) 依赖 T2、T3、T4
T1..T6 ──> T7 (frontend) ──> T8 (测试补齐 + 文档 + STATE)
```

建议实现顺序：T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8（每步带其单测；T8 收口跨主体回归与文档）。

---

## 子任务

### RFC-204-T1 · shared schema 契约
- `shared/schemas/cachedRepo.ts`：删 `url`，保留 `urlRedacted`。
- `shared/schemas/task.ts`：三处响应形（:104/:193/:310）`repoUrl`→`repoUrlRedacted`(nullable) + `cachedRepoId`(nullable)；`StartTaskRequest`/多仓 `repos[]`（:398 一带）新增可选 `cachedRepoId`，`superRefine` 保证仓源互斥（`repoUrl`⊕`cachedRepoId`⊕scratch⊕internalSource）。
- 测试：`cached-repo-schema-*`/`task` schema 正反例、互斥 superRefine。
- 产出：编译错误清单（后续 T3-T7 逐个消费点复核的锚）。

### RFC-204-T2 · migration 0098（加列）
- `db/migrations/0098_rfc204_repo_url_sealing.sql`：`ALTER TABLE cached_repos ADD COLUMN url_enc text` / `... url_redacted text`；`tasks` 与 `task_repos` 各 `ADD COLUMN repo_url_enc text` / `repo_url_redacted text` / `cached_repo_id text`。逐句 `--> statement-breakpoint`。
- 同步 `db/migrations/meta/_journal.json` + `db/schema.ts` 列定义。
- 测试：新增 `migration-0098-*.test.ts`（列存在、nullable、幂等 apply）；**跑全量 backend 套件**（记忆 `feedback_full_suite_after_migration`）。

### RFC-204-T3 · gitRepoCache 封存 / 解封 / 出线脱敏
- `ResolveCachedRepoDeps` 加 `secretBox: SecretBox`（必需）。
- 写路径（clone 新行 :551 / 复用回写）：`url_enc=seal(input.url)`、`url_redacted=redactGitUrl(input.url)`、`url=''`。
- `rowToCached`(:165)：删 `url: row.url`；`urlRedacted: row.urlRedacted`（读存储列）。
- 解封：仅 clone / 按 id 兜底 re-clone 用 `unseal`；错误/日志继续用 redacted。
- `refTaskCount`：签名与查询改按 `cached_repo_id`；调用点 :465/:601/:656/:740 随改。
- 测试：`git-repo-cache*.test.ts` 扩——封存后 row 无明文、rowToCached 无 `url`、refTaskCount 按 id。

### RFC-204-T4 · 启动 reuse-by-id + 封存 repo_url + stamp
- `services/task.ts`：`normalizeSources`/解析支持 `cachedRepoId` 分支（load row → `unseal(url_enc)` → `resolveCachedRepo` → stamp `cached_repo_id`/`repo_url_enc`/`repo_url_redacted`）；`repoUrl` 分支封存落 task_repos + tasks 顶层镜像。
- 未知 `cachedRepoId` → 404 同形；互斥违背 → 校验拒。
- 解封 `realUrl` 仅内存，不入日志/prompt。
- 测试：`rfc204-reuse-by-id.test.ts`、`rfc204-at-rest-sealing.test.ts`、prompt 不含凭据锁。

### RFC-204-T5 · task 序列化脱敏
- task list/detail 组装处（`routes/tasks.ts` / 对应 service）：输出 `repoUrlRedacted`/`cachedRepoId`，删明文 `repoUrl`；多仓 `repos[i]` 同构。
- 测试：`rfc204-task-wire-cred-leak.test.ts`（成员读无 token）。

### RFC-204-T6 · startup backfill + SecretBox threading
- 幂等 backfill pass（migrate 后、secretBox 就绪后）：封存历史 `cached_repos`/`tasks`/`task_repos` 明文、填 `*_redacted`、按 `url_hash` 回填 `cached_repo_id`、清明文列。哨兵 `*_redacted IS NULL`。
- 将 `AppDeps.secretBox` 在 git/启动路径由可选提升为必需并 thread（`cli/start.ts` 已创建）；测试注入 `createSecretBoxFromKey(fixedKey)`。
- 测试：`rfc204-backfill.test.ts`（封存/脱敏/回填/清空/幂等/不可解析 warn）。

### RFC-204-T7 · frontend 消费点
- `components/launch/RepoSourceRow.tsx`：下拉 `value=it.id`/`label=it.urlRedacted`；选中 → `{cachedRepoId}` 源。
- `lib/launch-repo-source.ts`：复用匹配按 id；`toLaunchBody` reuse 发 `{cachedRepoId}`、新 URL 发 `{repoUrl}`。
- `routes/repos.tsx:216`：用 `urlRedacted`。
- `components/memory/MemoryDialogShell.tsx:167`：label 用 `urlRedacted`（顺带修 ux-audit §10-③）。
- 任务详情/列表 repoUrl 展示点 → `repoUrlRedacted`。
- 测试：RepoSourceRow / MemoryDialogShell / repos 删除确认 / 任务视图断言 + 源码锁（option value 非明文 url）。

### RFC-204-T8 · 收口：跨主体回归 + 文档 + STATE
- 补齐 `rfc204-cross-user-cred-leak.test.ts`（P0 红锚）与全部 §8 未覆盖 case。
- 更新 `design/design.md`（若其对 cached_repos/task 存储有断言）与本 RFC 状态。
- `STATE.md`：进行中 RFC 行改 Done + 已完成表加一行；`plan.md` RFC 索引状态更新。
- 记 deferred：`0099` drop 空 `url`/`repo_url` 列（§6.3）；R1 镜像 `.git/config` 清洗；R2 共享镜像凭据隔离。

---

## PR 拆分建议

默认**单 PR**（T1–T8 一起），因为 schema 重命名（T1）会让 T3–T7 编译红，拆开会留中间不可编译态。若体量过大，可按“后端封存闭环（T1–T6）”+“前端消费（T7）+回归（T8）”两 PR，但 T1 的 schema 变更须与后端消费同 PR 落，前端 PR 紧随（其间 wire 已安全，前端只是改展示/复用键）。

---

## 验收清单（对齐 proposal §4）

- [ ] `GET /api/cached-repos` 对含凭据行无 token 子串；`CachedRepoSchema` 无 `url`。
- [ ] task list/detail wire 无 token；有 `repoUrlRedacted`+`cachedRepoId`。
- [ ] sqlite 行凭据列无明文；`*_enc` unseal 回原 URL。
- [ ] 前端历史仓下拉 value=`cachedRepoId`；复用请求体无明文 `repoUrl`；git 认证成功。
- [ ] `MemoryDialogShell` / `repos.tsx` 展示用 `urlRedacted`。
- [ ] backfill 封存历史 + 清明文 + 回填 id + 幂等。
- [ ] `refTaskCount`/删除守卫按 `cached_repo_id` 计数正确。
- [ ] `typecheck && lint && test && format:check` 全绿；**全量** backend 套件；单二进制 build smoke；`_journal.json` 一致。
- [ ] 源码防回归锁（schema 无 url / rowToCached 不 emit 明文 / RepoSourceRow option value 非明文）就位。
- [ ] 推送后按 `feedback_post_commit_ci_check` 查 GitHub Actions 绿。
- [ ] 设计门与实现门各跑一次 Codex review（记忆 `feedback_codex_review_after_changes`），findings 折入。
