# RFC-107 — 技术设计

状态：Draft

## 1. 现状与根因

`handleMultipartTaskStart`（`packages/backend/src/routes/tasks.ts`，约 673–880 行）当前流程：

1. 解析 multipart：取出 `payload`（StartTask JSON）+ `files[<key>][]` 文件字节。
2. 解析 workflow，收集 `kind: upload` 输入声明，把文件绑定到 inputKey。
3. **materialize worktree 优先**（注释原话「Materialize the worktree first so we have a
   real path to write into」）—— 需要一个**具体本地 repoPath**。
4. 写上传文件进 worktree → 路径打包回 `inputs[]`。
5. `startTask({ ...startInput, inputs: inputsOut }, { preCreatedWorktree, ... })`。

第 3 步前的守卫：

```ts
if (startInput.repoUrl) {
  throw new ValidationError('multipart-upload-requires-path-mode',
    'multipart uploads currently require launching with a local repoPath; URL launches are JSON-only')
}
const multipartRepoPath = startInput.repoPath ?? startInput.repos?.[0]?.repoPath
if (!multipartRepoPath) { throw new ValidationError('multipart-upload-requires-path-mode', '...') }
const wt = await materializeWorktree({ repoPath: multipartRepoPath, ... })
```

URL 模式给不出本地 `repoPath`，故被拒。

## 2. 关键既有件（复用，不 fork）

| 件 | 位置 | 作用 |
|---|---|---|
| `resolveRepoSourceSingle(spec, input, deps)` | `services/task.ts:291` | **同时处理 path / URL**：URL 分支调 `resolveCachedRepo` → 返回 `{ repoPath: cached.localPath, baseBranch, repoUrl: spec.repoUrl, pathFetchError, ffWarnings }`。**当前模块私有**。 |
| `resolveCachedRepo` | repo 服务 | URL→本地缓存克隆，**幂等**（按 (cacheDir, syncBranch) 缓存，`fetchOnReuse` 可控）。 |
| `materializeWorktree({ repoPath, ... })` | `services/task.ts:168` | `repoPath` 注释明确「Resolved local repoPath (**cache dir for URL mode**, user-supplied for path mode)」——**已支持**传缓存目录。 |
| `startTask(..., { preCreatedWorktree })` | `services/task.ts` | 路由预建 worktree 时跳过自建；`preCreatedWorktree` 分支用 `resolvedSources[0]` 记 `repoUrl` 元数据（`task.ts:539-554`）——**来源标识天然保留**。 |

核心洞察：`materializeWorktree` 和 `startTask` 都已能在「缓存路径 + repoUrl 来源」组合下工作，
唯一缺的是**把 URL→缓存解析提前到路由的 worktree 化之前**。

## 3. 数据流（改造后，URL + upload）

```
1. 路由解析 multipart（payload + 文件字节）            [不变]
2. 解析 workflow + 收集 upload 声明 + 绑定文件          [不变]
3. 守卫：
     - 多仓(>1) + upload      → multi-repo-upload-unsupported   [不变]
     - 既无 repoPath 又无 repoUrl → 报错                         [不变]
     - repoUrl 这一支的 422   → 删除                              [本 RFC]
3.5 静态工作流校验（NEW，先于任何 resolve/clone，见 D4）:
     validateWorkflowDef(workflow.definition, ...) 有 error → 直接拒绝
     —— 防「非法工作流 + URL 上传」先克隆/污染缓存再失败（与 JSON 模式对齐）
4. 解析来源（NEW，单仓）:
     resolved = resolveRepoSourceSingle(spec, startInput, deps)
       · path 模式: resolved.repoPath = 用户路径
       · url  模式: resolved.repoPath = 缓存 localPath, resolved.repoUrl = url(脱敏前)
     URL 解析/克隆抛错 → 直接透传结构化错误，不进 startTask（见 D1 失败路径）
5. materializeWorktree({ repoPath: resolved.repoPath, baseBranch: resolved.baseBranch,
     workingBranch, gitUserName, gitUserEmail, ... })   ← 透传同 JSON 路径（见 D5）
     earlyError !== null → startTask(失败行) 也带 preResolvedSource（见 D1 失败路径）
6. 写上传 → 打包 inputs                                  [不变]
7. startTask({ ...startInput(仍含 repoUrl), inputs },
              { preCreatedWorktree, preResolvedSource: resolved, ... })  [见 D1]
```

`spec` 取法沿用既有：`{ repoPath: startInput.repoPath ?? repos?.[0]?.repoPath,
repoUrl: startInput.repoUrl ?? repos?.[0]?.repoUrl, baseBranch, ref }`（单仓）。

> 凭据脱敏（Codex 设计 gate F4）：`resolved.repoUrl` 仍是用户原始 URL，但 `startTask` 落库前
> 既有逻辑（`task.ts:733-740/775-780`）会 redact 凭据。本 RFC **不动**该脱敏；provenance 断言
> 针对**脱敏后**的值（含凭据 URL 断言 redact、无凭据 URL 断言原样）。

## 4. 设计决策

### D1 — 避免「路由 + startTask 双解析二次 fetch」：thread `preResolvedSource`（推荐）

问题：第 4 步路由已解析一次 URL（拿缓存路径建 worktree）。`startTask` 内部的解析循环
（`task.ts:~490-513`）在 `preCreatedWorktree` 分支**之前**运行，会对同一 `repoUrl` **再解析一次**
→ `resolveCachedRepo` 首调不带 `fetchOnReuse:false`，可能**二次 fetch**（用户可感知的额外延迟）。

- **方案 A（最小改动）**：路由解析建 worktree；startTask 照常再解析（缓存复用）。
  优点：startTask 不动。缺点：二次 fetch；两次解析理论上可缓存漂移。
- **方案 B（推荐）**：路由解析一次，把 `resolved` 经新可选 dep `preResolvedSource`（与
  `preCreatedWorktree` 平行）传入 `startTask`；startTask 解析循环对 index 0 **复用**它、跳过
  重解析。优点：① 杜绝二次 fetch；② 与既有「路由预做、startTask 消费」（`preCreatedWorktree`）
  范式一致；③ worktree 与 startTask 记录**同一解析结果**，无漂移。代价：`startTask` 解析循环
  加一处 `preResolvedSource ?? await resolveRepoSourceSingle(...)`。

**取 B**：二次网络 fetch 是真实用户延迟，且 B 与现有预做范式对齐、消除漂移面。
落地形态：`StartTaskDeps` 增 `preResolvedSource?: ResolvedRepoSource`，`startTask` 解析循环
对单仓 index 0 用 `preResolvedSource ?? await resolveRepoSourceSingle(...)`（多仓忽略）。

**失败路径（Codex 设计 gate F3）**——「只解析一次」必须在失败路径也成立：

- **URL 解析/克隆失败**（resolve 阶段抛错，worktree 尚未建）：路由**直接透传**该结构化错误，
  **不**再进 `startTask`（否则 startTask 会二次解析同一 URL）。这也天然满足 D2 的失败语义对齐。
- **materializeWorktree earlyError**（解析成功但建 worktree 失败）：现有 earlyError 分支
  （`routes/tasks.ts:828-839`）调 `startTask` **不带** `preCreatedWorktree` → 会二次解析。
  修正：earlyError 分支的 `startTask` 调用**也传 `preResolvedSource: resolved`**，使解析仍只发生
  一次。`StartTaskDeps.preResolvedSource` 因此独立于 `preCreatedWorktree` 生效（单仓 index 0 即用）。

### D2 — URL 解析/克隆失败的语义

path 模式下 `materializeWorktree` 失败走 `wt.earlyError` → 路由建一条 **failed 任务行**
（worktree 曾部分存在）。URL 模式的解析失败发生在 **worktree 化之前**、且没有任何东西被创建
（上传字节只在内存里），因此：

- 让 `resolveRepoSourceSingle` 抛出的错误**透传**为结构化错误，与 **URL 模式 JSON 启动**
  失败一致（实现时需对照 `startTask` 走 JSON URL 失败的现行表现，二者必须同形——T2 验收项）。
- 不建半截任务行；内存中的上传字节随请求结束自然回收，无需清理。

> 实现期校验点：确认 URL 模式 JSON 启动在克隆失败时是「抛 4xx」还是「建 failed 行」，
> 本 RFC 的 URL+upload 失败必须与之对齐，避免两条启动路径对同一失败给不同结果。

### D3 — 守卫保留矩阵

| 组合 | 现状 | 本 RFC 后 |
|---|---|---|
| 单仓 path + upload | ✅ 支持 | ✅ 不变 |
| **单仓 url + upload** | ❌ 422 | ✅ **支持** |
| 多仓 + upload | ❌ `multi-repo-upload-unsupported` | ❌ 不变 |
| 无 repoPath 且无 repoUrl + upload | ❌ 报错 | ❌ 不变（错误码可沿用/收敛） |

`services/task.ts` 的镜像门（`multi-repo-upload-unsupported`，`task.ts:467-471` 及
`preCreatedWorktree` 单仓断言 `task.ts:528-533`）**保留**——它们防的是多仓，与本 RFC 正交。

### D4 — 静态工作流校验先于 resolve/clone（Codex 设计 gate F1）

问题：JSON 启动里 `startTask` 先跑静态校验（`task.ts:476-490`）再解析仓库（497-512）。而
multipart 路由在 `startTask` **之前**就 materialize worktree（`routes/tasks.ts:781-826`）；今天那只是
**本地** worktree 副作用，但本 RFC 解除 URL 守卫后，「**可见但非法**的工作流 + URL 上传」会先
**克隆/污染仓库缓存**（网络 + 缓存行）再在 startTask 校验失败、无任务行——与 JSON URL 模式
（校验在先、非法不克隆）不一致。

修正：multipart 路由在调 `resolveRepoSourceSingle` / materialize **之前**，对 workflow.definition
跑一次静态校验（复用 `validateWorkflowDef`，error 即拒绝）。两种落法：
- (i) 路由内直接调 `validateWorkflowDef`（route 已持 `workflow.definition` + agents/skills/plugins
  上下文，或经 `validateWorkflowById`）。
- (ii) 抽一个 `startTask` 之前可独立调用的 preflight（校验段）共享给 JSON 与 multipart。

**取 (i)** 作 v1（最小、无需改 startTask 控制流）；校验逻辑本就是 `validateWorkflowDef` 单源，
不构成 fork。验收：非法工作流 + URL 上传 → 不产生缓存行 / 不建 worktree（测试断言）。

### D5 — `workingBranch` / git 身份透传（Codex 设计 gate F2）

问题：JSON 单仓路径把 `input.workingBranch` + `gitUserName` + `gitUserEmail` 传进
`materializeWorktree`（`task.ts:563-571`），而**当前** multipart 路由的 materialize 调用
（`routes/tasks.ts:821-826`）**没传**；`preCreatedWorktree` 分支事后又信任已建分支
（`task.ts:534-553`）。`createWorktree` 用 `workingBranch` 替换默认隔离分支
`agent-workflow/{taskId}`（`util/git.ts:365-377`）——故带 `workingBranch`/autoCommitPush 的
upload 启动会**持久化 workingBranch 值却实际跑在隔离分支上**（已是 path+upload 的潜伏 bug，
本 RFC 触及此处顺手闭合）。

修正：路由的 `materializeWorktree` 调用透传 `input.workingBranch` / `gitUserName` /
`gitUserEmail`，与 JSON 单仓路径逐字一致。验收：URL+upload+workingBranch → 实际 checkout 分支
与 task 元数据一致。

## 5. 耦合点与改动面

1. **`services/task.ts`**
   - 导出 `resolveRepoSourceSingle` 与 `ResolvedRepoSource` 类型（供路由复用）。
   - `StartTaskDeps` 增 `preResolvedSource?: ResolvedRepoSource`；解析循环对单仓 index 0
     优先用它（D1-B）。仅当与 `preCreatedWorktree` 并存时生效。
2. **`routes/tasks.ts` `handleMultipartTaskStart`**
   - 删除 `if (startInput.repoUrl) throw multipart-upload-requires-path-mode`。
   - **resolve 之前**跑 `validateWorkflowDef` 静态校验（D4），error 即拒绝、不克隆。
   - worktree 化前调 `resolveRepoSourceSingle` 得 `resolved`；URL 解析抛错**直接透传**、不进
     startTask（D1 失败路径）。用 `resolved.repoPath` 建 worktree，并透传 `workingBranch` /
     `gitUserName` / `gitUserEmail`（D5）。
   - `startTask` 成功与 earlyError **两条**调用都传 `preResolvedSource: resolved`（payload 仍含
     repoUrl，落库经既有脱敏）。
   - 保留多仓 / 缺来源守卫。`ffWarnings` / `pathFetchError` 比照 startTask 现有处理（log.warn）。
3. **`frontend workflows.launch.tsx`（176–183 行）**
   - 删掉「RFC-024: URL + uploads not supported by the backend yet … backend will 422」注释，
     改为正常路径；确认 `buildLaunchFormDataV2` 的 payload 携带 `repoUrl` + `ref`（应已含）。
4. **无 schema / migration / DB 改动**。

## 6. 失败模式

- URL 克隆失败 → 结构化错误（D2），无半截任务、无文件残留。
- multipart 体损坏 / payload 非法 → 既有 `task-multipart-*` 错误，不变。
- 上传超限 / accept 不符 → 既有 `task-upload-failed`，不变（worktree 已建、无任务行）。
- 缓存并发：`resolveCachedRepo` 自带按 (cacheDir, syncBranch) 的锁/缓存，无新并发面。
- 二次 fetch：D1-B 消除。

## 7. 测试策略（每条先红后绿）

**后端**（`packages/backend/tests/`，避免真网络——用本地 `file://` bare 仓或 stub
`resolveCachedRepo`，遵循 [reference_local_bun_test_git_flaky] 不依赖 `RUN_GIT_NETWORK`）：

1. `url-upload-multipart-start`：单仓 `repoUrl` + upload multipart **成功** → worktree 自缓存建立、
   文件落 `targetDir`、`inputs[]` 含打包路径、任务 `repoUrl ==` **脱敏后**提交 URL。
2. `url-upload-no-longer-422`：同上请求**不再**抛 `multipart-upload-requires-path-mode`。
3. `url-upload-clone-failure-parity`：URL 解析失败 → 结构化错误，与 URL 模式 JSON 失败同形，
   无任务行。
4. `multipart-single-resolve`（D1-B）：URL+upload **成功路径**中 `resolveCachedRepo` / 解析
   **只发生一次**（spy 计数 == 1）；**失败路径**（坏 ref → materialize earlyError）解析仍 **== 1**
   （Codex F3）。
5. `url-upload-validate-before-clone`（Codex F1）：**非法**工作流（带 upload 输入）+ URL 上传 →
   校验错误拒绝，`resolveCachedRepo` spy **零调用**、无缓存行、无 worktree、无任务行。
6. `url-upload-working-branch`（Codex F2）：URL+upload+`workingBranch`（+git 身份）→ 实际 checkout
   分支 == workingBranch、task 元数据一致（不再跑默认隔离分支）。也补 path+upload+workingBranch
   的同款断言（闭合既有潜伏 bug）。
7. `url-upload-credential-redaction`（Codex F4）：含凭据的 URL → 持久化 `repoUrl` 已 redact、
   DB 无明文凭据；无凭据 URL → 原样保留。
8. 回归：path 模式 + upload 仍绿（既有用例不破）；多仓 + upload 仍 `multi-repo-upload-unsupported`；
   缺来源仍报错。
9. 来源最小断言：源码层锚点——`handleMultipartTaskStart` 不再含 `if (startInput.repoUrl) throw`
   字面（防未来回归）。

**前端**（vitest）：

7. 启动决策：URL + upload 走 `postMultipart` 且**不**期待 422；`buildLaunchFormDataV2` 含
   `repoUrl`/`ref`（纯函数断言）。

**e2e**（Playwright，可选/light）：若已有上传 e2e，补一条 URL 来源 + 上传跑通；网络受限时
用本地 served 仓库，避免 CI flaky。

## 8. 风险

- **R1**：改动 `startTask` 解析循环（D1-B）有回归面 → 用 `start-task-single-path-baseline`
  既有基线守卫 + 新增「解析一次」用例双向夹紧；多仓路径 `preResolvedSource` 不生效（仅单仓
  index 0），blast radius 受限。
- **R2**：URL 失败语义与 JSON 路径不一致 → D2 验收项强制对齐，实现期先核 JSON 失败现行表现。
- **R3**：真网络测试 flaky → 一律本地 `file://` / stub，禁 `RUN_GIT_NETWORK` 依赖。
- **R4**（D4）：路由先行静态校验若与 startTask 内校验**重复**两遍——可接受（校验纯函数、无副作用、
  快）；但要确保两处用**同一** `validateWorkflowDef` 单源、错误码一致，避免「路由放行/startTask 拒绝」
  或反之的缝。multipart 路径据此变为「校验两次」，JSON 路径不变。
- **R5**（D5）：路由 materialize 透传 `workingBranch`/git 身份触及与 JSON 共用的 `materializeWorktree`
  入参——逐字对齐 JSON 单仓调用即可，blast radius 限于 multipart 路由调用点；用 path+upload 与
  url+upload 两条 workingBranch 用例双向夹紧。
