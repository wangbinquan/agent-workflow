# RFC-107 — 任务分解

状态：Draft

## PR 拆分

**单个 PR**（改动聚焦：1 个路由 handler + `task.ts` 小幅导出/threading + 1 行前端注释 + 测试）。
commit message 前缀：`feat(backend): RFC-107 URL 启动支持 multipart 上传`。

## 子任务

### RFC-107-T1 — 共享解析 + `preResolvedSource` threading（`services/task.ts`）
- 导出 `resolveRepoSourceSingle` 与 `ResolvedRepoSource`（供路由复用，避免 fork）。
- `StartTaskDeps` 增可选 `preResolvedSource?: ResolvedRepoSource`；解析循环对**单仓 index 0**
  优先用它、跳过重解析。**独立于 `preCreatedWorktree` 生效**（earlyError 失败路径也需复用——
  见 T2 / Codex F3）；多仓忽略。
- 测试：`multipart-single-resolve`——spy `resolveCachedRepo`，断言 URL+upload **成功与失败**路径
  解析计数均 == 1；保持 `start-task-single-path-baseline` 既有基线绿。
- 依赖：无。

### RFC-107-T2 — 路由解除限制（`routes/tasks.ts handleMultipartTaskStart`）
- 删除 `if (startInput.repoUrl) throw 'multipart-upload-requires-path-mode'`。
- **D4（Codex F1）**：resolve/materialize **之前**跑 `validateWorkflowDef` 静态校验，error 即拒绝、
  不克隆、不污染缓存。
- worktree 化前调 `resolveRepoSourceSingle(spec, startInput, deps)` 得 `resolved`；URL 解析抛错
  **直接透传**、不进 startTask（D1 失败路径）；用 `resolved.repoPath` 建 worktree。
- **D5（Codex F2）**：materialize 调用透传 `input.workingBranch` / `gitUserName` / `gitUserEmail`，
  逐字对齐 JSON 单仓路径（`task.ts:563-571`）。
- `startTask` **成功与 earlyError 两条**调用都传 `preResolvedSource: resolved`（payload 仍含 repoUrl，
  落库经既有脱敏 / Codex F4）。
- 保留多仓 / 缺来源守卫；`ffWarnings`/`pathFetchError` 比照现有 log.warn。
- **D2**：先核 URL 模式 JSON 启动克隆失败的现行表现，URL+upload 失败对齐之。
- 测试：`url-upload-multipart-start`（成功 + 文件落盘 + inputs 打包 + 脱敏后 `repoUrl` 保留）、
  `url-upload-no-longer-422`、`url-upload-clone-failure-parity`、`url-upload-validate-before-clone`
  （F1：非法 wf + URL → resolveCachedRepo 零调用、无缓存/worktree/任务）、`url-upload-working-branch`
  （F2：实际 checkout 分支 == workingBranch；含 path+upload 同款）、`url-upload-credential-redaction`
  （F4：含凭据 URL → 落库 redact）、源码锚点（不再含旧 throw 字面）。
- 依赖：T1。

### RFC-107-T3 — 回归守卫
- path 模式 + upload 仍绿（既有用例不破）。
- 多仓 + upload 仍 `multi-repo-upload-unsupported`；缺 `repoPath` 且缺 `repoUrl` 仍报错。
- 依赖：T2。

### RFC-107-T4 — 前端（`workflows.launch.tsx`）
- 删 176–183 行「backend will 422 us politely」兜底注释，URL + upload 走正常成功路径。
- 确认 `buildLaunchFormDataV2` payload 携带 `repoUrl` + `ref`。
- 测试（vitest）：启动决策纯函数断言——URL+upload → `postMultipart` 且 payload 含 url/ref。
- 依赖：T2（后端先能接）。

### RFC-107-T5 — 落档收尾
- `design/plan.md` RFC 索引状态 Draft→Done；`STATE.md` 顶部「进行中 RFC」→ 完成行。
- 跑全门禁 + Codex 实现 gate，fold findings。
- 依赖：T1–T4。

## 验收清单

- [ ] 单仓 url + upload multipart 启动成功：worktree 自缓存、文件落 `targetDir`、`inputs[]` 含路径。
- [ ] 任务 `repoUrl` == **脱敏后**提交 URL（来源保留；含凭据 URL 落库 redact、无明文，Codex F4）。
- [ ] **校验先于克隆**（Codex F1）：非法 wf + URL 上传 → 不克隆、不污染缓存、不建 worktree、无任务行。
- [ ] **workingBranch 透传**（Codex F2）：URL/path+upload+workingBranch → 实际 checkout 分支与元数据一致。
- [ ] `multipart-upload-requires-path-mode` 不再对 url 抛。
- [ ] URL 克隆失败与 JSON URL 失败同形，无半截任务。
- [ ] URL 解析在一次启动中只发生一次（无二次 fetch），**成功与失败路径都成立**（Codex F3）。
- [ ] 回归：path+upload 绿；多仓+upload 仍 422；缺来源仍报错。
- [ ] 前端 url+upload 提交并跳转任务详情。
- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿；CI 全绿；Codex 双 gate fold。

## 测试矩阵（对应 design §7）

| 测试 | 层 | 锁的回归 |
|---|---|---|
| `url-upload-multipart-start` | backend | URL+upload 成功 + 脱敏来源保留 |
| `url-upload-no-longer-422` | backend | 限制已解除 |
| `url-upload-clone-failure-parity` | backend | 失败语义与 JSON 路径一致 |
| `multipart-single-resolve` | backend | 无二次 fetch（D1-B），成功+失败路径（F3） |
| `url-upload-validate-before-clone` | backend | 校验先于克隆、非法 wf 不污染缓存（F1） |
| `url-upload-working-branch` | backend | workingBranch 实际生效、元数据一致（F2） |
| `url-upload-credential-redaction` | backend | 含凭据 URL 落库脱敏、无明文（F4） |
| path+upload 既有用例 | backend | path 模式不回归 |
| 多仓+upload / 缺来源 | backend | 正交守卫保留 |
| 启动决策纯函数 | frontend | URL+upload 走 multipart |
| 源码锚点（旧 throw 消失） | backend | 防限制回潮 |
