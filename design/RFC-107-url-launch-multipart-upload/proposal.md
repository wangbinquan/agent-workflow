# RFC-107 — URL 启动支持 multipart 文件上传（解除 `multipart-upload-requires-path-mode`）

状态：Draft

## 背景

工作流可声明 `kind: upload` 的输入（RFC-020）。启动这类工作流时，浏览器把
`StartTask` 的 JSON 与文件原始字节打包成一个 `multipart/form-data` 请求 POST 到
`/api/tasks`；后端先建好任务的本地 worktree，再把文件写进 `targetDir`、把生成的
路径塞回 `inputs[]` 交给 agent。

当前 **URL 模式启动**（用户给 git 克隆地址而非本地路径）**不支持** multipart 上传：
`handleMultipartTaskStart`（`packages/backend/src/routes/tasks.ts`）在 materialize
worktree 之前发现 `startInput.repoUrl` 即抛 422：

```
multipart-upload-requires-path-mode
"multipart uploads currently require launching with a local repoPath; URL launches are JSON-only"
```

根因是**步骤顺序**，并非 git 本身的限制：上传文件要写进本地 worktree，建 worktree
需要本地仓库；URL 模式此刻仓库还没克隆到本地（克隆/缓存解析 `resolveCachedRepo`
目前发生在更靠后的 `startTask` 内部）。代码用一个清晰的 422 显式拒绝，而非静默丢文件。

## 目标

- 让**单仓 URL 模式**启动也能携带 multipart 文件上传：在路由层 materialize worktree
  之前，先把 URL 解析成本地缓存路径（复用既有 `resolveRepoSourceSingle`），再写上传、
  再交给 `startTask`。
- **保留来源标识**：任务记录里 `repoUrl` 仍是用户给的来源 URL（UI/审计照常显示来源 URL，
  而非内部缓存路径）——但沿用既有**凭据脱敏**（`task.ts:733-740/775-780` 在落库前 redact），
  即「保留**脱敏后**的来源 URL」，绝不把明文凭据写进 `tasks.repoUrl`/`task_repos.repoUrl`。
- 删除 `repoUrl` 这一支的 422；其余既有限制（多仓 + 上传、缺来源）保持不变。
- 复用而非 fork：上传写入、worktree 化、URL→缓存解析都用现有单一实现。

## 非目标

- **多仓 + 上传**仍不支持：保持现有 `multi-repo-upload-unsupported` 422（上传管线写入
  单一 worktree，N 个兄弟 worktree 没有明确目标——属另一条独立限制，本 RFC 不动）。
- 不改 path 模式上传的任何行为。
- 不改上传语义（`uploadLimits` / `accept` / `targetDir` / `minCount` / `maxCount` 全不变）。
- 不新增"按 cachedRepoId 启动"等契约（那是 RFC-103 移出的 T8 范畴）。
- 不引入 DB 变更 / migration（`tasks.repoUrl` 列已存在）。

## 用户故事

1. 作为用户，我有一个声明了 `kind: upload` 输入的工作流，我想直接填一个 **git 仓库 URL**
   并附上几个文件启动任务，而**不必**先把仓库克隆到本地、再用本地路径启动。
2. 作为用户，当我用 URL + 上传启动后，任务详情页里 **Repo 仍显示我填的 URL**（来源可追溯），
   上传的文件已落在 worktree 的 `targetDir` 下、被 agent 读到。
3. 作为用户，如果我填的 URL **克隆失败**（网络/鉴权/地址错），我得到一个**清晰的错误**
   （与 URL 模式 JSON 启动失败一致），不会产生半截任务、也不会有文件残留困惑。

## 验收标准

- [ ] 单仓 `repoUrl` + 含 `kind: upload` 输入的 multipart `POST /api/tasks` **成功**：
      worktree 从缓存克隆建立、文件写入 `targetDir`、路径打包进 `inputs[]`、任务创建。
- [ ] 该任务记录的 `repoUrl` == **脱敏后**的提交 URL（来源标识保留，非缓存路径）；
      含凭据的 URL 落库时凭据被 redact，明文凭据绝不进 DB。
- [ ] **校验先于克隆**（Codex 设计 gate F1）：可见但**非法**的工作流 + URL 上传 → 在
      resolve/clone **之前**就以校验错误拒绝，**不**污染仓库缓存、不建 worktree、无任务行
      （与 JSON URL 模式一致）。
- [ ] **workingBranch / git 身份透传**（Codex 设计 gate F2）：URL/path + 上传且带
      `workingBranch`（及 `gitUserName`/`gitUserEmail`）时，实际 checkout 的工作分支与持久化的
      task 元数据一致（不再持久化 workingBranch 却跑在默认隔离分支上）。
- [ ] `multipart-upload-requires-path-mode` 不再对 `repoUrl` 这一支抛出。
- [ ] URL 解析/克隆失败 → 结构化错误，与 URL 模式 JSON 启动失败语义一致，无半截任务。
- [ ] 回归：path 模式 + 上传仍正常；多仓 + 上传仍 `multi-repo-upload-unsupported`；
      既无 `repoPath` 又无 `repoUrl` 仍报错。
- [ ] URL 解析在一次启动中**只发生一次**（不因路由 + startTask 双解析而二次 fetch），
      **成功与失败路径都成立**（Codex 设计 gate F3：earlyError 分支也不得二次解析）。
- [ ] 前端 URL + 上传组合可正常提交并跳转任务详情（去掉"backend will 422"的兜底注释）。
- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿；CI 全绿；Codex 双 gate fold。

## 触发

2026-06-26 用户报告 `multipart-upload-requires-path-mode` 限制并明确「写 RFC 解除这个限制」。
