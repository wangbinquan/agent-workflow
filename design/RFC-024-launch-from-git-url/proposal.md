# RFC-024 启动任务时支持远端 Git URL（SSH / HTTPS）作为工作目录来源

> 状态：Draft
> 关联：现有 `StartTask.repoPath` / `createWorktree` 流程（`packages/backend/src/util/git.ts:149`、`packages/backend/src/services/task.ts:113`）；RFC-020（launcher 表单 multipart 扩展）；P-2-09 launcher 表单。

## 背景

当前启动任务只接受**本机已存在的 git 仓库绝对路径**：

- `StartTask.repoPath: z.string()`（`packages/shared/src/schemas/task.ts:73`），launcher 用 `RecentReposCard` + 路径输入框收集
- `services/task.ts startTask` 拿到 `repoPath` 后直接 `createWorktree({ repoPath, taskId, baseBranch, appHome })`
- `createWorktree` 首先 `requireGitRepo(repoPath)`：仓库必须已经在本机存在

这对"用户拿到一份 GitHub / GitLab / 公司 GitLab 上的仓库就想立刻让 agent 去看看"的入门体验是个硬门槛 —— 用户得先开终端、`git clone`、记下绝对路径、再粘到 launcher。

我们需要一个一等公民的"从 Git URL 起任务"的入口：launcher 直接接受 SSH (`git@host:path` / `ssh://`) 或 HTTP/HTTPS URL，框架负责把它 clone 到本机持久缓存，再走现有 `createWorktree` 链路。

## 目标

- launcher 表单的"Repo 路径"位置加一个二选一 tab/单选：**本地路径** | **远端 URL**
  - 本地路径模式：完全沿用现状，零行为变化
  - 远端 URL 模式：输入 URL + 可选 branch/tag/commit ref → Start
- 后端持久缓存 clone 结果在 `~/.agent-workflow/repos/{hash}-{name}/`；同 URL 后续任务复用同一缓存，仅 `git fetch --all --prune --tags`
- 新增极简管理页 `/repos`（或 Settings 子区）：列出已缓存仓库（URL / 路径 / 上次 fetch 时间 / 关联任务数），提供 **Refresh**（手动 fetch）和 **Delete**（删除缓存目录 + 记录）两个操作
- DB 多记一列 `tasks.repoUrl?: string` 保留 provenance（任务详情页显示"克隆自 <redacted url>"），DB `tasks.repoPath` 仍是落地后的本地缓存绝对路径，下游所有依赖 `repoPath` 的代码（worktree-files、repos refs/files、scheduler、runner、wrapper-git）零感知改动
- 完整 clone（无 `--depth` 限制），用户在 UI 可显式指定 ref（branch / tag / commit hash），不填则使用缓存里的 default branch
- 失败模式（auth fail / host unreachable / 非 git 仓 / ref 不存在）→ task 进 `failed` + earlyError 携带 **脱敏后**的 git stderr；launcher 表单获得 4xx 错误后保留用户填的字段，不清空

## 非目标

- **不做框架级 credential 管理**：不存 SSH key、不存 PAT、不做 OAuth flow。SSH 复用用户本机 `~/.ssh` / `ssh-agent`；HTTPS 私有仓由用户自己在 URL 里嵌 token（`https://x-token-auth:TOKEN@host/...`），框架仅做**日志/事件/DB/UI 全链路脱敏**
- **不做 webhook / 定时自动 fetch**：缓存仅在用户在 UI 显式 Refresh 或下次同 URL 起任务时才 `git fetch`
- **不做 partial / blobless / shallow clone**：v1 一律完整 clone，后续若需要再加 settings 旋钮
- **不做镜像 push**：worktree 上做的提交不会自动 push 回 origin，沿用现有行为
- **不做"准备阶段"的 clone preview**：launcher 不预先 clone，Start 之前 URL 只做语法校验；真正的 clone 发生在 task lifecycle 早期（与 `createWorktree` 同位置）
- **不替换或废弃本地路径模式**：两种模式并存，互斥但都是一等公民
- **不做 URL host 白名单**：本机服务，用户自负

## 用户故事

1. 用户在 `/workflows/$id/launch` 看到"Repo 来源"切换组件（默认仍是"本地路径"以兼容老用户习惯）
2. 切到"远端 URL"，填入 `git@github.com:foo/bar.git`（或 `https://github.com/foo/bar.git`），ref 框留空
3. 点 Start → 前端 POST `/api/tasks` 带 `{ repoUrl, ref? }`（而非 `repoPath`）
4. 后端：
   - `parseGitUrl` 语法校验，过 → `redactUrl` 后写日志
   - 计算 `urlHash`；查 `cached_repos`：
     - cache miss：`git clone <url> {cacheDir}` 串行（同 URL 互斥），成功后 upsert `cached_repos` 行并记录 default branch
     - cache hit：`git -C {cacheDir} fetch --all --prune --tags`（fetch 失败不致命，加 warning 继续）
   - 解析用户填的 ref（默认 default branch）到具体 commit，落败 → 400 `ref-not-found`，stderr 脱敏，前端表单回显
   - 沿用现有 `createWorktree({ repoPath: cacheDir, baseBranch: ref, taskId, appHome })`，worktree 路径仍是 `~/.agent-workflow/worktrees/{slug}/{taskId}`（slug 基于缓存路径）
   - `tasks` 行落 `repoPath=cacheDir` + `repoUrl=<原始 URL>`（DB 存原文，UI 渲染走 redact）
5. 任务详情页 `tasks.detail.tsx` 在"详细信息"tab 显示 `克隆自 git@github.com:foo/bar.git`（脱敏渲染）
6. 用户在 `/repos`（或 Settings → Cached repos）能看到所有缓存仓库，点 Refresh 触发 `git fetch`、点 Delete 触发缓存清理（关联任务的 worktree 路径与 task 行**保留不动**，仅删除上游 mirror dir + cached_repos 行，避免误删历史任务证据）

## 验收标准

- `StartTask` schema：`repoPath` 与 `repoUrl` 互斥且至少一个；二者同时为空或同时存在 → 400；URL 必须能被 `parseGitUrl` 接受（支持 `ssh://`、`git@host:path`、`http(s)://`，拒绝 `file://` 与无 scheme/无 user 的散文）
- 同 URL 两个任务并发 cold-start → 串行 clone，第二个等第一个完成后走 cache hit 路径（不能两个进程同时 `git clone` 到同一目录）
- Clone 失败、fetch 失败、ref 解析失败的 git stderr 在写日志 / event / API 响应前必须经过 `redactUrl`，禁止把 `https://user:pass@host/...` 中的 user:pass 段原文吐出来
- `cached_repos` 表至少包含：`id (ULID)` / `urlHash (unique)` / `url (text)` / `localPath` / `defaultBranch?` / `lastFetchedAt` / `createdAt`，并由 migration 0008 落库
- `tasks` 表新增 `repo_url text` 可空列；现有 path-mode 任务此列为 NULL，前端按是否 NULL 分支渲染
- 任务详情 UI 渲染 URL 时调用同一个 `redactUrl` 纯函数（与后端共享 from `@agent-workflow/shared`）
- `/repos` 管理页：列表（URL + redact / 缓存路径 / 上次 fetch 时间 / 引用任务数）+ Refresh / Delete 按钮 + Delete 二次确认（确认文案显示引用任务数）
- Delete 不级联删除 task 行或 worktree 目录（保护历史）；该 cached_repos 行被删后，再次用同 URL 起任务等同于 cold clone
- 现有 path-mode 启动表单 + 启动流程零回归（保留所有原 e2e / unit）
- 不向 stdout / response body / DB / events 表泄漏未脱敏的 URL；新增 `redact-url` 测试覆盖 6+ 形态（带 user:pass、带 token、不带 cred、`ssh://`、`git@host:`、纯 http）

## 与现有模块的关系

- `createWorktree`：完全不改，依然要求 cwd 是一个 git 仓库 —— 我们 clone 出的 cache dir 满足这点
- `wrapper-git`：拍 commit + worktree 状态，行为无变化
- `repos.ts` (`/api/repos/refs|files`)：继续接受 `repoPath`，URL 模式下前端拿到 cache.localPath 后照常调
- `upsertRecentRepo`：URL 模式下我们**不**写入 recent_repos（recent_repos 保持"本地路径"语义），URL 路径走新表 `cached_repos`，launcher 的 recent dropdown 不混入 URL 记录（避免歧义）；UI 在 URL tab 下走"Recent URLs"独立列表（同样数据源 `cached_repos`）
- `runner` / `scheduler` / `services/review.ts` / `services/clarify.ts`：零改动
- `services/gc.ts`：v1 不自动 GC cached_repos，需用户手动 Delete；后续可加 settings 旋钮

## 失败模式回顾

| 场景 | 处理 |
|------|------|
| URL 语法非法 / 不支持的 scheme | 400 `repo-url-invalid`，task 不创建，前端 URL 框红字 |
| Cold clone host unreachable / auth fail | 400 `repo-clone-failed` + 脱敏 stderr，task 进 `failed` + earlyError |
| Clone 成功但 default branch 异常（HEAD 缺失）| 仍可起任务（ref 给默认 main / master 兜底），warning 入日志 |
| 用户指定的 ref 不存在 | 400 `repo-ref-not-found` + stderr，cache 保留（不回滚 clone） |
| 同 URL 并发 cold-start | 进程内 Mutex 串行，第二请求等第一完成；锁竞争超 settings.gitCloneTimeoutMs（默认 30 min）→ 第二请求 504 |
| Fetch 失败但 cache 仍可用 | 不致命，warning 入日志 + event，继续 worktree-add |
| 缓存目录被外部破坏（用户 `rm -rf` 后未删 DB 行）| 启动 task 时探测：dir 不存在或非 git 仓 → 视为 cold，触发 clone 再 upsert（修正 DB 行） |
| Delete 时仍有 running 任务引用该缓存 | UI 二次确认弹窗显式列出该 N 个任务并解释"删除仅影响后续任务，历史 worktree 保留"，确认后才删 |
| Token-bearing URL 泄漏 | 全链路（log / event / API resp / DB read serialize / UI render）调用 `redactUrl`；新增 grep 源代码层兜底测试，确保没有 `url}` 这种裸字符串注入到响应/日志格式中 |

## 多人协作

- 不与 in-flight RFC-023（Clarify）共享 schema/DB 列：clarify 走 migration 0007，本 RFC 用 0008，与 RFC-022 0006 + clarify 0007 并存
- launcher 表单文件 `workflows.launch.tsx` 与 RFC-020 既有改动可能并行；改动落到独立"Repo 来源 segmented"区块，与 upload picker 互不重叠
- 不动 `services/scheduler.ts` / `services/runner.ts` / `services/review.ts` / `services/clarify.ts`，避开主要并发热区
