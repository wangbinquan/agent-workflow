# RFC-204 — 技术设计（v2）

关联 `proposal.md`。所有 file:line 按 2026-07-19 主干核对；实现前按 CLAUDE.md 规则重读确认未被并发 session 动过。v2 在 v1 基础上：删 task 列封存、加**凭据注入/origin 清洗**、加 **scheduled_tasks 封存**、加**记忆 join 迁移 / 备份 gate / WAL 抹除 / 全启动面 cachedRepoId 贯通 / 索引 / file:// 消费者**。

---

## 1. 现状核对（哪些是明文、哪些已脱敏）

| 存储 | 现状 | file:line | 结论 |
| --- | --- | --- | --- |
| `cached_repos.url` | **明文**（含凭据） | schema:666；写 gitRepoCache clone；出线 rowToCached:169 | 泄漏 P0-a，须封存 + wire 删 |
| 镜像 `.git/config` origin | **明文**（clone 时写入） | gitRepoCache:499 | 泄漏 P0-b，须清洗 origin + 注入式认证 |
| `scheduled_tasks.launch_payload` | **明文**（JSON 内 repoUrl） | scheduledTasks:251；出线:119 | 泄漏 P1-a，须封存/改引用 |
| `tasks.repo_url` | **已脱敏** `redactGitUrl` | task.ts:1547（RFC-054 W3-4） | 非泄漏；只加锁 + 加 `cached_repo_id` |
| `task_repos.repo_url` | **已脱敏** `redactGitUrl` | task.ts:1609 | 非泄漏；只加锁 + 加 `cached_repo_id` |
| `url_hash` | sha1(canonical, **剥 userinfo**) | git-url.ts canonicalForHash | 确定性、凭据无关，安全留明文 |

关键既有事实（决定设计）：
- `secretBox.seal` 随机 IV → **密文非确定性**，不可用于 join/dedup/唯一约束。参照 OIDC `client_secret_enc`（`oidcProviders.ts:82/96`）seal/unseal + `*_enc` 列名。`secretBox` 已在 `AppDeps`（`server.ts:74`），`cli/start.ts:359` 无条件创建。
- **所有 git 操作走单一 `runGit(cwd, args, {env})`**（`util/git.ts:132`，`Bun.spawn`），已 merge `nonInteractiveGitEnv()`（`GIT_TERMINAL_PROMPT=0` 等）。这是凭据注入的唯一 hook 点。
- `canonicalForHash` 剥 userinfo ⇒ **`hash(redactGitUrl(u)) == hash(u)`**。故可从**已脱敏**的 `tasks.repo_url` 反推 `url_hash` 去匹配 `cached_repos`，backfill `cached_repo_id` 无需明文（化解 v1 round-trip 顾虑）。

---

## 2. 数据模型（migration 0098，全部 nullable）

`cached_repos`：
| 列 | 语义 |
| --- | --- |
| `url`（保留） | backfill 后清空 `''`；不再读写明文；drop 列 = 0099 follow-up |
| `url_enc`（新） | `secretBox.seal(明文URL)`；仅注入认证时 unseal |
| `url_redacted`（新） | `redactGitUrl(明文URL)`；出线/展示/日志/诊断唯一来源 |
| `url_hash`（保留唯一） | 不变 |

`task_repos` + `tasks`（各加，**不**加 `*_enc`/`*_redacted`——已脱敏）：
| 列 | 语义 |
| --- | --- |
| `cached_repo_id`（新，nullable） | → `cached_repos.id`；确定性 ref，替代明文 join |

`task_repos.cached_repo_id` **加索引** `idx_task_repos_cached_repo_id`（refTaskCount 每 cache row 求值，避免全表扫，Codex #11）。

`scheduled_tasks`：不加列。凭据封存走**载荷改写**（§3.4）——把 payload 内 `repoUrl` 明文换成 `cachedRepoId` 引用 + `repoUrl` 脱敏形，复用同一 cachedRepoId 机制，避免再引入一套密文列与非确定性 join。

SQLite 只支持 `ADD COLUMN`；0098 仅 `ADD COLUMN`（cached_repos×2、task_repos×1+index、tasks×1），逐句 `--> statement-breakpoint`（记忆 `reference_migration_statement_breakpoint`）。不在 0098 drop 旧列（backfill 是其后 JS 步）。

---

## 3. 接口 / 组件契约

### 3.1 凭据注入 + origin 清洗（P0-b 核心）

新增 `util/gitCredentials.ts`：
```ts
// 把镜像 origin 改成无 userinfo 形（clone 后立即执行；backfill 对既有镜像补执行）
async function scrubOrigin(mirrorDir, redactedRemote): git remote set-url origin <no-userinfo>
// 受控认证 git 操作：在命令时经 GIT_ASKPASS 注入凭据，用后即删
async function runGitAuthed(cwd, args, { plaintextUrl }): GitRunResult
```
`runGitAuthed` 实现：
1. 从 `plaintextUrl` 解析 userinfo（token/user:pass）。无 userinfo → 直接走 `runGit`（公有仓无注入）。
2. 写一个 **chmod-600 临时 askpass 脚本** + 把 secret 放进**仅该 git 子进程可见的 env**（`GIT_ASKPASS=<script>`、secret 经 `AW_GIT_SECRET`/`AW_GIT_USER` 传给脚本读取）。脚本按 git 的两次 prompt（Username/Password）分别回 user / token。
3. 传 `-c credential.helper=` 清空继承 helper，`GIT_TERMINAL_PROMPT=0` 已在基线。
4. `finally` 删除临时脚本。
5. 认证操作永远对**注入用的目标 URL**执行，但**不把带凭据 URL 写回 origin**（origin 保持 scrubbed）。fetch/push 用 `runGitAuthed(cwd, ['fetch', scrubbedRemote, ...], {plaintextUrl})`——git 允许 `fetch <url>` 指定一次性 URL，凭据经 askpass 注入而不落 config。

接入点（全部从 `runGit` 换到 `runGitAuthed` 且随后 `scrubOrigin`）：
- clone：`gitRepoCache.ts:499`（clone 目标用带凭据 URL 经 askpass；clone 完 `scrubOrigin`）。
- fetch on reuse：`gitRepoCache.ts:362`。
- manual refresh fetch：`gitRepoCache.ts:703`。
- submodule sync/update：submodule 段（`gitRepoCache.ts:430`+ 及 `syncSubmodules`）——子模块凭据同源注入。
- commit-push：`commitPushRunner.ts:285`（push）/`:330`（fetch）。
- 凭据来源：调用方持 `cachedRepoId` → `unseal(cached_repos.url_enc)` 得 `plaintextUrl`，仅内存、仅传 `runGitAuthed`。

> **残留（§7 R1）**：注入期该 git 子进程的 env 含 secret，同 uid 进程理论上可竞态读 `/proc/<pid>/environ`。本 RFC 关闭稳定的「worktree 内 config 读 origin」面；瞬时 env 面列残留。可选加固（follow-up）：askpass 改从 fd/命名管道读，彻底不入 env。

### 3.2 shared schema
`shared/schemas/cachedRepo.ts`：删 `url`，留 `urlRedacted`（唯一 URL 展示源）。
`shared/schemas/task.ts`（响应形 :104/:193/:310）：**保留** `repoUrl`（已是脱敏值，语义不变，注释更新为「已脱敏落库」）；**新增** `cachedRepoId: z.string().nullable()`（relaunch/复用/记忆用）。
`StartTaskRequest` + 多仓 `repos[]`（:398）+ **`StartAgentTaskSchema`** + **`StartWorkgroupTaskSchema`** + **`LaunchSpaceFields`**：全部新增可选 `cachedRepoId`；`superRefine` 保证每仓源 `{repoUrl}⊕{cachedRepoId}⊕scratch⊕internalSource` 恰一（Codex #6）。

### 3.3 backend — gitRepoCache
- `rowToCached`（:169）：删 `url`；`urlRedacted: row.urlRedacted`。
- 写路径：`url_enc=seal(input.url)`、`url_redacted=redactGitUrl(input.url)`、`url=''`；clone 后 `scrubOrigin`。
- **file:// 旧行 re-key**（`:338` 用 `parseGitUrl(cand.url)`）、**refresh/delete 诊断**（`:685`/`:782`）：改读 `url_redacted`（re-key 的 canonical 判定用 redacted——hash 不变仍成立；诊断/label 用 redacted）（Codex #10）。
- `refTaskCount(db, url)` → `refTaskCount(db, cachedRepoId)`：`WHERE task_repos.cached_repo_id==:id`；调用点 :465/:601/:656/:740 随改。
- `ResolveCachedRepoDeps` 加 `secretBox: SecretBox`（必需）。

### 3.4 backend — 启动 / relaunch / 定时（cachedRepoId 贯通）
- `services/task.ts` `normalizeSources`：`cachedRepoId` 分支 = load row → `unseal(url_enc)` → `resolveCachedRepo({url: realUrl})`（命中同 url_hash 复用）→ stamp `task_repos.cached_repo_id`（tasks 顶层镜像同）。`repoUrl` 分支照旧（首次接入新仓；task 侧继续 `redactGitUrl` 落库）。
- **agent 启动**（`agentLaunch.ts`）/ **workgroup 启动**（`workgroupLaunch.ts`）/ `applySpaceFields`：透传 `cachedRepoId`（Codex #6）。
- **relaunch**（`task-wizard.ts:321`）：从 task 行 `cachedRepoId` 重建 payload 为 `{cachedRepoId}`（单/多仓均）；不再发脱敏 `repoUrl`（今天发脱敏值对私有仓 auth 失败，本改顺带修）（Codex #9）。
- **scheduled_tasks**：保存时若 payload 含带凭据 `repoUrl` → 解析/建 cached row → 载荷改写为 `{cachedRepoId, repoUrl: redactGitUrl(...)}` 存库；启动时按 `cachedRepoId` 解封驱动。`rowToScheduledTask` 出线只见 redacted + id（Codex #2）。迁移见 §5。
- 解封 `realUrl` 只在内存、只传 `runGitAuthed`；**FF 警告路径**（`task.ts:1010-1014` 现 `log` `r.repoUrl`）改 `redactGitUrl`（Codex #7，加带凭据 URL 的行为测试）。

### 3.5 backend — 记忆 scope 迁移（Codex #5）
`memoryInject.ts:360-365` 与 `memoryDistillScheduler.ts:179-184` 现 `where(eq(cachedRepos.url, taskRow.repoUrl))`（redacted==plaintext，私有仓已 latent 失效，且清空 url 后公有仓也失效）→ 改为按 `taskRow.cachedRepoId` 直取 `cached_repos.id`；补私有仓 scope 命中回归。

### 3.6 backend — 备份 gate + WAL 抹除（Codex #3/#4）
- 抽 `ensureCredentialsSealed(db, secretBox)` 幂等 gate（backfill 主体，§5）。daemon 启动（`cli/start.ts` migrate 后）**与** backup CLI（`cli/backup.ts` migrate 后、`VACUUM INTO` 前）**都调用**它 → 杜绝「升级后首次备份含明文」。
- backfill 完成末尾：`PRAGMA secure_delete=ON` 后重写受影响行、`wal_checkpoint(TRUNCATE)`、`VACUUM`（VACUUM INTO 备份天然是新库不含 free page；主库需上述抹除）→ 物理页无残留。裸文件校验测试（§8）。

### 3.7 frontend
- `RepoSourceRow.tsx:82/90`：option `value=it.id`/`label=it.urlRedacted`；选中产 `{cachedRepoId}` 源。手输新 URL 分支不变。
- `launch-repo-source.ts:131` + `toLaunchBody`：复用按 id；reuse 发 `{cachedRepoId}`、新 URL 发 `{repoUrl}`。
- `task-wizard.ts` relaunch：见 §3.4。
- `routes/repos.tsx:216`：用 `urlRedacted`。
- `MemoryDialogShell.tsx:167`：label 用 `urlRedacted`（顺带修 ux-audit §10-③）。
- task 视图仍显示 `repoUrl`（已是脱敏值，无需改）。

---

## 4. 失败模式
| 场景 | 行为 |
| --- | --- |
| `secret.key` 丢失 | `url_enc` 不可 unseal → 该仓无法 clone/fetch/push（镜像在盘只读可用直到需认证）。恢复＝删 cached repo + 重启（重输凭据）。同 OIDC key-loss（`secretBox.ts:2`）。 |
| `GIT_ASKPASS` 注入失败/非 https 认证（ssh key） | ssh 走 agent/key 不经 askpass；`runGitAuthed` 对无 userinfo URL 直通 `runGit`（不回归）。https 注入失败 → git 认证失败、redacted 错误上浮。 |
| origin 已 scrub 但需 re-auth fetch | fetch 用一次性 `fetch <url>` + askpass；origin 保持无凭据。 |
| `cachedRepoId` 不存在/已删 | 启动 404 同形（不泄存在性）。 |
| `cachedRepoId`+`repoUrl` 同传 | schema `superRefine` 拒。 |
| backfill 中途崩 | 幂等哨兵（`url_redacted IS NULL` / origin 仍含 userinfo）重启续做；已处理行跳过。 |
| 升级后首次 backup CLI | 先过 `ensureCredentialsSealed` 再 VACUUM → 产物已封存。 |
| 非确定性密文误用于 join | join 走 `cached_repo_id`、dedup 走 `url_hash`；加锁测 refTaskCount/记忆不 join 密文。 |
| scheduled payload 迁移前旧行 | `rowToScheduledTask` 对未迁移行输出前即时 redact `repoUrl`（迁移滞后也不出线明文）。 |

---

## 5. Rolling-upgrade / backfill（`ensureCredentialsSealed`，代码级幂等）
migrate 后、secretBox 就绪后运行（daemon 启动 + backup CLI 共享）：
```
// cached_repos：哨兵 url_redacted IS NULL 或 url<>''
for row where url_redacted IS NULL:
  plain = row.url
  url_enc=seal(plain); url_redacted=redactGitUrl(plain)
  scrubOrigin(row.localPath, url_redacted)   // 清洗既有镜像 origin
  url=''
// task_repos/tasks：哨兵 cached_repo_id IS NULL 且 repo_url<>'' 
for tr where cached_repo_id IS NULL and repo_url not null/empty:
  hash = gitUrlCacheKeyWith(parseGitUrl(tr.repo_url)).hash   // repo_url 已脱敏，hash 仍成立
  cr = cached_repos where url_hash=hash                       // 唯一
  cached_repo_id = cr?.id ?? null                            // 无匹配→null + warn
// scheduled_tasks：解析 launch_payload；含带凭据 repoUrl→建/取 cached row→改写 {cachedRepoId, repoUrl:redacted}
// 末尾一次性：PRAGMA secure_delete=ON; 重写受影响行; wal_checkpoint(TRUNCATE); VACUUM
```
- 幂等：全部有哨兵；二次运行零命中（含 origin 已 scrub 检测）。
- 不可解析 / 无匹配：仍封存 cached 侧、task 侧 `cached_repo_id` 留 null + `log.warn`，不阻断。
- `_journal.json` 与 0098 同步；改后跑**全量** backend 套件（记忆 `feedback_full_suite_after_migration`）。`upgrade-rolling.test.ts` 的 `HEAD_TOTAL_MIGRATIONS` 为动态 `entries.length`，无硬编码计数。
- follow-up `0099` drop 空 `cached_repos.url`（§7 R3）。

---

## 6. 与现有模块耦合点
RFC-024 cached_repos（wire+静态收敛，`url_hash` 不动）；RFC-054 W3-4（task 脱敏——本 RFC 加锁不改）；RFC-066 task_repos（加 `cached_repo_id`）；RFC-036 secretBox（复用 seal/unseal，`AppDeps.secretBox` 于 git/启动/备份路径由可选提升为必需，测试注入 `createSecretBoxFromKey(fixedKey)`）；RFC-159 scheduled_tasks（载荷改写）；RFC-034 submodule（注入同源）；RFC-165 file://（re-key 改读 redacted）；RFC-099 prompt 隔离（凭据从不进 prompt，加专锁）。

---

## 7. 残留风险（诚实声明 + follow-up）
- **R1 注入期 env 侧信道**：`runGitAuthed` 期间 secret 在 git 子进程 env，同 uid 可竞态读 `/proc`。本 RFC 关闭稳定的 worktree-config 面；env 面列 follow-up（askpass 改 fd/管道读，不入 env）。
- **R2 共享镜像凭据复用**：`url_hash` 凭据无关 → 首启者凭据服务全体复用者 git 操作。既有属性，非本 RFC 引入；隔离另立 RFC。
- **R3 空列残留**：`cached_repos.url` 清空未 drop，`0099` follow-up。

---

## 8. 测试策略（必写 case；先红后绿）
**后端**
- `rfc204-cross-user-cred-leak`（P0-a 红锚）：userA 带 TOKEN 启动私有仓；userB `GET /api/cached-repos` → 无 TOKEN 子串、有 `urlRedacted`。
- `rfc204-agent-origin-scrub`（P0-b 红锚）：启动后镜像与 worktree `git remote get-url origin` 输出无凭据；clone/fetch/push 经注入认证成功（用带凭据的本地 file:// with userinfo 或 mock askpass 断言注入路径）。
- `rfc204-scheduled-payload-cred`（P1-a 红锚）：存含 TOKEN 的定时任务 → `GET /api/scheduled-tasks` 无 TOKEN；重放认证成功。
- `rfc204-at-rest-sealing`：启动后 `cached_repos.url` 空、`url_enc` unseal 回原；`wal_checkpoint` 后**裸文件** `db.sqlite`+`-wal` grep 无 TOKEN。
- `rfc204-reuse-by-id`：五入口（task/agent/workgroup/scheduled/relaunch）以 `cachedRepoId` 复用成功、无明文 repoUrl；互斥违背拒；未知 id 404。
- `rfc204-backfill`：植入 legacy 明文 cached row + 已脱敏 task 行 → gate 后封存/scrub origin/清空/回填 `cached_repo_id`/scheduled 改写；幂等 no-op；不可解析 warn。
- `rfc204-memory-scope-cached-id`：私有仓记忆 scope 按 `cached_repo_id` 命中（今天 latent 失效）；`memoryDistillScheduler` 不再误选任意仓。
- `rfc204-backup-gate`：升级后**首次** backup CLI 产物已封存（无 TOKEN）。
- `rfc204-ff-warning-redacted`：cachedRepoId 启动产 FF 警告时日志/错误无 TOKEN。
- `refTaskCount`/删除守卫按 `cached_repo_id` 计数正确（扩既有 `cached-repos*.test.ts`）。
- 源码锁：`CachedRepoSchema` 无 `url`；`rowToCached` 不 emit `url: row.url`；`runGitAuthed`/scrub 使 origin 无 userinfo；**task 侧脱敏锁**（`task.ts` 落库仍 `redactGitUrl` — 防 RFC-054 回退）；join 不落密文列。
- 迁移：0098 apply + 全量套件绿 + journal 一致。

**shared**：`cachedRepo` 无 `url`；`task` 加 `cachedRepoId`；`StartTask/StartAgentTask/StartWorkgroupTask/SpaceFields` 互斥 superRefine 正反例。

**前端**：`RepoSourceRow`（value=id/label=redacted、产 `{cachedRepoId}`、源码锁 option value 非明文）；relaunch 走 cachedRepoId；`MemoryDialogShell`/`repos.tsx` 用 redacted。

**门槛**：`typecheck && lint && test && format:check` 全绿；全量 backend；单二进制 smoke；推后查 CI；设计门 + 实现门各一次 Codex review。
