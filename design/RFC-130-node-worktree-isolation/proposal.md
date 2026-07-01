# RFC-130 Proposal —— 删除 readonly 标记 + 每节点隔离 worktree 的 DAG 并行执行

> 状态：Draft
> 触发：2026-07-01 用户「取消 agent 的只读标记，在调度执行的时候，让多个节点可以按照树的依赖关系并行执行下去」
> 关联：重写 [RFC-098](../RFC-098-scheduler-audit/) 建立的「单 worktree + 写锁串行」隔离模型；影响 RFC-092（pre-snapshot 回滚）、RFC-060（fanout）、RFC-066（多仓）、RFC-075（auto commit&push）、wrapper-git / wrapper-loop。
> 决策来源：2026-07-01 用户三轮拍板 —— ① 隔离 worktree + 串行合并回主树；② 彻底删除 readonly；③ 冲突交给内置合并 agent、解不了转 awaiting_human；④ 一次性覆盖全部 wrapper 组合。

## 0. 一句话

今天调度器的 DAG 并行**已经存在**（完成驱动 frontier），但**可写节点被一把每任务的写锁串成一次一个**——因为整个任务共用同一个 git worktree，并发写会互相覆盖。`readonly` 标记的**唯一作用**就是让「不写盘」的 agent 跳过写锁、真并行。本 RFC **彻底删除 readonly**，改为**给每个 node run 一个从主 worktree 快照分叉出的隔离 worktree**：所有节点（含可写）在各自隔离区并行跑 opencode，成功后在写锁下把改动**串行合并回唯一主 worktree**（git 三路合并，不重叠自动并、真冲突交给一个内置合并 agent 解、解不了转 `awaiting_human`）。并行度从「写节点一次一个」提升到「受 `globalSem` 约束的 DAG 并行」。

## 1. 背景

### 1.1 现状执行模型（已核对源码）

- **DAG 并行已存在**：`scheduler.ts:711` 的 `runScope` 是**完成驱动**——每 tick 从 `node_runs` 重推可派发前沿（`deriveFrontier`），`Promise.race` 等最先完成的一个，它一完成立刻放行下游。相互无依赖的节点本来就并发跑，上限是 `globalSem`（默认 4，`maxConcurrentNodes`）。
- **写节点被串行**：`scheduler.ts:1960` `const releaseWrite = agent.readonly ? null : await writeSem.acquire()`。`writeSem` 是**每任务一把、容量 1** 的写锁（`taskWriteLocks.ts`），且**在整个 agent 运行期间持有**（:1962 acquire → :2872 release，可能几分钟）。只读节点跳过它 → 真并行；可写节点抢它 → **一次只能一个写、其余排队**。
- **根因 = 共用一个 worktree**：每个任务只有一个 git worktree（`~/.agent-workflow/worktrees/{repo-slug}/{task-id}`，多仓则每仓一个，RFC-066）。所有节点以它为 cwd。两个可写节点若同时以它为 cwd 写文件，改动互相覆盖；git wrapper 的 diff 快照（`scheduler.ts:4588/4675`，在写锁窗口内取 pre/post）也会被并发写污染。**写锁是为规避这个而生的**（RFC-098 audit S-17/S-24）。
- **fanout / aggregator 同理**：`scheduler.ts:4061/4351` 三处都是 `agent.readonly ? null : writeSem.acquire()`——fanout 的可写 shard 也在同一把写锁上串行。

### 1.2 `readonly` 的现有职责（删除时要一并处理）

`readonly` 今天兼三件事：

1. **调度并行门**（主职）：跳过 `writeSem`（`scheduler.ts:1960/4061/4351`）；决定失败重试是否回滚 worktree（:2049）、是否取 pre-snapshot（:2164）。
2. **claude-code 软沙箱**：`runtime/claudeCode/spawn.ts:87` `if (ctx.readonly) cmd.push('--disallowed-tools', 'Write Edit MultiEdit NotebookEdit')`（尽力而为、非真沙箱，Bash/MCP 仍能写）。
3. **注入 opencode 配置**：`runner.ts:848/1691` 把 `readonly` 塞进 `OPENCODE_CONFIG_CONTENT.options`。
4. **内置 commit agent 标了 `readonly:true`**（`commitPush.ts:36`）。

用户已拍板 **② 彻底删除**：DB 列 `agents.readonly`、`AgentSchema`/`CreateAgentSchema`/`InventoryAgentSchema` 字段、`AgentForm` 手填开关、依赖树 chip（`DependencyTree.tsx`）、claude-code 写工具门禁、i18n（`fieldReadonly*`）——全清。agent 不再有只读概念，**那层软沙箱能力一并没了**（用户知情）。

### 1.3 痛点

用户要跑「一份代码 → 多个独立分支各自修改 / 加工」的工作流：树上互不依赖的**可写**分支本应并行，今天却因写锁退化成串行——`globalSem=4` 形同虚设（对可写节点）。用户不想靠手填 `readonly` 换并行（大多数干活 agent 本就要写盘、标不了只读），要的是**框架按依赖树自动并行、写入互不干扰**。

## 2. 目标

1. **彻底删除 readonly**（§1.2 全部触点）；并行不再由任何手填标记决定。
2. **每个 node run 一个隔离 worktree**：派发时从主 worktree 的**当前状态**（HEAD + 未提交改动）快照出一个独立 worktree，opencode 以它为 cwd 运行。相互无依赖的节点各在自己的隔离区并行写，互不干扰。
3. **并行度 = DAG × globalSem**：把「可写节点一次一个」提升为「受 `globalSem` 约束的完成驱动 DAG 并行」。写锁只在**极短的**快照与合并窗口持有，不再罩住多分钟的 agent 运行。
4. **串行合并回唯一主树**：节点成功后在写锁下把它的改动（隔离终态 vs 隔离起点快照的 diff）**三路合并**回主 worktree。不重叠的改动自动合并。
5. **冲突自动解 + 人工兜底**：真冲突（三路合并出重叠）→ 派发**内置全局合并 agent**读冲突并解；解不了（输出仍带冲突标记 / 进程失败耗尽重试）→ 任务转 `awaiting_human`，人工在主 worktree 解完 resume。
6. **一次覆盖全部组合**：顶层 DAG + wrapper-git + wrapper-loop（git-in-loop / loop-in-git / loop-in-loop）+ wrapper-fanout（含 aggregator）+ 多仓（RFC-066）+ resume / 单节点重试 / 恢复。
7. **保持既有不变量**（§下）。

### 2.1 必须保持的不变量

- **I-1 单一规范 worktree**：主 worktree 仍是 resume、输出读取、git wrapper diff、最终产物、auto commit&push 的唯一事实源。隔离 worktree 是**临时工作区**，用完即弃。
- **I-2「未提交改动即产物」模型不变**：合并回主树落地为**未提交的工作区改动**（不新增 git 历史提交）；git wrapper 的 `git_diff` 仍 = 内部节点改动全集（含 untracked）。
- **I-3 数据仍走端口**：节点间数据流仍经输出端口（XML envelope），**不靠 worktree 传递**。worktree 只是 agent 的工作区；隔离不改变端口语义。
- **I-4 wrapper 语义**：git wrapper = 内部改动全集；`git in loop` = 每迭代 diff（末迭代为输出）；`loop in git` = 全循环总 diff——隔离后逐字保持。
- **I-5 失败零污染（新增、比现状更强）**：失败 / canceled 的 node run **从不合并回主树**（合并只在成功后发生），所以失败尝试对主 worktree **零污染**——这比今天「写进主树再回滚」更干净，且简化 RFC-092/098 的回滚。

## 3. 非目标

- **不改端口 / envelope / 数据流模型**（I-3）；不把每节点分支持久化进 git 历史（I-2，合并落地为工作区改动）。
- **不改工作流定义 / 编辑器**：节点、边、wrapper、`single ↔ multi` 语义不变；作者不需要为并行做任何标注（并行是引擎按 DAG 自动决定的）。
- **不引入用户可见的并行度旋钮之外的新配置**：并行度仍用既有 `config.maxConcurrentNodes`（默认 4）；不新增 per-node 并行开关。
- **不做「冲突合并策略选择」（ours/theirs/union）**：冲突一律走合并 agent → awaiting_human，不给静默丢改动的策略选项（用户已否决 §AskUserQuestion）。
- **不改 auto commit&push 的提交/推送语义**（RFC-075）：它仍在主 worktree 上直接跑（§design 特殊路径），只是不再带 `readonly` 标。
- **不做「按 permission 证明不写盘就免隔离」的性能优化**：v1 一律隔离（正确性优先）；此优化列为后续（§design §性能）。

## 4. 用户故事

1. 我有个工作流：`git wrapper { 拉取基线 → [ 改模块A 的 agent, 改模块B 的 agent, 改模块C 的 agent ] → 汇总 }`。三个改动 agent 互不依赖、都要写盘。
2. 过去：三个 agent 因写锁一次跑一个，`globalSem=4` 帮不上忙，总时长 ≈ 三者之和。
3. 现在：三个 agent 各自在从基线快照出的隔离 worktree 里并行跑（受 `globalSem` 约束），总时长 ≈ 最慢的一个。
4. 三者改的是不同模块（不同文件）→ 合并回主树全部自动并，主 worktree 得到三份改动的并集，汇总节点照常读到。
5. 换个场景：A 和 B 都改了同一个 `config.ts` 的**相邻不同行** → git 三路合并**自动并**，无需人工。
6. 再换：A 和 B 改了 `config.ts` 的**同一行**（真冲突）→ 框架派发内置合并 agent，把两版 + 冲突标记喂给它，它择优合出一版、写回主树，任务继续。
7. 极端：合并 agent 也解不了（输出仍带 `<<<<<<<` 标记）→ 任务转 `awaiting_human`，我在主 worktree 手工解完冲突、点 resume，任务从合并点继续。
8. 我编辑 agent 时，表单里**再没有「只读」开关**；依赖树里也没有「只读 / 写」chip——并行是引擎按依赖自动来的，我不用操心。

## 5. 验收标准（AC）

**并行与隔离**
- **AC-1**：两个相互无依赖的可写节点，在同一前沿被派发后**并发运行 opencode**（各自独立 worktree），二者的运行时间窗**重叠**（不再被写锁串行）。并发上限 = `globalSem`。
- **AC-2**：每个 node run 的 opencode cwd = 一个**独立目录**，起点内容 = 派发时刻主 worktree 的 HEAD + 未提交改动（含 untracked）。一个节点在自己 worktree 的写入**不出现**在同前沿另一节点的 worktree。
- **AC-3**：有依赖的节点（B 依赖 A）——B 的隔离起点包含 A 的改动（因 B 在 A 合并回主树后才派发）。

**合并回主树**
- **AC-4**：节点成功 → 其改动被合并回主 worktree，落地为**未提交**工作区改动；`git diff HEAD` 含该节点改动。不新增历史提交。
- **AC-5**：两个并发节点改**不同文件** / **同文件不重叠 hunk** → 都自动合并，主 worktree 含二者改动全集，无冲突标记。
- **AC-6**：失败 / canceled 节点**不合并回主树**——主 worktree 不含其任何改动（I-5）。

**冲突处理**
- **AC-7**：两并发节点改**同一处**（三路合并重叠）→ 框架派发**内置合并 agent**，输入含双方版本 / 冲突标记；其输出（无残留冲突标记）写回主树，任务继续，合并点节点最终 `done`。
- **AC-8**：合并 agent 解不了（输出仍含冲突标记，或进程失败耗尽重试）→ 任务转 `awaiting_human`，主 worktree 保留带标记的冲突文件；resume 后从合并点继续（人工已解则合并成功）。
- **AC-9**：合并 agent 走 RFC-117 的内置 agent 运行时配置（设置里可配运行时 / 模型），与 distiller / commit-push 同构。

**wrapper / 多仓 / 恢复**
- **AC-10**：wrapper-git 的 `git_diff` = 内部所有节点改动全集（并行 + 合并后与串行结果**等价**，I-4）。
- **AC-11**：wrapper-loop 每迭代内部节点隔离 + 合并；`git in loop` 末迭代 diff、`loop in git` 全循环总 diff 与串行语义一致。
- **AC-12**：wrapper-fanout 的可写 shard **并行**跑各自隔离 worktree，合并回主树按 shard_key 序（不同 shard 通常改不同文件，冲突走 §AC-7/8）；aggregator 隔离 + 合并。
- **AC-13**：多仓（RFC-066）——隔离 + 合并**逐仓**进行；一仓冲突不影响他仓。
- **AC-14**：单节点重试 / resume —— 重试丢弃失败的隔离 worktree、从**当前主树**重新快照分叉（无需回滚主树，I-5）；daemon 重启后孤立隔离 worktree 被 GC。

**readonly 删除**
- **AC-15**：`agents.readonly` 列删除（migration）；`AgentSchema` 等无 `readonly` 字段；`AgentForm` 无只读开关；依赖树无只读 chip；claude-code 无 `--disallowed-tools` 门禁；`fieldReadonly*` i18n 删除。全仓 grep `readonly`（agent 域）无残留。
- **AC-16**：既有 agent.md / 导入含 `readonly:` 键 → 降级路由进 `frontmatterExtra`（不丢、不报错），与 RFC-115 处理旧 `model:` 键同惯例。

**回归**
- **AC-17**：线性工作流（无并行分支）行为不变——单个可写节点仍隔离 + 合并，但因无并发，合并总是干净应用（主树未动过），最终产物逐字等价于今天。
- **AC-18**：`bun run typecheck && bun run test && bun run format:check` 全绿；单二进制 smoke + Playwright e2e 通过。

## 6. 影响面（详见 design.md / plan.md）

- **数据**：删 `agents.readonly` 列（migration）；`node_runs` 加隔离 worktree 记账列（隔离 worktree 路径 / 隔离起点快照 sha / 合并状态），供 resume 与 GC。
- **后端核心**：`scheduler.ts`（隔离派发 + 合并回收 + 冲突→合并 agent + 三处 `writeSem` 语义改写）、`util/git.ts`（隔离 worktree 创建 + 三路合并原语）、`services/nodeRollback.ts`（回滚改为「弃隔离 worktree」）、新 `services/mergeAgent.ts`（内置合并 agent，仿 commitPush）、`services/gc.ts`（隔离 worktree GC）、`services/recovery.ts`（resume 适配）、`runner.ts`（去 readonly + cwd 指隔离 worktree）、`runtime/claudeCode/spawn.ts`（去门禁）。
- **配置**：新增合并 agent 运行时配置字段（仿 `commitPushRuntime`）。
- **前端**：`AgentForm` 去只读开关、`DependencyTree*` 去 chip、i18n 清 key、设置页加合并 agent 运行时选择器。
- **PR 拆分**：本 RFC 体量大，按 plan.md 拆多个强序 PR（数据 + 隔离核心 → 合并回收 + 合并 agent + 冲突/awaiting_human → readonly 删除 → wrapper/fanout/多仓覆盖 → resume/回滚迁移 → 前端），每个 PR 独立门禁全绿。
