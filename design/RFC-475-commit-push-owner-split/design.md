# RFC-475 设计

**落在哪个 context、哪一层**：source-control（git 发布用例进 `application`，纯判定进 `domain`，binder 进 `composition`，合同经 `public/`）；
task-execution（提交行与 effect 记账进 `infrastructure`，内置 commit agent 进 `domain`，`composition/commitPushBinding.ts` 改取它们）；`util/git.ts`
（子仓列表的两个纯函数）。
**承担的演进**：W9-D 的一步——自动 commit&push 按 owner 拆开，`services/commitPushRunner.ts` 与 `services/commitPush.ts` 退役，`R1` 少 4 条；
task-execution 只经 source-control 的 public 合同发布，source-control 不取 task-execution。
**留下的债**：`services/gitSubmodule.ts`、`services/mergeAgent.ts` 仍在 `services/`（proposal §3）；其余 34 条 `R1` 见 proposal §3。

## 1. source-control 合同（`application/ports/workspaceChangePublication.ts`，经 `public/` 交出）

全部是闭合接口（方法签名，不用函数类型属性），只引用 shared 与 source-control 自己的 public 类型：

```ts
interface WorkspaceChangeMessageContext {
  repoName: string
  branch: string
  baseRef: string
  stat: string
  diffTruncated: string
}
interface WorkspaceChangeRepairContext {
  branch: string
  stat: string
  pushStderr: string
  currentMessage: string
  priorAttempts: number
}
interface WorkspaceChangeMessage {
  message: string | null
  processUnreaped?: true
}
interface WorkspaceChangeMessageAuthor {
  compose(context: WorkspaceChangeMessageContext): Promise<WorkspaceChangeMessage>
  repair(context: WorkspaceChangeRepairContext): Promise<WorkspaceChangeMessage>
}
interface WorkspaceWriteLease {
  release(): void
}
interface WorkspaceWriteLock {
  acquire(): Promise<WorkspaceWriteLease>
}
type RepositoryPublicationLogFields = Readonly<{
  nodeRunId?: string
  error?: string
  branch?: string
  credentialSource?: string
  subPath?: string
}>
interface RepositoryPublicationLogger {
  warn(message: string, fields?: RepositoryPublicationLogFields): void
}
interface WorkspaceChangePublicationRequest {
  nodeRunId: string // 只用于日志字段
  taskId: string
  agentName: string // 兜底提交消息的两个标签
  branch: string
  baseRef: string
  remote: string
  subject: RepositoryCredentialSubject // shared；即 source-control 的 RepositoryPublicationSubject
  authorName: string | null
  authorEmail: string | null
  excludePatterns: readonly string[]
  maxRepairRetries: number
  diffMaxBytes: number
  author: WorkspaceChangeMessageAuthor
  writeLock?: WorkspaceWriteLock
}
interface WorkspaceChangePublicationResult {
  meta: CommitPushMeta
  processUnreaped?: true
}
interface WorkspaceChangePublicationParticipant {
  publish(request: WorkspaceChangePublicationRequest): Promise<WorkspaceChangePublicationResult>
}
```

- `public/types.ts` 转出上面的数据与端口类型；`public/participants.ts` 转出 `WorkspaceChangePublicationParticipant` 与 binder
  `bindWorkspaceChangePublication`（§3），追加在文件末尾。
- 守护进程的 `Logger`（`warn(msg, fields?: Record<string, unknown>)`）结构上满足 `RepositoryPublicationLogger`，与 task-execution
  `WorkgroupTurnLogger` 的先例同形。
- `WorkspaceChangePublicationRequest` 顶层 14 个字段，超过 RFC-294 design §3.3 的评审经验值（12）。不拆：它是一次提交推送尝试（RFC-075
  的提交与修复、RFC-321 的一次发布会话）这一个协议的完整输入，每个字段都被同一个用例取用，没有只取其中一部分的消费方；拆成嵌套对象只是
  换个分组，用例里的读取全要跟着改，迁入的 git 代码就不再与 runner 逐行可比。

## 2. source-control 用例（`application/workspaceChangePublication.ts`）

`publishWorkspaceChanges(request, deps)`：runner 从子仓阶段到发布会话关闭的全部 git 代码原样迁入，私有的 `commitPushSubmodules`、
`identityEnv`、`basenameOf`、`directParentOf` 与 `CommitAgentUnreapedError`（错误文本不变，它会落进 `pushError`）随之迁入。`deps`
（模块内部类型，不进 public）：

```ts
interface WorkspaceChangePublicationDeps {
  workspace: RepositoryGitWorkspaceScope
  transport: RepositoryPublicationTransport
  bindPoliciesToWorkspace: boolean // 原 `deps.repositoryGitWorkspaces !== undefined`，子仓阶段按它选 binder 形态
  log: RepositoryPublicationLogger
  commits: RepositoryCommitBinder // bindRepositoryCommitParticipant 的形状
  subworkspace(
    parent: RepositoryGitWorkspaceScope,
    relativePath: string,
  ): RepositoryGitWorkspaceScope
}
```

逐条改写（其余逐字不动）：

- `params.*` → `request.*`；`deps.publicationTransport` → `deps.transport`；原先从 `ownerUserId` 推出的 `publicationSubject` 改由请求带入
  （`const publicationSubject = request.subject`，下游 `subject: publicationSubject` 不变）；身份环境 `identityEnv(request.authorName,
request.authorEmail)`。
- `runGit` 仍是 `(_repoPath, args, options) => deps.workspace.run(args, options)`；`W = deps.workspace.workspaceRef`。
- `bindRepositoryCommitParticipant(...)` → `deps.commits(...)`；`bindRepositoryGitSubworkspace(...)` → `deps.subworkspace(...)`；子仓阶段的
  `bottomUp(usableSubmodules(...))` 改取 `util/git`（§7）；纯判定改取 domain（§4）。
- `finalize(outcome, extra)` 只组装 `CommitPushMeta` 并返回 `{ meta, processUnreaped? }`，不再写库；原来各处的 `return await finalize(...)` /
  `return finalize(...)` 照旧返回它。`collectFinalization` 的结构保留（收尾仍在发布会话 `close()` 之后组装）。
- 消息生成：`request.author.compose({ repoName, branch, baseRef, stat, diffTruncated })` / `request.author.repair({ branch, stat, pushStderr,
currentMessage, priorAttempts })`；`processUnreaped` 的判定、`message` 的 trim 与 `messageSource` 赋值不变。会话 id 不再由这里记（§5）。
- 写锁：`const lease = request.writeLock ? await request.writeLock.acquire() : null` … `lease?.release()`，三处（采集、本地提交、子仓本地写）
  的区间不变。
- 日志：四条 `log.warn(...)` 的消息与字段不变（`nodeRunId` 取 `request.nodeRunId`）；子仓阶段照旧不传日志（原调用就没有传）。
- 次序差（proposal §6.3）：采集区间里的四个失败出口返回后写锁随即释放，记账在释放之后发生。

## 3. source-control binder（composition）

- `composition/repositoryCommit.ts`（新）：`bindRepositoryCommitParticipant` 从 `composition.ts` 原样移入（连同它独用的 import）；
  `composition.ts` 改为 `export { bindRepositoryCommitParticipant } from './composition/repositoryCommit'`，用例照旧从模块根取。
- `composition/workspaceChangePublication.ts`（新）：

  ```ts
  export function bindWorkspaceChangePublication(input: {
    readonly workspace: RepositoryGitWorkspaceScope
    readonly transport: RepositoryPublicationTransport
    readonly bindPoliciesToWorkspace: boolean
    readonly log: RepositoryPublicationLogger
  }): WorkspaceChangePublicationParticipant {
    requireRepositoryGitWorkspaceScope(input.workspace)
    return Object.freeze({
      publish: (request) =>
        publishWorkspaceChanges(request, {
          ...input,
          commits: bindRepositoryCommitParticipant,
          subworkspace: bindRepositoryGitSubworkspace,
        }),
    })
  }
  ```

  只组装、不碰 fs / 进程 / 数据库（`composition-forbidden-import-files` 不变）。

- `composition.ts` 删掉只剩用例在用的 `classifyRepositoryPushFailure` / `RepositoryPushFailureCode` 转出；用例 `rfc321-repository-publication-transport`
  改取 `domain/repositoryPushFailure`。
- `public/participants.ts` 删掉 `bindRepositoryGitSubworkspace` 的转出：它在模块外唯一的消费方是 runner 的子仓阶段，发布用例迁入后由本模块
  binder 直接取 composition 里的定义（按 RFC-294 design §3.3 当场收回，未被消费的 public 符号不升）。

## 4. source-control domain

- `domain/repositoryPushFailure.ts` 增补 `PushFailureClass` / `classifyPushFailure`（auth / 非快进 / 可修复）与 `redactPushError`（脱敏并截断，
  委托 shared 的 `redactGitUrl`），函数体逐字迁入。
- `domain/stagedChangeSummary.ts`（新）：`parseNumstat`、`truncateDiff`、`buildFallbackMessage`，函数体逐字迁入。

## 5. task-execution 记账（`infrastructure/commitPushAttempt.ts`）

`runCommitPush(params: CommitPushParams, deps: CommitPushDeps)`，签名与返回值（`{ nodeRunId, meta, processUnreaped? }`）不变。它是 engine 端口
`effects.runCommitPush` 的实现、RFC-328 repository effect 括住的外部副作用发生处，所以落在 `infrastructure`（与 `nodeRollbackPersistence`、
`local/agentInvocation` 等 act site 同层；RFC-328 的 effect 清单只把 `application/` 当协调器内部，不计入其中的 act site）：

- `CommitPushParams extends AutoCommitPushRequest { pushRemote?: string }`；原 runner 的字段注释并入 `application/ports/commitPush.ts` 的
  `AutoCommitPushRequest`；`CommitPushDeps` 字段不变（`nodeRuns`、`nodeExecution`、`effects`、`runGit?`、`repositoryGitWorkspaces?`、`log?`、
  `publicationTransport`）。原 runner 里与端口文件重复的三个上下文类型删除（无人取）。
- 步骤与原 runner 相同：`selectRepositoryGitWorkspaceFactory` + `bindRepositoryGitWorkspace`（source-control public）→ `nodeRuns.mint(...)`
  （同一组身份与字段）→ `createLocalEffectAttemptObserver(...)`（同一请求与资源键）→ `beforeAct()` → `bindWorkspaceChangePublication(...)
.publish(...)` → 收尾。
- 发布请求：`subject` 按原规则从 `ownerUserId` 推出（`undefined` / `null` / `'__system__'` → system，其余 → user）；`remote = params.pushRemote ??
'origin'`；`writeLock` 只在给了 `acquireWrite` 时提供（`acquire` 里调它、把返回的函数包成 `release`）；`author.compose` / `author.repair` 调
  `params.generateMessage` / `params.generateRepair`（补上 `nodeRunId`），在结果不是 `processUnreaped` 且 `sessionId != null` 时记下会话 id
  ——与原 runner 的取值规则相同（最后一个非空的为准，`processUnreaped` 的那次不记）。
- 收尾与原 `finalize` 的写库部分相同：`nodeExecution.patch`（`commitPushJson`）、`nodeRuns.set`（状态按 `pushOutcome`：
  `commit-local-failed` / `commit-local-subrepo-failed` / `commit-local-excluded-history` 为 `failed`，其余 `done`；带 `finishedAt` 与会话 id）、
  `repositoryEffect.succeed(...)`；行不见了照旧抛错。source-control 抛出的非预期错误照旧穿透（行与 effect 留在原状态，与原 runner 相同）。
- `composition/commitPushBinding.ts` 改取 `../infrastructure/commitPushAttempt` 与 `../domain/commitAgent`，不再取 `services/`。
- `public/queries.ts` 删掉 `repositoryPublicationOrdinal` 的转出：唯一的模块外消费方就是 runner，记账在模块内直接取 domain。

## 6. task-execution commit agent（`domain/commitAgent.ts`）

`COMMIT_MESSAGE_PORT`、`COMMIT_AGENT_NAME`、`buildCommitAgent`、`commitPushNodeId`、`COMMIT_PUSH_OUTPUT_LANG_DIRECTIVE`、`buildCommitMessagePrompt`、
`buildRepairPrompt` 逐字迁入（`COMMIT_PUSH_NODE_PREFIX` 直接取 shared，不再转出）。与 `domain/dynamicWorkflowOrchestrator.ts` 的编排 agent 同层。

## 7. `util/git.ts` 的子仓列表纯函数

`usableSubmodules`（去掉未初始化的 `-`）与 `bottomUp`（最深的路径在前）迁入，按结构泛型（`<T extends { readonly flag: string }>`、
`<T extends { readonly path: string; readonly pathDepth: number }>`），返回同一元素类型；`services/gitSubmodule.ts` 删掉两者，platform 的
`workspace/local/isolation.ts` 与用例 `rfc210-submodule-topology` 改取 `@/util/git`。

## 8. 用例、账本与清单

- **改 import / 调用**：取 runner 的 5 个用例与 helper（`commit-push-runner`、RFC-210 三个、`rfc370-repository-git-workspace`、
  `tests/helpers/commitPush.ts`）改取 `infrastructure/commitPushAttempt`；取 `services/commitPush` 的用例改取两个新 domain 文件；
  `commit-push-core` 删掉 `shouldConsiderCommit` 与 `parseCommitMessageFromEnvelope` 两段；`isCommitPushNodeId` 进 `tests/helpers/commitPush.ts`。
- **登记守卫**：`rfc328-architecture-guards` 的 effect 边界改登记 `infrastructure/commitPushAttempt.ts#runCommitPush`（act 是 `publish`，observer 是
  `createLocalEffectAttemptObserver`），两张表里指向 runner 的 `persistMeta` 条目删除（该函数早已不在，新文件不直写表）；
  `rfc321-repository-publication-ratchet`、`rfc308-source-cutover`、`rfc287-t9-exemptions-and-extinction`、`architecture/rfc412-scheduler-residue`、
  `architecture/rfc328TaskExecutionLedger.ts` 改指新文件（RFC-412 的「只有 binding 能取 legacy helper」一条改为两个文件进删除清单）。
- **账本**：`architecture/commons-debt.json` 销 4 条 `R1`；`architecture/repository-publication-call-sites.json` 的三个调用点与 `fetch` /
  `ls-remote` 命令清单改指 source-control 新用例；`tests/architecture/architectureReport.ts` 的 owner 表删两个 `services/` 文件；
  `architecture/guard-manifest.json` 刷新改到的登记守卫文件。
- **注释**：`util/git.ts`、shared `schemas/task.ts` 与两个 e2e spec 里指着旧文件的注释改指新位置。

## 9. 失败模式

- 漏改某个消费方 → tsc 报错；路径字面量与 Markdown 链接由 RFC-475 用例锁。
- 记账与发布的次序走样（mint 晚于 git、effect 不括住发布）→ RFC-328 effect 边界守卫与 `commit-push-runner` 的锁 / 行状态用例报出。
- 会话 id 取值规则走样 → `commit-push-runner` 与 RFC-098 用例报出（行上的 `opencodeSessionId`）。
- public 合同引入函数类型或 Logger → 偏差计数升，计数复核与 RFC-475 用例报出。
- 新 composition 文件取了 fs / 进程 → `composition-forbidden-import-files` 升。

## 10. 测试策略

新增 `tests/rfc475-commit-push-owner-split.test.ts`：

1. 两个 `services/` 文件不在；backend 的 src / 用例 / 脚本零 import 它们（`preProcessFile`，带负对照）；各包、e2e、仓根脚本与
   `.github/workflows` 没有指着它们的路径字面量（注释不算，带负对照）；`design/`、`docs/` 的 Markdown 相对链接不指着它们（带负对照）。
2. census 的 `R1` 里没有它们；负对照：同一规则把 `services/` 文件取 task-execution application 端口的合成样例判为 `R1`。
3. owner 与方向：source-control 的新用例、binder 与 domain 不取 task-execution；task-execution 的记账只经 source-control `public/` 取发布，
   不取它的 application / domain / infrastructure / composition（带负对照）。
4. 合同：`public/participants` 转出 `bindWorkspaceChangePublication` 与参与方类型，`public/types` 转出数据与端口类型；合同文件里没有函数
   类型属性、`@/util/` 类型或 `unknown`；`composition.ts` 转出的 `bindRepositoryCommitParticipant` 与 `composition/repositoryCommit.ts` 的是
   同一函数。
5. 记账：`commitPushBinding` 取 `infrastructure/commitPushAttempt` 与 `domain/commitAgent`；`public/queries` 不再转出 `repositoryPublicationOrdinal`；
   `util/git` 的 `bottomUp(usableSubmodules(...))` 与原实现在同一组样例上给出同一顺序。

行为由既有用例照常覆盖（都改走新位置）：`commit-push-runner`（锁区间、消息、兜底、跳过、排除、修复、凭据失败、selected Git）、RFC-210 子仓
三个、`rfc370-repository-git-workspace`、`rfc098-commitpush-nonblocking`、`rfc205-git-credential`、`scheduler-commit-push`、`commit-push-core`、
`commit-push-output-lang-directive`、`rfc282-b2-resolve-injection`、`rfc395-a2-checkpoint-bytes`、RFC-321 发布用例。
集中验证按 RFC-474 的做法：导出仓库里全量 SQLite、改动闭包的 30 秒复跑与 PostgreSQL lane、P0、shared / frontend / system-mocks、文档用例与计数复核。
