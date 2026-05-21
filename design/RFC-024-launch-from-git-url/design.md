# RFC-024 技术设计

> 配套 `proposal.md`。在与 `design/design.md` 冲突时，本文件就 RFC-024 引入的接口、数据流、错误码具有最终解释权；其它部分仍以 `design/design.md` 为准。

## 1. Shared schema 改动（`packages/shared/src/`）

### 1.1 `schemas/task.ts`

```ts
export const StartTaskSchema = z.object({
  workflowId: z.string(),
  inputs: z.record(z.string()),
  baseBranch: z.string().optional(),         // 已有
  repoPath: z.string().min(1).optional(),    // 改为 optional
  repoUrl: z.string().min(1).optional(),     // 新增
  ref: z.string().min(1).optional(),         // 新增；URL 模式专用，给 worktree-add 的 base
}).superRefine((v, ctx) => {
  const hasPath = !!v.repoPath
  const hasUrl = !!v.repoUrl
  if (hasPath === hasUrl) {
    ctx.addIssue({ code: 'custom', message: 'exactly one of repoPath / repoUrl required' })
  }
  if (hasPath && (v.ref || v.repoUrl)) {
    // path 模式下 baseBranch 仍是合法入参；ref 只在 url 模式使用
  }
})
```

互斥规则在前端表单和后端入口都校验。

### 1.2 `task.ts` Task / TaskSummary 类型

`Task` / `TaskSummary` 新增 `repoUrl: string | null`（DB serialize 后总是显式给出）。`repoPath` 仍是必填字符串（无论哪种模式，最终都解析到一个本地绝对路径）。

### 1.3 新文件 `git-url.ts`

纯函数模块，前后端共享：

```ts
export type GitUrl =
  | { kind: 'ssh-uri';  user: string; host: string; port?: number; path: string; raw: string }
  | { kind: 'ssh-scp';  user: string; host: string; path: string; raw: string }
  | { kind: 'http' | 'https'; userInfo?: string; host: string; port?: number; path: string; raw: string }

export function parseGitUrl(input: string): GitUrl | null
export function redactGitUrl(input: string): string
/** 用于 cache 目录命名：sha1(canonicalUrl).slice(0,8) + '-' + lastPathSegmentSlug */
export function gitUrlCacheKey(parsed: GitUrl): { hash: string; slug: string }
```

`canonicalUrl` 规则：
- 去除尾部 `/` 和 `.git`
- ssh-scp 与 `ssh://user@host/path` 归一化为同一 hash
- userInfo（HTTPS 里的 `user:pass`）**不**进入 canonical（否则同仓不同 token → 多份 cache）

`redactGitUrl`：
- HTTPS：`://([^/@]+)@` → `://***@`
- SSH：不脱敏 user（一般是 `git`）；保留 host:path

### 1.4 新文件 `schemas/cachedRepo.ts`

```ts
export const CachedRepoSchema = z.object({
  id: z.string(),
  url: z.string(),
  urlRedacted: z.string(),
  localPath: z.string(),
  defaultBranch: z.string().nullable(),
  lastFetchedAt: z.string(),  // ISO
  createdAt: z.string(),
  referencingTaskCount: z.number().int().nonnegative(),
})
export const ListCachedReposResponseSchema = z.object({ items: z.array(CachedRepoSchema) })
```

## 2. DB 改动（`packages/backend/src/db/schema.ts` + migration 0008）

### 2.1 `tasks` 表

```sql
ALTER TABLE tasks ADD COLUMN repo_url TEXT;
```

drizzle 字段 `repoUrl: text('repo_url')`（可空）。

### 2.2 `cached_repos` 新表

```sql
CREATE TABLE cached_repos (
  id TEXT PRIMARY KEY,
  url_hash TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  local_path TEXT NOT NULL,
  default_branch TEXT,
  last_fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_cached_repos_last_fetched ON cached_repos(last_fetched_at);
```

迁移文件：`0008_rfc024_cached_repos.sql`，附 `0008_snapshot.json` + `_journal.json` idx 跟进。

### 2.3 与 RFC-022 / RFC-023 的迁移序号关系

RFC-022 占 0006、RFC-023 PR-A 占 0007。本 RFC 取 0008。如 RFC-023 先合 0007，本 RFC 序号不变；如 RFC-023 后于本 RFC 落地，对方负责把 0007 改成 0008+1（即 0009），本 RFC 落地后**不再回退**。

## 3. 新模块 `services/gitRepoCache.ts`

接口：

```ts
export interface ResolveCachedRepoDeps {
  db: DbClient
  appHome: string
  /** 测试注入：替换 git 命令。默认 `git`。 */
  gitCmd?: string
  /** Settings 读 settings.gitCloneTimeoutMs；测试可覆盖。 */
  cloneTimeoutMs?: number
  /** Settings 读 settings.gitFetchOnReuse（默认 true）。 */
  fetchOnReuse?: boolean
}

export interface ResolveCachedRepoInput {
  url: string                 // 原始 URL（包含可能的 user:pass）
}

export interface ResolveCachedRepoResult {
  cached: CachedRepo          // 来自 DB 的 row
  cold: boolean               // true 表示这次触发了 clone
  fetchOk: boolean            // 仅在 cold=false 时有意义；fetch 失败 → false
  defaultBranch: string | null
}

export async function resolveCachedRepo(
  deps: ResolveCachedRepoDeps,
  input: ResolveCachedRepoInput,
): Promise<ResolveCachedRepoResult>
```

实现要点：

1. `parseGitUrl(input.url)` 失败 → 抛 `ValidationError('repo-url-invalid')`
2. `gitUrlCacheKey` 得 `urlHash` + `slug`，cache 目录 `{appHome}/repos/{slug}` —— slug 已经包含 hash 前缀，避免不同 host 同名仓冲突
3. 进程内 mutex：`urlMutex.get(urlHash)?.run(async () => {...}) ?? createMutex(urlHash).run(...)`，串行同 URL 操作
4. SELECT cached_repos by urlHash：
   - 命中且本地 dir 存在且 `git rev-parse --git-dir` 成功：cold=false
     - 若 `fetchOnReuse`：`git -C dir fetch --all --prune --tags`；失败仅 log warning + 返回 fetchOk=false
     - 更新 `last_fetched_at`
   - 命中但本地 dir 异常（缺失 / 非 git 仓）：删 DB 行后走 cold path
   - 未命中：cold path
5. cold path：
   - 临时目录 `{slug}.partial-{ulid}` 下 `git clone <url> tmp`
   - 失败 → `rm -rf tmp`，抛 `DomainError('repo-clone-failed', redactedStderr)`
   - 成功 → 探测 default branch（`git -C tmp symbolic-ref --short HEAD`），失败 fallback null
   - `rename(tmp, finalCachePath)`（同盘原子 mv）
   - INSERT `cached_repos`
6. 所有 git 调用走 `redactUrl(input.url)` 的 stderr 重写：把任何包含 user:pass 子串的行替换为脱敏版

并发 cold 同 URL：mutex 保证一次只跑一条；第二请求拿锁后会发现 DB 行已存在，走 cache hit 分支。

### 错误码

| code | HTTP | 时机 |
|------|------|------|
| `repo-url-invalid` | 400 | parseGitUrl 返回 null |
| `repo-clone-failed` | 400 | cold clone 失败 |
| `repo-fetch-warning` | n/a (warn) | reuse 时 fetch 失败 |
| `repo-ref-not-found` | 400 | createWorktree 那一侧抛 `worktree-base-invalid` 时由 task service rewrap |
| `repo-cache-locked` | 504 | mutex 等待超 `cloneTimeoutMs`（默认 30 min） |

## 4. `services/task.ts` startTask 改动

新增分支处理：

```ts
async function resolveRepoSource(
  deps: StartTaskDeps,
  input: StartTask,
): Promise<{ repoPath: string; baseBranch: string | undefined; repoUrl: string | null }> {
  if (input.repoPath) {
    return { repoPath: input.repoPath, baseBranch: input.baseBranch, repoUrl: null }
  }
  if (!input.repoUrl) throw new ValidationError('start-task-source-required', '...')
  const resolved = await resolveCachedRepo(
    { db: deps.db, appHome: deps.appHome ?? Paths.root },
    { url: input.repoUrl },
  )
  return {
    repoPath: resolved.cached.localPath,
    baseBranch: input.ref ?? resolved.defaultBranch ?? undefined,
    repoUrl: input.repoUrl,
  }
}
```

`startTask` 的 `materializeWorktree` 调用前先跑 `resolveRepoSource`；DB 写 `tasks` 行时把 `repoUrl` 一起插入；`upsertRecentRepo` 仅对 path 模式调用。

`createWorktree` 抛 `worktree-base-invalid` → startTask 在 URL 模式下 rewrap 成 `repo-ref-not-found`（错误体里附 stderr 脱敏字段、附"可用的分支前 10 条"列表，由 `runGit cacheDir ['for-each-ref', '--count=10', ...]` 取）。

### `preCreatedWorktree` 的兼容（RFC-020 multipart 路径）

RFC-020 引入 `StartTaskDeps.preCreatedWorktree`，让 multipart 上传路径可以先建 worktree 再 upload。对 URL 模式同样适用：

- multipart 分支在 routes/tasks.ts 里现在的 `materializeWorktree` 之前调用 `resolveRepoSource`
- 这意味着同一次请求会触发 clone（可能耗时分钟级），multipart body 已读完不阻塞；超时由 `cloneTimeoutMs` + Hono 默认设置兜底，**前端必须在 URL 模式下展示"克隆中"动画 + 提示首次可能耗时**

## 5. HTTP 路由

### 5.1 `POST /api/tasks`

JSON / multipart 两路都新增 `repoUrl` + `ref` 字段（互斥校验沿用 `StartTaskSchema`）。返回 4xx 时 `error.code` 取上节错误码，`error.message` 已脱敏。

### 5.2 新增 `/api/cached-repos`

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/cached-repos` | 列表，response = `ListCachedReposResponse`；`referencingTaskCount` 来自 `tasks WHERE repo_url = …` count |
| POST | `/api/cached-repos/:id/refresh` | 强制 `git fetch --all --prune --tags`，更新 `last_fetched_at` |
| DELETE | `/api/cached-repos/:id` | rm -rf cache dir + DELETE row；query `?force=1` 跳过引用任务的二次确认（前端调用时附） |

DELETE 默认逻辑：如果 referencingTaskCount > 0 且未带 force=1 → 409 `cached-repo-has-references` + 携带 count；前端弹窗显式列引用任务数后带 force=1 重试。

## 6. 前端改动

### 6.1 `workflows.launch.tsx`

`RepoSourceTabs.tsx` 新组件：

```
[ 本地路径 ] [ 远端 URL ]
─────────────────────────
模式 = path：
  ┌────────────────────────────────┐
  │ <existing RecentReposCard>      │
  │ <existing path <input/>>        │
  └────────────────────────────────┘
模式 = url：
  ┌────────────────────────────────┐
  │ Git URL  [ git@github.com:foo/bar.git ]  │
  │ Branch / tag / commit (optional)         │
  │ [ main, feat/x, v1.2.0, a3f9c… ]         │
  │ Recent URLs (from /api/cached-repos):    │
  │   ○ github.com/foo/bar  · 上次 fetch 2h 前│
  │   ○ gitlab.com/...                       │
  └────────────────────────────────┘
  小字提示：首次克隆可能需要数分钟；后续启动会复用本地缓存。
```

state shape：

```ts
type RepoSource =
  | { kind: 'path'; repoPath: string; baseBranch: string }
  | { kind: 'url';  repoUrl: string;  ref: string }
```

Start 按钮校验：URL 模式下 `repoUrl.trim().length === 0` 则 disable + 红字。前端 URL 语法预校验复用 `parseGitUrl`（shared 模块）。

提交时 body 选支：

```ts
const body = source.kind === 'path'
  ? { ...common, repoPath: source.repoPath, baseBranch: source.baseBranch }
  : { ...common, repoUrl: source.repoUrl, ref: source.ref || undefined }
```

multipart（RFC-020 upload kind）路径同样按 source.kind 选发 `repoPath` 或 `repoUrl` 字段。

### 6.2 任务详情页

`tasks.detail.tsx` "详细信息" tab 渲染：

```
源仓库：克隆自 github.com/foo/bar.git
        缓存路径 ~/.agent-workflow/repos/xxxx-bar
```

URL 渲染走 `redactGitUrl`。Path 模式下仍只显示 `repoPath`。

### 6.3 新页面 `/repos`

路由 `packages/frontend/src/routes/repos.tsx`：

```
缓存的远端仓库
────────────────────────────
URL                 缓存路径        上次 fetch    引用任务  操作
github.com/foo/bar  ~/.agent-w...  3h 前         5         [Refresh] [Delete]
gitlab.com/...      ...            2d 前         12        [Refresh] [Delete]
```

Delete 弹窗：

```
确定删除 github.com/foo/bar 的缓存？
该缓存目前被 5 个历史任务引用。
删除后历史任务的 worktree 与详情页保留，但
后续用同一 URL 启动任务会重新克隆。
                                  [取消] [确认删除]
```

## 7. 测试策略

### 7.1 Shared (`packages/shared/tests/`)

- `git-url-parse.test.ts`：覆盖 ssh-scp / ssh-uri / https / http / 带 user:pass / 带 :port / 带 .git 后缀 / 无效（file://、裸字符串、空、含空格）共 12 case
- `git-url-redact.test.ts`：6 形态（带 user:pass、带 token、不带 cred、`ssh://`、`git@host:`、纯 http）
- `git-url-cache-key.test.ts`：canonical 规范化使 `git@github.com:foo/bar.git` 与 `ssh://git@github.com/foo/bar` 与 `git@github.com:foo/bar/` 同 hash；带不同 user:pass 的 https 同 hash

### 7.2 Backend (`packages/backend/tests/`)

- `git-repo-cache.test.ts`：使用 fixture 本地 bare 仓 (`file:///tmp/...` 也走 git clone 路径) — cold clone → 命中 → 强制 fetch → 第三次进来；DB 行正确；rename atomic 模拟；并发同 URL（两个 promise 同时调用 resolveCachedRepo）只跑一次 clone（spy on git command count）
- `git-repo-cache-error.test.ts`：clone 失败 → 抛 `repo-clone-failed`，stderr 已脱敏（含 user:pass 的 url 不出现）；fetch 失败 → fetchOk=false 不抛
- `start-task-url.test.ts`：URL 模式起 task，worktreePath 正确、tasks 行 repoUrl 写入、recent_repos **未**写入；URL 不存在的 ref → `repo-ref-not-found` + 列表
- `tasks-http-url.test.ts`：POST /api/tasks 同时给 repoPath + repoUrl → 400；仅 repoUrl → 200；脱敏 URL 在 4xx response body 里
- `cached-repos-http.test.ts`：GET 列表 / POST refresh / DELETE 行为；DELETE 在 count > 0 且无 force → 409；带 ?force=1 → 200
- `redact-url-leak.test.ts`：源代码层 grep 兜底，确保 `services/task.ts` / `services/gitRepoCache.ts` / `routes/tasks.ts` / `routes/cachedRepos.ts` 里所有引用 URL 的 `log.*` / `throw new *Error` / `JSON.stringify` 都走过 `redactGitUrl`（或允许列表式白名单）。粗一点：grep `\.url` 调用必须在同函数内出现 `redactGitUrl`，否则 fail
- `start-task-path-regression.test.ts`：path 模式 e2e 不变（兜底回归）

### 7.3 Frontend (`packages/frontend/tests/`)

- `launch-repo-source-tabs.test.tsx`：切换 tab 后表单 state 切分；URL 框 disabled 状态；Start 按钮 enable/disable 逻辑
- `launch-build-body-url.test.ts`：纯函数测 buildLaunchBody，分别给 path/url state → 输出对应字段
- `repos-page.test.tsx`：列表渲染 + Refresh 调用 + Delete 弹窗 + 二次确认 force=1
- `redact-url.client.test.ts`：UI 渲染时 URL 已 redact

### 7.4 e2e

- 新增一条 fixture：用本仓自己作为远端（`file://` URL 或 daemon 启动时建 tmp bare repo）；e2e 流程：进 launcher → 切到 URL tab → 输入 file URL → Start → 任务成功 → 任务详情显示 redacted URL；接着进 /repos 看到一条记录 → 点 Refresh → last_fetched_at 更新；点 Delete（无引用任务时）→ 列表清空

## 8. 配置（settings.json）

新增字段：

```jsonc
{
  "gitCloneTimeoutMs": 1800000,  // 默认 30 min；clone / mutex 等待共用
  "gitFetchOnReuse": true        // cache hit 时是否自动 fetch
}
```

通过 `ConfigSchema` 注册。

## 9. 安全 / 隐私

- 所有写到 DB 的 `tasks.repoUrl` 是**原始 URL**（含 token）。理由：DB 用户即本机用户，框架已假设无鉴权；保留原值才能让 Delete 后用同 URL 起任务找回旧缓存（虽然 hash 不依赖 user:pass，UI 还是要原文显示给用户作 provenance）—— **但 UI 渲染、log、event、API response 都必须走 redactGitUrl**
- 后续可加 settings 旋钮 `gitUrlStorePolicy: 'raw' | 'redacted'`，默认 raw；本 RFC 不引入
- 不向远端 push、不调用任何 GitHub/GitLab API，仅 `git clone` / `git fetch`
- mutex / DB INSERT 失败时一律 `rm -rf` 临时目录，不留半成品

## 10. 迁移序号 / 多人协作守则

- DB migration 编号 `0008_rfc024_cached_repos`；如同 session 中 RFC-023 PR-A 已落 0007，按递增；如冲突由后落地 RFC 让位
- 不改：`services/scheduler.ts` / `services/runner.ts` / `services/review.ts` / `services/clarify.ts` / `services/skill*.ts` / `services/agentDeps.ts` / `services/upload.ts`
- launcher 文件 `workflows.launch.tsx`：新增 `RepoSourceTabs` 区块包住既有 path 输入；upload picker / RFC-023 clarify 输入区不受影响
- `tasks.detail.tsx`：仅在"详细信息" tab 新增一两行；不动 tab 注册顺序（RFC-021）

## 11. 后续可演进点（非本 RFC 范畴）

- partial / shallow clone 旋钮
- HTTPS 私有仓 PAT 集中管理（settings 加密落盘）
- SSH key 生成 / 注册 UI
- 自动 GC：长期未引用的缓存目录定期清理
- webhook → 自动 fetch / 自动起任务
- 框架级"Git provider"抽象，把 host 识别（github.com / gitlab.com / bitbucket）+ 该 provider 的 PR / Issue / Webhook 联动
