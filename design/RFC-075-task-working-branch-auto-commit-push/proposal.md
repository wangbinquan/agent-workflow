# RFC-075 — 任务工作分支 + 框架托管的自动 commit & push 节点

> 状态：Draft（2026-05-31）
> 作者：与用户澄清 3 轮后落档（澄清记录见本文「澄清结论」）

## 1. 背景

当前 task 运行流程里，**框架从不 commit、也从不 push**：

- worktree 物化时框架在源仓 `git worktree add -b agent-workflow/{taskId}
  <baseCommit>`，始终拉一条隔离分支（`util/git.ts:276`），保证并发同仓
  task 互不串。
- 节点产出靠 `gitDiffSnapshot`（`util/git.ts:337`）：把 worktree 工作目录
  状态（含未跟踪文件，经 `git diff --no-index`）与记录下的 `baseCommit`
  对比，得到 unified diff 喂给 reviewer / fanout。**全程不落 commit**。
- agent（opencode）自己可以在 worktree 里 `git commit`（RFC-067 给它注入
  了 author/committer 身份），但这完全是 agent 自发行为，框架不组织、不
  汇总、不推送。

由此带来三个产品缺口：

1. **结果留不下来**：一个 Code→Audit→Fix 工作流跑完，所有改动只活在
   worktree 工作目录里（未提交）。用户要么手动进 worktree commit/push，要
   么靠 RFC-071 下载文件。没有"任务跑完，分支自动推到远端等 review"的闭环。
2. **没有受控的工作分支**：worktree 永远叫 `agent-workflow/{taskId}`，用户
   无法指定一个有意义的分支名（如 `feature/login-refactor`）让产物直接落在
   上面、推到远端走 PR。
3. **多 agent 的增量历史缺失**：一个工作流里多个 writer agent 顺序改代码，
   理想情况下每个 agent 完成后留一笔带摘要的 commit，形成可追溯的增量历史；
   今天全糊在一坨未提交改动里。

RFC-068（启动前同步 base 到远端最新）和 RFC-067（任务级 commit 身份）已
经把"基线最新"和"commit 身份"两块地基铺好，但都**不**碰"创建工作分支"
和"框架主动 commit/push"。本 RFC 补上这两块，且把它们设计成**两个正交、
可独立开关**的能力。

## 2. 目标

### 2.1 能力 A：工作分支（working branch）

- 启动任务时可选填一个**工作分支名**（单仓 / 多仓都填同一个名字，分别作用
  到每个仓）。
- 启动时框架先把 **base 分支同步到远端最新**（复用 RFC-068 的 fetch +
  fast-forward），再据此处理工作分支：
  - 工作分支**不存在**（本地 + 远端都没有）→ 基于 base 最新 commit 新建并
    checkout 到 worktree（取代默认的 `agent-workflow/{taskId}`）。
  - 工作分支**已存在**（本地或远端）→ **复用**：checkout 该分支，并把
    `origin/<base>` 最新内容 **merge** 进来（保留工作分支已有历史）。
- 工作分支与 commit&push 开关**完全独立**：只填工作分支、不开 commit&push
  → 启动时只创建/复用并切到工作分支，之后框架不主动提交。

### 2.2 能力 B：自动 commit & push（框架托管节点）

- 启动任务时给一个**开关**（默认关），开启后：**每个会写文件的顶层 agent
  节点产出"最终内容"后**，框架自动把该 agent 留下的全部改动 commit 并 push
  到远端。
- "最终内容" = agent 输出 `<workflow-output>` 信封那一次（**反问
  `<workflow-clarify>` 不算**——反问轮老化后真正出最终结果的那次才触发）。
- commit&push 由**框架自主合成一个独立的"commit & push"节点**，纳入任务
  节点执行管理：有自己的 status / 重试 / 会话，在节点列表里以独立行展示。
- **节点挂载方式必须避开"一个 agent 多输出 = 多次提交"**：commit 节点按
  **agent 节点完成事件**触发一次（无论该 agent 声明了几个 output port），
  绝不按单个 output port 挂载。
- **push 目标分支**：
  - 配了工作分支 → push 到 `origin/<工作分支>`。
  - 没配工作分支 → push 到 `origin/agent-workflow/{taskId}`（隔离分支推到
    远端，**不写 base 分支**）。
- **commit message 由 LLM 总结 diff 生成**：框架起一个内置「commit」系统
  agent 的 opencode 会话，喂 diff（截断）+ `--stat`，拿回一条规范化提交信息。
- **git 操作框架自己执行**（`git add -A` / `git commit` / `git push`）；
  opencode 只负责"生成信息"和"修复被拒的推送"，不直接跑 git。
- **push 失败分类处理**：
  - 权限/鉴权类失败 → 框架处理不了，只 **commit 到本地** + WARN + 继续后
    续节点（节点标记降级，不重试）。
  - 其它类失败（典型：远端因 commit message 不符合规范 / server hook 拒收
    / 非快进）→ 起一个**新的 opencode 会话**做修复（拿到失败原因 + diff +
    当前 message 等充足上下文），框架据修复结果重新 commit + push；每次修复
    计入该 commit 节点的**重试次数**，达上限仍失败 → 节点 failed（commit
    留本地）+ WARN + 继续。
- **会话可见**：commit 节点的对话过程（生成 message / 修复推送）能像 agent
  节点会话、记忆提取会话一样查看——在节点列表的 commit 行给一个按钮，弹窗
  展示会话时间线（复用既有 Session 视图）。

### 2.3 任务详情展示

- 任务详情页显示当前的**工作分支名**与**基线分支名**。

### 2.4 多仓（RFC-066）

- 多仓任务里，单个 agent 完成后，对它**改动过的每个仓**各起一行独立的
  commit&push 节点（各自 diff / message / push / 修复会话）；同一个工作分支
  名作用到每个仓；没改动的仓跳过。

## 3. 非目标

- **不替用户解决推送鉴权**（沿用 RFC-067 立场）：push 走环境里既有的 SSH
  key / credential helper；缺凭证就是权限类失败，按 2.2 降级处理。
- **不做强制推送**（force-push）：任何分支都不 `--force` / `--force-with-lease`。
- **不在 path 模式下替用户改本地仓工作目录 / 当前分支**：工作分支创建只发生
  在 task 自己的 worktree 里（worktree 与源仓共享对象库与 remote）。
- **不引入跨迭代反馈**或改 wrapper 语义：wrapper（git/loop/fanout）内部的
  writer 仍按"wrapper 作为一个原子节点完成后提交一次"处理（见 design §4.3）。
- **不做 GPG/SSH commit 签名**（与 RFC-067 一致，另立 RFC）。
- **不做工作流定义级的 commit 节点**：commit&push 是**任务级开关**合成的运
  行时节点，**不**进 workflow 定义、**不**进画布编辑器。
- **不做任务启动后修改工作分支 / 开关**：与 RFC-067 同理，跑起来就只读。
- **存量任务零行为变更**：两个开关默认关 / 空，老任务及"恢复运行"（RFC-042）
  字节级守恒。

## 4. 用户故事

- **US-1 受控工作分支 + 自动推送**：我启动任务，填工作分支
  `feature/refactor-auth`、打开 commit&push。框架同步 base 到远端最新，新建
  该分支。工作流跑 Code→Audit→Fix，Code agent 完成后框架自动 commit（信息
  "refactor: extract auth middleware …"）并 push；Fix agent 完成后再 commit
  +push。我打开远端就能看到 `feature/refactor-auth` 上两笔带摘要的 commit，
  直接发 PR。
- **US-2 只要工作分支、不要自动推送**：我只填工作分支、不开开关。框架启动
  时创建并切到该分支，agent 在上面改；跑完我自己进 worktree 决定怎么提交。
- **US-3 只要自动推送、不要工作分支**：我开开关、不填工作分支。框架在隔离
  分支 `agent-workflow/{taskId}` 上 commit，并把它 push 到远端同名分支（**不
  碰 main**），我后续自己合。
- **US-4 复用已有分支**：我填一个远端已存在的 `feature/x`。框架 checkout 它
  并把 `origin/main` 最新 merge 进来；若 merge 冲突或 base 拉取失败，**启动直
  接失败**并告诉我原因，让我先手工理顺。
- **US-5 推送被规范拦下**：远端装了 commit-msg hook 要求 Conventional
  Commits。框架第一次 push 被拒（信息格式不符）→ 起修复会话，拿到拒收原文
  + diff + 原 message，生成合规 message，框架 `commit --amend` 后重推成功；
  这次修复在 commit 行显示为"重试 1 次"，点会话能看到修复对话。
- **US-6 无推送权限**：CI 机器没有 push 凭证。框架 commit 到本地成功、push
  报 `Permission denied` → 节点标记"已本地提交（推送受限）"+ WARN，不重试、
  不阻断，后续节点照跑。
- **US-7 多仓**：双仓任务，一个 agent 改了仓 A 没动仓 B。完成后框架只对仓 A
  起一行 commit&push，仓 B 跳过。

## 5. 验收标准（详细 case 见 design §8 测试策略）

### 工作分支
- AC-1 不填工作分支 → worktree 分支仍是 `agent-workflow/{taskId}`，字节级守恒。
- AC-2 填新分支 → worktree checkout 到该分支，起点 = base 远端最新 commit。
- AC-3 填已存在分支（本地）→ checkout + merge `origin/<base>`；无冲突即启动成功。
- AC-4 填已存在分支但 merge 冲突 → 启动失败 `working-branch-base-merge-conflict`。
- AC-5 base 拉取失败（工作分支路径）→ 启动失败 `working-branch-base-fetch-failed`
  （**注意**：与 RFC-068「fetch 失败降级继续」不同，仅工作分支路径收紧为失败）。
- AC-6 工作分支已被另一活跃 task 的 worktree 占用 → 启动失败 `working-branch-in-use`。
- AC-7 任务详情显示工作分支名 + 基线分支名（多仓显示每仓）。

### 自动 commit & push
- AC-8 开关默认关；关 → 全程无 commit/push，字节级守恒。
- AC-9 开关开 + 一个 writer agent 完成（出 `<workflow-output>`）→ 恰好生成
  一行 commit&push 节点；agent 声明 N 个 output port 也只触发 1 次提交。
- AC-10 反问轮（`<workflow-clarify>` / awaiting_human）**不触发** commit；老化
  后真正出 `<workflow-output>` 那次才触发。
- AC-11 readonly auditor 完成且 worktree 无改动 → 不产生 commit（diff 为空跳过）。
- AC-12 commit message 由内置 commit agent 会话生成；会话被捕获、可在 commit
  行弹窗查看。
- AC-13 push 成功 → commit 节点 done，`commit_push_json` 记录 sha / 目标分支
  / `pushed`。
- AC-14 push 因规范被拒 → 起修复会话，重新 commit+push；成功则节点 done 且
  `repairAttempts ≥ 1`；会话可见。
- AC-15 修复重试达上限仍失败 → 节点 failed，commit 留本地，WARN，后续节点继续。
- AC-16 push 鉴权失败 → 不重试，节点降级（done-with-warning），commit 留本地，继续。
- AC-17 commit 透明性：插入中间 commit 后，任务 diff 视图 / wrapper-git 产出
  与未插入 commit 时**逐字节一致**（`gitDiffSnapshot` 对 working-tree vs
  baseCommit，不受中间 commit 影响）。
- AC-18 commit author/committer = 任务身份（RFC-067），框架直跑 git 也注入。
- AC-19 多仓：一个 agent 改两仓中的一仓 → 只对改动仓生成一行 commit&push。
- AC-20 wrapper（git/loop/fanout）含 writer → wrapper 完成后只提交一次（净改动）。

### i18n
- AC-21 启动表单两个新控件 + 任务详情两个新字段 + commit 行 + 会话弹窗，
  cn/en 文案对称齐全。

## 6. 澄清结论（与用户确认）

1. **无工作分支时 push 目标**：推到隔离分支 `agent-workflow/{taskId}`（**不**
   推 base 分支）。
2. **commit message**：LLM 总结 diff 生成。
3. **push 失败**：权限类只 commit-local + warn + 继续；其它类起新 opencode
   会话修复后重提，计入 commit 节点重试次数；修复会话要给充足上下文；commit
   行要能弹窗看会话（同 agent / 记忆提取会话）。
4. **节点范围**：只对顶层 writer agent；readonly 跳过；wrapper 作为一个单位
   完成后提交一次。
5. **git 归属**：框架执行 git，opencode 只负责 message + 修复。
6. **commit agent**：内置系统 agent，模型走 Settings（默认走便宜模型）。
7. **已存在工作分支**：复用 + merge base；base 拉取失败或冲突 → 启动失败。
8. **多仓**：每个改动的仓一行 commit&push（各自会话），工作分支名作用到每仓。
9. **修复重试次数**：Settings 可配（默认 3）。

## 7. OPEN QUESTIONS（用户已批准「取倾向默认」——2026-05-31）

> 用户对实现的回复为 “ok”，即采纳以下全部倾向默认。逐条结论：
>
> - **OQ1 已定**：commit&push 开关默认**关**、工作分支默认**空**；toggle last
>   value 记 localStorage（`agent-workflow.launcher.autoCommitPush`），分支名
>   不记。
> - **OQ2 已定**：空 diff（writer 完成但无净改动）→ **不生成 commit 行**。
> - **OQ3 已定**：修复以**改写 commit message** 为主；非快进先框架**有界
>   `fetch + merge origin/<branch>` 一次**，冲突则计一次失败。
> - **OQ4 已定**：commit agent 默认模型 = `config.commitPushModel` 未配时**回落
>   opencode 安装默认**（与 `memoryDistillModel` 一致），不硬编码具体模型。
> - **OQ5 已定**：diff 截断阈值 `config.commitPushDiffMaxBytes` 默认 **16384**，
>   首 50% + 尾 50% + `[truncated N bytes]`，始终附 `git diff --stat`。
> - **OQ6 已定**：commit 节点纳入「写串行」，两个 commit 永不交错，在触发它的
>   writer done 之后、下一个 writer 之前执行。

以下为原始 OPEN QUESTION 记录（保留以备追溯）：

- **OQ1（开关默认）**：commit&push 开关默认 **关**、工作分支默认 **空**（保
  证存量字节级守恒）。倾向不提供「全局 settings 默认开」，只在启动表单上记住
  上次选择（localStorage）。是否认可？
- **OQ2（空 diff 行）**：writer agent 完成但 worktree 无净改动时，倾向**完全
  不生成 commit 行**（最干净）；备选是生成一行 `done` 并标注"无改动"以增强可
  观测性。你更想要哪种？倾向"不生成行"。
- **OQ3（修复范围）**：修复会话 v1 聚焦**改写 commit message**（你举的"格式不
  规范"是最常见 server-hook 拒收）；对"非快进（远端在 push 期间前进了）"，倾
  向框架**自动 `git fetch && git merge origin/<branch>` 一次**（无冲突即重推，
  冲突则计一次失败转修复会话或最终失败），而不是让 LLM 跑 rebase。是否认可这
  个"message 修复为主 + 非快进有界自动合并"的分工？
- **OQ4（commit agent 模型默认）**：内置 commit agent 默认模型——倾向新增
  `config.commitPushModel`，未配置时回落 opencode 安装默认；UI 在 Settings 给
  一个输入并建议填便宜模型（如 Haiku）。是否要我直接把默认硬编码成某个具体便
  宜模型，还是保持"未配=opencode 默认"？倾向后者（与 `memoryDistillModel`
  一致）。
- **OQ5（diff 截断阈值）**：喂给 message 会话的 diff 大时截断（首 50% + 尾
  50% + `[truncated N bytes]`，并始终附 `git diff --stat`），阈值新增
  `config.commitPushDiffMaxBytes`（默认 16384，对齐 RFC-044）。是否认可？
- **OQ6（提交粒度 vs 写串行）**：commit 节点纳入框架现有"写操作串行"约束
  （readonly 并行、写串行），即两个 commit 永不交错、且在触发它的 writer 节点
  done 之后、下一个 writer 之前执行。是否认可（这是最安全、零竞态的选择）？
