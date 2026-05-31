# RFC-075 — 技术设计

> 读前置：proposal.md。术语：base = 基线分支；working = 工作分支；
> commit 节点 = 框架合成的 commit&push node_run。

## 1. 总览与现状锚点

两个正交能力，落在三个阶段：

| 阶段 | 能力 A（工作分支） | 能力 B（自动 commit&push） |
|---|---|---|
| 启动物化 | 创建/复用工作分支 + merge base | 持久化开关；无改动 |
| 运行时（每个顶层节点 done） | 无 | 触发 commit 节点（diff 驱动） |
| 任务详情 | 展示 working/base | commit 行 + 会话弹窗 |

现状锚点（实现时以源码为准）：

- worktree 创建：`util/git.ts:267 createWorktree`，分支硬编码
  `agent-workflow/${taskId}`（`git.ts:276`），base 经 `rev-parse` 落具体
  commit（`git.ts:283`）。
- base 远端同步：RFC-068 已落，`services/gitRepoCache.ts`（warm path FF）+
  `services/task.ts fetchPathRepoBeforeLaunch`（path 模式 opt-in fetch）。
- diff 产出：`util/git.ts:337 gitDiffSnapshot(worktreePath, fromCommit)` ——
  `git diff <fromCommit>`（working-tree vs commit）+ 未跟踪文件 `--no-index`。
  **关键性质**：对 `fromCommit=baseCommit` 而言，中间是否落 commit 不影响结果
  （working-tree 内容不变；落 commit 只是把改动从"未提交"变"已提交"，
  `git diff baseCommit` 仍把它们全列出）。这是 AC-17 的依据。
- 节点调度：`services/scheduler.ts`，顶层用 `topologicalOrder`（`:282`）；
  agent 单进程派发在 `runDesignerNode`-系函数里调用 `runNode`（`:1581`），
  wrapper-git/loop/fanout 各有 dispatch（`:921/924/927`）。
- runner：`services/runner.ts runNode`（`:365`）spawn 一个 opencode 子进程；
  RFC-067 身份 env 注入在 `:726`；输出信封解析见 `services/envelope.ts`
  （`detectEnvelopeKind` 返回 `'output'|'clarify'|'both'|'none'`，`:181`）。
- 会话视图：`routes/tasks.ts:428 GET /api/tasks/:id/node-runs/:nodeRunId/session`
  → `services/sessionView.ts getSessionTree`；前端 `components/node-session/
  SessionTab.tsx`（`ConversationFlow`）。记忆提取复用同组件
  （`components/memory/distill-job-detail/ConversationSection.tsx`）。
- 内置 agent 系统作业范式：`services/memoryDistiller.ts`（spawn opencode +
  会话捕获 + 详情页），是 commit 节点的直接模板（差别：cwd = worktree 而非
  临时目录）。
- 设置 schema：`packages/shared/src/schemas/config.ts`，
  `memoryDistillerEnabled`/`memoryDistillModel`（`:101/106`）是新增设置的范式。

## 2. 数据模型与迁移

新增 migration `00NN_rfc075_working_branch_commit_push.sql`（NN 取当前
journal 下一个；实现时核对 `drizzle/meta/_journal.json`）：

```sql
-- 能力 A：任务工作分支（task 级，作用到每个仓）
ALTER TABLE tasks ADD COLUMN working_branch TEXT;          -- NULL = 不指定（用隔离分支）
ALTER TABLE task_repos ADD COLUMN working_branch TEXT;     -- 多仓镜像（同名）

-- 能力 B：自动 commit&push 开关
ALTER TABLE tasks ADD COLUMN auto_commit_push INTEGER NOT NULL DEFAULT 0;

-- commit 节点元数据（标记 + 记录）
ALTER TABLE node_runs ADD COLUMN commit_push_json TEXT;    -- 见 §3 schema
```

说明：
- `tasks.branch` 仍是 worktree 的**真实本地分支名**：填了 working 即
  `tasks.branch = working_branch`；没填即 `agent-workflow/{taskId}`。
  `working_branch` 列只用于"区分这是用户指定还是框架默认"+ 详情展示。
- `task_repos.working_branch` 是多仓镜像（与 `task_repos.branch` 关系同上）。
- `commit_push_json` 非空即把该 node_run 标记为框架合成的 commit 节点（另见
  §3 nodeId 约定，双保险）。存量行 NULL，零影响。
- 不动 `node_runs.status` 枚举（沿用 `pending/running/done/failed/...`）。
  「降级」(权限失败) 用 `status=done` + `commit_push_json.pushOutcome` 表达，
  不新增枚举值，避免触动全量 lifecycle 不变式（`lifecycleInvariants.ts`）。

## 3. shared 契约

`packages/shared/src`：

```ts
// StartTaskSchema 扩展（task 级；与 repos[] 正交——working 作用到每个仓）
workingBranch: z.string().trim().min(1).max(255).optional(),  // 校验见 §3.1
autoCommitPush: z.boolean().optional(),                        // 默认 undefined≡false

// TaskSchema / TaskSummarySchema 扩展（详情/列表展示用）
workingBranch: z.string().nullable(),
autoCommitPush: z.boolean(),
// baseBranch / branch 已存在，详情页直接读

// NodeRunSchema 扩展：commit 节点元数据
commitPush: CommitPushMetaSchema.nullable().optional()

export const CommitPushMetaSchema = z.object({
  repoPath: z.string(),
  repoBranch: z.string(),          // 本地分支（working 或 isolation）
  pushTarget: z.string(),          // origin/<branch>
  baseRef: z.string(),
  commitSha: z.string().nullable(),
  filesChanged: z.number().int(),
  insertions: z.number().int(),
  deletions: z.number().int(),
  messageSource: z.enum(['llm', 'llm-repair', 'fallback']),
  repairAttempts: z.number().int(),
  pushOutcome: z.enum([
    'pushed',           // commit + push 成功
    'commit-local-auth',// push 鉴权失败 → 仅本地（降级，不重试）
    'commit-local-failed',// 修复重试耗尽 → 仅本地（failed）
    'skipped-empty',    // 无净改动（若 OQ2 选"生成行"才会出现）
  ]),
  pushError: z.string().nullable(), // 脱敏后的 push stderr 摘要
})
```

### 3.1 working branch 名校验
- 复用 `git check-ref-format --branch`（运行时校验，启动阶段跑一次）；前端
  做宽松正则（禁空格 / `~^:?*[` / 前后缀 `/` / `..` / 结尾 `.lock`）即时反馈。
- 不强校验，最终以 git 为准；非法 → 422 `working-branch-invalid`。

## 4. 运行时设计

### 4.1 启动：工作分支创建/复用（能力 A）

落点：`services/task.ts` materialize 阶段，`createWorktree` 之前/之内。新增
`util/git.ts` 函数：

```ts
// 返回最终 worktree 分支名 + baseCommit；失败抛带 code 的 ValidationError
export async function materializeWorkingBranch(opts: {
  repoPath: string; appHome: string; taskId: string;
  baseBranch: string;        // 已由 RFC-068 同步到远端最新的 base
  workingBranch?: string;    // 用户填的；undefined → 走旧逻辑
  ...submodule 透传
}): Promise<CreatedWorktree>
```

分支逻辑（单仓；多仓在 per-repo loop 里各调一次）：

1. `workingBranch === undefined`：**完全走现有 `createWorktree`**（分支
   `agent-workflow/{taskId}`），字节级守恒（grep guard 锁）。
2. 已同步 base → `baseCommit = rev-parse origin/<base>`（或 RFC-068 FF 后的
   本地 base）。
3. 判定 working 是否存在：
   - 本地 `git rev-parse --verify refs/heads/<working>`；
   - 远端 `git ls-remote --heads origin <working>`（已 fetch，可读
     `refs/remotes/origin/<working>`）。
4. **不存在** → `git worktree add -b <working> <worktreePath> <baseCommit>`。
5. **存在**（复用）：
   - 若该分支已被本仓另一个 worktree checkout（`git worktree list` 含它）→
     抛 `working-branch-in-use`。
   - 远端有/本地无 → 先 `git branch <working> origin/<working>` 建本地跟踪。
   - `git worktree add <worktreePath> <working>`（不带 `-b`，checkout 已有）。
   - **merge base**：在 worktree 里 `git merge --no-edit origin/<base>`：
     - 成功 → 继续；
     - 冲突（exit≠0）→ `git merge --abort` 后抛
       `working-branch-base-merge-conflict`（启动失败，worktree 回收）。
6. base 同步本身失败（fetch/解析 origin/<base> 失败）→ 抛
   `working-branch-base-fetch-failed`。**仅当用户填了 working** 才收紧为失败；
   未填 working 时保持 RFC-068「降级继续」语义不变。

`tasks.branch = 最终本地分支名`，`tasks.working_branch = workingBranch ?? null`。

### 4.2 触发：每个顶层节点 done → 是否提交（能力 B，diff 驱动）

**为什么 diff 驱动**：天然满足"只对 writer / 跳过 readonly / wrapper 作为单位
/ 多 output 只提交一次"——因为触发条件是"顶层节点完成后 worktree 相对上次
commit 是否有净改动"，而非"agent 写没写"。

落点：scheduler 在**任一顶层节点**（agent 或 wrapper）抵达终态 `done` 后，
统一过一道 `maybeCommitAfterTopLevelNode(node, nodeRun)`：

前置门槛（任一不满足直接跳过）：
- `task.autoCommitPush === true`；
- 该 node_run 是**最终产出**：`status==='done'` 且本次信封 kind 为 `'output'`
  （非 `clarify`/`both`/`none`、非 awaiting_human）。clarify 轮 / 失败 / 取消
  一律不触发（满足 AC-10）。
- 节点是**顶层**（不在任何 wrapper 内部——内部节点完成不触发，由 wrapper 的
  done 统一触发，满足 §4.3 / AC-20）。

满足后，**对每个仓**（单仓即 1 个；多仓遍历 `task.repos`）：
1. 计算"上次 commit 以来"的脏状态：`git -C <repoWorktree> status --porcelain`
   非空？（等价地：与上一笔 commit 比对）。空 → 跳过该仓（AC-11）。
2. 非空 → 合成并执行一个 commit 节点 run（§4.4），`parentNodeRunId =
   触发它的 agent node_run id`，`commit_push_json.repoPath = 该仓`。

并发：commit 节点**纳入写串行**——scheduler 现有"写节点串行、readonly 并行"
约束下，commit 节点视为写操作，挂在触发它的 writer 之后、下一个 writer 之前，
两个 commit 永不交错（OQ6）。

### 4.3 wrapper 内的 writer

- wrapper（git/loop/fanout）内部节点完成**不**单独触发（它们非顶层）。
- wrapper 节点自身 done 后走同一 `maybeCommitAfterTopLevelNode`：此时 worktree
  已是 wrapper 全部内部节点跑完的净状态，diff 驱动 → 提交一次净改动（AC-20）。
- wrapper-git 的 `git_diff` 产出不受影响：它内部用 worktree vs 自己的
  pre-snapshot commit 计算；本 RFC 的 commit 落在 wrapper 完成**之后**，不进
  wrapper 的 diff 窗口。即便落在中间，§1 的透明性也保证 diff 不变。

### 4.4 commit 节点执行（框架托管 git + opencode 仅 message/修复）

合成一条 `node_runs`：
- `nodeId = "__commit_push__:" + agentNodeId (+ ":" + repoSlug 多仓)`（不在
  workflow 定义里 → scheduler 的节点循环不会重复调度它）。
- `kind` 语义靠 `commit_push_json` 非空标记；`parentNodeRunId` 指向 agent run。
- `status: running → done/failed`；`retryIndex` 记修复次数；
  `opencodeSessionId` 记 message/修复会话（供会话视图）。

执行步骤（框架，确定性）：

```
1. stage:   git -C W add -A
2. stat:    git -C W diff --cached --stat           → filesChanged/ins/del
            git -C W diff --cached (截断到 commitPushDiffMaxBytes，首尾各半)
3. message: 起内置 commit agent 的 opencode 会话（cwd=W），prompt 注入
            {{stat}} + {{diff_truncated}} + 仓名/分支/base，要求输出
            <workflow-output><port name="commit_message">…</port></workflow-output>
            一行 subject + 可选 body。会话被 sessionCapture 捕获。
            会话失败/无信封 → fallback message（§4.6）。messageSource 记来源。
4. commit:  git -C W -c user.name=<id> -c user.email=<id> commit -m <message>
            （身份取 task.gitUserName/Email，复用 RFC-067；无身份则不带 -c，
             回落 git 原生解析。框架直跑 git，所以这里显式注入而非靠 spawn env。）
5. push:    git -C W push -u origin <localBranch>:<localBranch>
            （working 或 isolation；绝不 --force）
6. push 结果分类（§4.5）。
```

### 4.5 push 失败分类与修复循环

对 `git push` 的 stderr 分类（正则白名单，保守归类；无法判定按"可修复"走）：

- **鉴权/权限类**（`Permission denied` / `authentication failed` / `403` /
  `could not read Username` / `publickey` 等）→ `pushOutcome='commit-local-auth'`，
  node `done`（降级），WARN，**不重试**，继续后续节点（AC-16 / US-6）。
- **非快进**（`non-fast-forward` / `fetch first` / `Updates were rejected`）→
  框架**有界自动合并一次**：`git fetch origin <branch>` +
  `git merge --no-edit origin/<branch>`：
  - 无冲突 → 重推；仍失败则转下一类或计一次失败。
  - 冲突 → `git merge --abort`，计为一次"可修复失败"进入修复会话（让 LLM 决定
    改 message 是否有用；多数情况下非快进改 message 无用 → 很快耗尽 →
    `commit-local-failed`）。（OQ3）
- **其它/规范类**（server hook 拒收、commit-msg 格式、`pre-receive` 等）→
  进入**修复会话**：起新 opencode 会话，注入"充足上下文"：push 失败原文
  （脱敏）+ 当前 message + diff `--stat` + 仓/分支信息 + 既往修复尝试，要求
  输出修正后的 `commit_message`。框架 `git commit --amend -m <new>` 后重推。
  - 每次修复 = `retryIndex += 1`，`repairAttempts += 1`，`messageSource='llm-repair'`。
  - 上限 = `config.commitPushMaxRepairRetries`（默认 3）。耗尽仍失败 →
    `pushOutcome='commit-local-failed'`，node `failed`，commit 留本地，WARN，
    **继续后续节点**（不 fail 整个 task，AC-15）。

所有路径：**commit 一定先在本地成功**，再尝试 push；这样任何 push 失败都不
丢 agent 成果。

### 4.6 内置 commit agent

- 框架内置（非用户可编辑），范式同 distiller：固定 system prompt、`outputs:
  [commit_message]`、无 skills/mcp/memory inject、`readonly` 无意义（它不写
  worktree，只产文本——git 由框架跑）。
- 模型：`config.commitPushModel`（未配 → opencode 安装默认，OQ4）。
- diff 截断：`config.commitPushDiffMaxBytes`（默认 16384，首 50% + 尾 50% +
  `[truncated N bytes]`，始终附 `--stat`，OQ5）。
- fallback message（会话失败/超时/无信封）：
  `chore(agent-workflow): <agentName> changes (N files, +I/-D) [task <id8>]`。

## 5. 设置（config.ts）

```ts
commitPushModel: z.string().min(1).optional(),               // 默认未配=opencode 默认
commitPushMaxRepairRetries: z.number().int().min(0).max(10).optional(), // 默认 3
commitPushDiffMaxBytes: z.number().int().min(0).max(262144).optional(), // 默认 16384
```
后端 loader backfill 默认值；Settings 前端在「Git / 提交」分区给 3 个控件
（复用 Form primitives + Select；模型输入建议填便宜模型）。

## 6. 前端

- **启动表单**（`routes/tasks.tsx` 或 launcher 组件）：
  - 「工作分支（可选）」`<TextInput>`（放在 base ref 选择附近）；hint：留空
    则用隔离分支。
  - 「完成后自动提交并推送」`<Switch>`（默认关）；记住上次选择
    （localStorage）。
  - 多仓：工作分支为单一 task 级输入（作用到每仓），不每行重复。
- **任务详情**（`routes/tasks.detail.tsx`）：在任务信息区显示
  **工作分支** + **基线分支**（多仓逐仓显示 working/base）；复用既有
  label/值排版，禁止自写 chrome。
- **节点列表**：commit 行（`commit_push_json` 非空的 node_run）渲染为独立行，
  挂在其 `parentNodeRunId` agent 行之下/之后：
  - 标题：`commit & push · <分支>`（多仓加仓名）；状态 chip 用 `<StatusChip>`；
    pushOutcome 派生小标（已推送 / 仅本地·推送受限 / 仅本地·失败 / 无改动）。
  - 「查看会话」按钮 → `<Dialog>` 内嵌 `SessionTab`（复用既有组件 +
    `/api/tasks/:id/node-runs/:nodeRunId/session`）。
- i18n：cn/en 对称（AC-21）。所有控件走公共组件（Switch/TextInput/Dialog/
  StatusChip），不落原生元素。

## 7. 与既有 RFC 的耦合

- **RFC-067**（commit 身份）：框架直跑 git，§4.4 步骤 4 显式 `-c user.*` 注入
  任务身份；与 opencode 自发 commit 的 env 注入并行不悖。
- **RFC-068**（base 同步）：能力 A 复用其 fetch+FF 拿"base 远端最新"；仅工作
  分支路径把"fetch 失败"从降级收紧为启动失败（§4.1.6）。
- **RFC-066**（多仓）：能力 A per-repo 建分支；能力 B per-repo 触发（§4.2）；
  `task_repos.working_branch` 镜像。
- **RFC-021/072**（任务详情 tab）：commit 行进现有节点列表 tab。
- **RFC-027/043/048**（会话捕获/视图）：commit 会话复用 sessionCapture + 同
  路由 + `SessionTab`。
- **RFC-042/053**（节点 lifecycle/重试/恢复）：commit 节点 `retryIndex` 用于
  修复重试；任务恢复时 commit 节点幂等——重跑 writer 会基于"自上次 commit 的
  净改动"再提交，已推送内容不会重复（净 diff 可能为空 → skip）。
- **wrapper-git**：§4.3 + §1 透明性，互不干扰。

## 8. 测试策略（test-with-every-change 强制）

纯函数 / 数据预言优先，运行时巨组件留源码文本断言兜底。

### 单元（util/git + 纯逻辑）
- `materializeWorkingBranch`：新建 / 复用-merge 成功 / 复用-merge 冲突 /
  base-fetch 失败 / branch-in-use / 未填 working 走旧路径（grep guard 锁分支名
  `agent-workflow/{taskId}` 仍存在）。
- push stderr 分类器 `classifyPushFailure(stderr)`：鉴权 / 非快进 / 规范拒收 /
  未知（按可修复）各若干样本（含中英 git 文案）。
- commit message fallback 组装纯函数。
- diff 截断纯函数（首尾各半 + marker + stat 始终在）。
- envelope kind 门槛：`shouldTriggerCommit(status, envelopeKind)` 真值表
  （output→true；clarify/both/none/非 done→false）。
- `commit_push_json` zod round-trip。

### 集成（mock-opencode + 真 git 临时仓）
- 端到端：开开关 → 单 writer agent（多 port 输出）→ 恰好 1 个 commit 节点，
  push 到临时 bare remote 成功，`commit_push_json.pushOutcome='pushed'`。
- 反问轮不提交，老化后最终 output 才提交（AC-10）。
- readonly auditor 无改动 → 无 commit 行（AC-11）。
- push 被 mock 拒（用临时 remote 装 `pre-receive` hook 拒非规范 message）→
  修复会话改 message → 重推成功，`repairAttempts=1`（AC-14）。
- 鉴权失败（指向不可写 remote）→ commit-local-auth，不重试，后续节点继续（AC-16）。
- 修复耗尽 → failed + 本地 commit 在 + 任务继续（AC-15）。
- **透明性 AC-17**：同一工作流跑两遍（开/关 commit&push），断言任务 diff
  endpoint 输出逐字节一致。
- 多仓：一个 agent 改一仓 → 仅该仓 commit 行（AC-19）。
- wrapper-loop 含 writer → wrapper 完成后 1 个 commit（AC-20）。
- 身份 AC-18：`git log -1 --pretty=fuller` author/committer = 任务身份。

### 源码层兜底
- grep guard：`agent-workflow/${...taskId}` 仍在 `util/git.ts`（未误删隔离分支）。
- migration round-trip（drizzle）+ 默认 backfill 测试。

### 前端
- 启动表单两控件渲染 + 默认值 + localStorage 记忆（RTL，`getByRole`）。
- 任务详情展示 working/base（含多仓）。
- commit 行渲染 + pushOutcome 小标 + 「查看会话」按钮打开 Dialog（角色断言）。
- i18n cn/en key 对称测试。

### e2e（Playwright）
- 启动一个带工作分支 + commit&push 的任务（mock-opencode + 临时仓）→ 任务
  详情看到工作分支名 + commit 行 + 点开会话弹窗。

## 9. 失败模式汇总

| 场景 | 行为 | 是否阻断 |
|---|---|---|
| working merge 冲突 | 启动失败 `working-branch-base-merge-conflict` | 阻断启动 |
| working base fetch 失败 | 启动失败 `working-branch-base-fetch-failed` | 阻断启动 |
| working 被别的 worktree 占用 | 启动失败 `working-branch-in-use` | 阻断启动 |
| commit message 会话失败 | 用 fallback message | 不阻断 |
| push 鉴权失败 | commit-local-auth + WARN | 不阻断，节点 done(降级) |
| push 规范拒收 | 修复会话 → 重推 | 重试内不阻断 |
| 修复耗尽 | commit-local-failed + WARN，节点 failed | 不阻断后续节点 |
| push 非快进 | 有界自动合并一次 → 重推 / 转修复 | 视结果 |
| commit 本身失败（极罕见，如磁盘满）| 节点 failed | 该节点失败（写串行，影响下游） |

## 10. 估算与 PR 拆分

见 plan.md。核心改动集中在 `util/git.ts` + `services/task.ts`（能力 A）、
`services/scheduler.ts` + 新 `services/commitPush.ts`（能力 B）+ shared schema
+ migration + 前端启动表单/详情/节点行。无 runtime 协议改动。
