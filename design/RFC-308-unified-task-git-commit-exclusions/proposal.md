# RFC-308 任务 Git 提交、平台工作目录与自动排除规则归一——产品提案

> 状态：**Done（2026-08-17）**
> 用户原始需求：平台 Git 自动提交需要可配置目录/文件黑名单，效果类似 `.gitignore`，避免平台临时目录被提交上库。
> 用户追加裁决：**先统一任务提交能力，再按推荐方案实现排除规则；架构统一必须考虑 RFC-294；系统现有内置
> Gitignore 全部收编，平台内置目录统一为一套约定工作目录名。**
> 依赖：RFC-020/262（上传落点与冲突语义）、RFC-075（任务工作分支与自动提交推送）、RFC-101（Fusion worktree）、
> RFC-210（递归 submodule 提交推送）、RFC-218（单 Agent 上传）、RFC-248（仓库组与平台 `.gitignore` 预置）、
> RFC-294（后台目标架构）、RFC-304（代码能力平台）。

> **实现收口**：用户随后明确旧名字无人使用、直接删除且不保留兼容读取。实现因此采用 migration/source zero-ratchet
> 硬切，不增加会让旧名字继续存活的 production pre-ready reader。普通 task 与 code-capability 已统一消费
> source-control commit engine；code-capability 只见 task-execution public participant。详细落点与验证见 [plan.md](./plan.md)。

## 0. 摘要裁决

本 RFC 不在两套现有实现上分别补一份 ignore 判断，也不再保留四种平台隐藏目录和两套 runtime ignore 写法。它按两个
强序阶段交付：

1. **先归一工作区与任务提交底座**：把仓内平台文件统一写到 `/.agent-workflow/`，把 RFC-248 修改业务仓
   `.gitignore` 的预置 commit 与 Fusion 写 `.git/info/exclude` 的做法收进唯一 `WorkspaceExcludeManager`；再把普通任务的
   auto commit/push 与代码能力的 diff/freeze/push 收到同一套“任务工作区提交”能力。统一的是 workspace convention、
   hard excludes、候选变更选择、提交身份、提交对象与发布检查，不是把两种业务流程抹平成一个万能函数。
2. **再增加管理员排除规则**：全局配置采用 `.gitignore` 语法，命中路径不进入平台代理的 diff、commit 或 push；
   即使路径已经 tracked/staged，或已经进入尚未推送的本地 commit 历史，也不能被平台代理推上远端。

归一后的职责按 RFC-294 固定为：

- `task-execution`：任务归属、工作区写 fence、何时提交、NodeRun/结果、提交信息生成与任务可见性；
- `source-control`：平台工作目录/工作树 exclude profile、候选路径选择、Git index/commit/ref/push 机制、submodule 与
  outgoing-history 检查；
- `code-capability`：何时需要 suggestion / frozen artifact / CAS push / new branch，及其人工确认、反作弊和工作项状态；
- `platform/config`：只向实际消费者提供 `OperationConfigProjection<TaskCommitSettings>`，不让模块深层读取全量配置。

代码能力只能消费 `task-execution/public/participants` 的窄任务工作区提交合同，不再直接拥有第二套
`git add -A → commit → push` 实现。普通任务与代码能力保留各自已有的发布策略：RFC-075 的提交信息 agent、
非快进合并和修复重试不变；RFC-304 的 frozen artifact、`--force-with-lease` CAS、新分支创建与人工确认不变。

## 1. 背景与现状证据

### 1.1 今天有两套会把任务改动变成远端 commit 的实现

**普通任务路径（RFC-075）**：

- `services/scheduler.ts:2094` 的 `maybeRunCommitPush` 在顶层节点完成后触发；
- `services/commitPushRunner.ts:254` 直接执行 `git add -A`；
- `services/commitPushRunner.ts:338` 生成本地 commit，随后按鉴权/非快进/规范拒收分别处理 push；
- `services/commitPushRunner.ts:558-683` 对 submodule 再走一套 dirty 判定、`add -A`、commit、push。

**代码能力路径（RFC-304）**：

- `modules/code-capability/infrastructure/gitAdapter.ts:101-170` 自己执行 `add -A`、commit、keep-ref；
- 同文件 `:206-220` 用 `add -A --intent-to-add` 让未跟踪文件进入预览 diff；
- 同文件 `:223-269` 自己实现 CAS push 与 new-branch push；
- `mrCommentFixStages.ts`、`ciFixStages.ts`、`requirementStages.ts` 分别消费上述 freeze/push。

两条路径已经发生可观察漂移：普通任务 commit 默认执行本地 hooks，代码能力 freeze 明确
`--no-verify --no-gpg-sign`；前者用 task identity env，后者曾依赖 ambient identity；前者递归 submodule，后者以
detached artifact 为中心。继续分别加排除规则，会立刻产生“任务 A 排除了、代码能力 B 仍提交”“预览排除了、freeze
又带回去”“主仓排除了、submodule 仍推送”三类半接线。

此外还有**内部 Git commit**：RFC-248 在多仓 materialize 时把嵌套 mount 规则写入 `.gitignore` 并生成平台预置 commit，
nodeIsolation/full-state/merge 也会生成只为状态传递服务的 commit。它们不属于用户触发的 task commit orchestrator，不能为
“统一”强塞进去；但只要某笔最终成为待 push tip 的祖先，outgoing-history guard 就必须逐笔检查，不能以“内部 commit”
名义绕过远端防线。

### 1.2 仓库 `.gitignore` 已生效，但不等于平台可配置排除

`git add -A` 本来就遵守业务仓库已有 `.gitignore`，所以本 RFC 不替代它。缺口有三层：

1. 平台没有全局附加规则，管理员只能修改每一个业务仓库；
2. 原生 `.gitignore` 不作用于已经 tracked 的路径，无法兑现“黑名单路径绝不被平台代理提交”；
3. 某路径若已经进入本地未推送 commit，下一次平台 push 会把整段历史一起发布，仅过滤本次 index 已经太晚。

本 RFC 因此使用“`.gitignore` **语法** + 严格平台代理排除**效果**”：语法熟悉，但保证强于原生 `.gitignore`。

### 1.3 平台仓内目录目前有四套名字

| 现有目录                             | 生产写点                              | 用途                     | 问题                                                      |
| ------------------------------------ | ------------------------------------- | ------------------------ | --------------------------------------------------------- |
| `.aw-run/<stage>`                    | `capabilityWiring.ts:444`             | CI Fix 脚本/输入/结果    | 没有统一 ignore，能进入 diff/commit                       |
| `.agent-workflow-inputs/<targetDir>` | `repoGroupLayout.ts:25` + `upload.ts` | 仓库组上传输入           | 另造一个长横线根名，靠 RFC-248 修改 `.gitignore` 才隐藏   |
| `.agent-inputs/<port>`               | `agentLaunchForm.ts:24`               | 单 Agent `path` 端口上传 | 与组上传双重嵌套，默认可进入单仓 commit                   |
| `__fusion__/result.json`             | `fusion.ts:71-72`                     | Fusion manifest 脚手架   | 另写 `.git/info/exclude`，不复用 task/source-control 机制 |

新写入统一为一个 repo-relative、平台保留的工作目录根：

```text
/.agent-workflow/
  inputs/
    agent/<port>/...                 # 单 Agent 上传
    <workflow targetDir>/...         # 仓库组上传；targetDir 仍是作者配置
  runs/
    code-capability/<round>/<stage>/ # CI Fix 等代码能力运行物
  fusion/
    result.json                      # Fusion manifest
```

`PLATFORM_WORKSPACE_DIR='.agent-workflow'` 及子路径由一个 shared/workspace convention 定义；生产代码不得再手写隐藏根名。
`/.agent-workflow/` 是平台 hard deny，用户 `!` 不能重新包含。旧目录在 cutover 后生产读写均为 0；它们只出现在
source-ratchet 的负样本和历史文档，不进入 runtime compatibility branch，也不继续占用用户 namespace。

`.claude/`、`.opencode/` **不**收进该目录：它们可能是业务仓主动版本化的 provider 项目配置/skill。OpenCode 在自身
`OPENCODE_CONFIG_DIR` 写的 `.gitignore` 位于 app-home run 目录、不是任务仓内平台 ignore，登记为 provider-owned external
behavior，不冒充本 RFC 的 source-control 规则。

### 1.4 平台内置 ignore 当前也有两套写法

- RFC-248 为嵌套仓和 `.agent-workflow-inputs` **修改业务仓 `.gitignore` 并生成预置 commit**；
- Fusion 直接写新仓的 `.git/info/exclude`。

两者统一为 `source-control` 的 `WorkspaceExcludeManager`：在平台拥有的 per-worktree Git dir 下写 versioned exclude profile，
并通过 `extensions.worktreeConfig=true` + `git config --worktree core.excludesFile=<profile>` 绑定到该 worktree。Profile 至少含
`/.agent-workflow/` 与该仓的直接子 mount；不修改业务仓 `.gitignore`，也不写 common-dir
`.git/info/exclude`。严格 commit/history guard仍独立执行，不能信任 agent 可改的 Git config 作为最终防线。

这对**新 workspace**明确 supersede RFC-248 D1/D21 的“`.gitignore` 预置 commit”实现选择；RFC-248 的布局、嵌套、占用、
readonly、sparse 与直接子排除语义继续有效。历史 RFC 文档不改写，RFC-308 是后继裁决。

## 2. 目标与非目标

### 2.1 目标

- **G1 单一工作目录约定**：所有新写的仓内平台运行物只落 `/.agent-workflow/{inputs,runs,fusion}/`，隐藏根名只有一个。
- **G2 单一平台 exclude owner**：RFC-248/Fusion 两套写法收进 `WorkspaceExcludeManager`；新任务永不改业务仓 `.gitignore`。
- **G3 单一任务提交机制**：所有平台代理的任务工作区 diff/freeze/commit/push 经过同一个候选选择与发布前检查内核。
- **G4 保留领域差异**：RFC-075 与 RFC-304 的触发、人工确认、push 策略、hook 策略和结果表不被“统一”抹平。
- **G5 全局配置**：管理员可在“设置 → Git”配置一行一条的 `taskCommitExcludePatterns`。
- **G6 Gitignore 语法**：支持 `/` 根锚、`*`、`?`、`[]`、`**`、尾随 `/`、`!` 反选和 `#` 注释。
- **G7 严格排除**：命中路径无论 untracked、tracked、staged、deleted、renamed，均不进入平台代理提交。
- **G8 历史防线**：待推送的本地 commit 历史只要曾引入命中路径，平台代理就拒绝 push，而不是把它悄悄带上远端。
- **G9 全入口覆盖**：普通任务、代码能力、主仓、仓库组可写成员、递归 submodule、CAS push、新分支 push 全部覆盖。
- **G10 内置防线**：`/.agent-workflow/` 永久生效，用户 `!` 不能重新包含 workspace hard rules；旧目录无生产 reader/writer。
- **G11 可观察**：任务提交详情能看到排除数量与有界路径清单；全被排除时明确显示“只有被排除的改动”。
- **G12 不污染业务仓**：不写、暂存、提交业务仓库 `.gitignore`，不写 shared common-dir 的 `.git/info/exclude`。
- **G13 配置一致性**：一次提交/freeze 尝试只读取一个不可变 operation config slice；frozen commit 是后续确认唯一可推对象，
  push 前再按当前策略扫描 outgoing history，不得把未审视路径带回提交。

### 2.2 非目标

- 不拦截 agent/runtime 自己执行的 `git commit` 或 `git push`；本 RFC 只保证**平台代理**的提交与推送。工作树只有
  agent 自己产生的 clean local commit 时，也不新增“自动替它 push”的触发语义；只有后来确实发生平台代理 push，
  才把这些祖先一并纳入 history guard。
- 不删除命中目录；文件留在工作树供运行期继续使用，只是不进入平台代理产物。
- 不把平台工作目录搬出 task/fusion worktree；本 RFC 统一它的 repo-relative namespace 与排除，物理生命周期仍由原 owner 清理。
- 不强制改写用户显式配置的普通 workflow upload `targetDir`；只迁平台合成的 Agent 输入目录与仓库组额外前缀。
- 不把业务仓的 `.claude/`、`.opencode/` 或 provider 自己的 app-home config dir 纳入平台保留目录。
- 不迁移或双读旧平台目录。用户确认旧名字无人使用后，migration 直接删除旧列，production source zero-ratchet 证明旧
  常量/writer/reader/fallback/wire 为 0；不新增 runtime inventory reader，否则它本身就是被禁止的兼容读取面。
- 不回写/删除业务仓历史里的 RFC-248 `.gitignore` 区块或已发布 preset commit；但是新运行时代码不再读取
  `gitignoreCommit`，该字段/列在本 RFC migration 中移除。
- 不让排除规则改变节点间 full-state snapshot、隔离 merge、端口文件传递；内部快照仍以完整恢复为目标，
  真正出远端前由 outgoing-history 防线兜底。
- 不完成 RFC-294 W5 的全部 source-control 迁移、Git SCC 清零或所有 workspace ref 改造；本 RFC 只交付
  “平台工作目录/profile + 任务提交”这一条可独立验收的 vertical slice，并把临时 composition seam 登账。
- 不增加 per-task、per-workflow、per-repository override；首版只有平台全局规则，避免三层优先级与重启继承歧义。
- 不重写已经推到远端的历史，也不自动删除本地含排除路径的 agent commit；发现时 fail closed 并交给人处理。
- 不改变业务仓库自身 `.gitignore` 对 tracked 文件的原生语义。

## 3. 用户故事

- **US-1 平台临时目录**：CI Fix、Agent 上传、仓库组上传与 Fusion manifest 都写进 `/.agent-workflow/` 对应子目录，
  不再出现四种隐藏根名，也不会出现在 MR patch 或自动提交里。
- **US-2 自定义工具缓存**：管理员添加 `/.cache-agent/`、`*.trace` 后，所有新旧任务的下一次平台代理提交都使用它们。
- **US-3 业务仓例外**：管理员写 `generated/` 与 `!generated/schema.ts`，缓存被排除，唯一需要版本化的 schema 仍可提交。
- **US-4 已跟踪临时文件**：仓库曾误把 `.cache-agent/state.json` 纳入版本控制；平台规则命中后，它的修改仍不会进入
  平台 commit，任务详情明确显示它被排除。
- **US-5 本地历史兜底**：agent 自己先 commit 了命中路径，之后平台准备自动 push；平台拒绝该次 push，保留本地历史并
  点名命中路径，避免“本次 index 很干净”掩盖历史泄漏。
- **US-6 submodule**：规则在每个 submodule 根重新解释；父仓若直接排除某个 submodule mount，则整棵子树不做平台代理 push。
- **US-7 代码能力确认**：评论里展示的 frozen patch 与最终 CAS push 使用同一排除策略摘要；策略中途变更时重新生成，
  不让人确认 A、机器推 B。
- **US-8 嵌套仓**：仓库组挂 `vendor/sdk` 时，平台给外层 worktree 安装自己的 exclude profile；业务仓 `.gitignore`
  内容、mtime 与远端历史完全不变，`git status` 仍看不到内层仓。
- **US-9 升级硬切**：用户确认旧名字无人使用后直接 cutover；runtime 无旧目录探测/fallback，只产生
  `/.agent-workflow/`，schema migration 与源码 ratchet 阻止旧面复活。

## 4. 产品行为规格

### 4.1 平台工作目录与内置 exclude

Shared 定义唯一 `PlatformWorkspaceConventionV1`：根为 `.agent-workflow`，closed 子目录为 `inputs/runs/fusion`。所有生成
路径必须通过 helper，禁止生产代码拼字符串；repo-group 新 mount 的首段不得是 canonical root。旧目录名不再保留，用户可作
普通业务目录使用。

`WorkspaceExcludeManager` 给每个 task/fusion Git worktree 安装 per-worktree exclude profile：

- hard profile = canonical root + 当前仓直接子 mount（hard rules 最后）；
- profile 存在 per-worktree Git dir 的 `agent-workflow/excludes/v1`，不在工作树；
- 平台拥有的 mirror/standalone repo 启用 `extensions.worktreeConfig=true`，用 `core.excludesFile` 只绑定当前 worktree；
- 已有 global/system/common `core.excludesFile` 内容有界合入；已有 worktree-scoped 非平台值不覆盖并 fail closed；
- task resume/recovery 幂等 ensure profile；worktree 删除时 Git 自然回收 per-worktree config/profile；
- 严格 commit engine 直接消费同一 typed hard-rule plan，profile 被 agent 修改也不能绕过提交/历史防线。

管理员 configured patterns 不写进 Git profile，只进入平台代理 strict commit policy：否则 untracked path 会在可见性/统计前被
Git status 隐藏，且一次全局保存会修改所有在途 worktree 的 Git 视图。它们仍是“平台 ignore”，只是作用面严格限定为
平台代理 diff/commit/push；业务仓与 agent 自己的 Git 命令不被平台配置偷偷改写。

RFC-248 新任务不再调用 `commitGitignorePreset`，不再写 `.gitignore`，`baseCommit` 保持远端 base；`gitignoreCommit` wire/列与
所有读写一并删除。Fusion 不再写 `.git/info/exclude`，manifest 只认 `.agent-workflow/fusion/result.json`。

目录迁移：

| 旧写点                               | 新写点                                                 |
| ------------------------------------ | ------------------------------------------------------ |
| `.aw-run/<stage>`                    | `.agent-workflow/runs/code-capability/<round>/<stage>` |
| `.agent-inputs/<port>`               | `.agent-workflow/inputs/agent/<port>`                  |
| `.agent-workflow-inputs/<targetDir>` | `.agent-workflow/inputs/<targetDir>`                   |
| `__fusion__/result.json`             | `.agent-workflow/fusion/result.json`                   |

普通 workflow 显式 `targetDir` 在单仓任务保持原路径；group 下若它已以 `.agent-workflow/` 开头也不二次加 prefix。只有平台
合成的 Agent target 与仓库组的非-canonical附加前缀迁移。Packed upload path 必须返回实际新落点，不能继续返回漏掉
prefix 的旧字符串。

### 4.2 配置入口与格式

设置页在 **Git** 分区新增“任务自动提交排除规则”卡片，而不是继续放在“系统 Agent”：统一之后，规则归 Git/source-control
能力，commit-message runtime/lang 才继续留在系统 Agent 卡片。

控件复用 `<Field>` + `<TextArea monospace>`，一行一条。这里不使用 `<ChipsInput>`：逗号和前后空格都是合法文件名/规则
字符，ChipsInput 的逗号提交与 trim 会改变 Gitignore 原文。

配置合同：

- 键名：`taskCommitExcludePatterns: string[]`；缺省等价空数组；
- 最多 256 条，每条 UTF-8 最多 1024 bytes，合计最多 64 KiB；
- 空行忽略；`#` 开头为注释；`U+0000`、内嵌 CR/LF、host 绝对路径和越界 `../` 拒绝保存；
- leading `/` 表示**仓库根**，不是 host 绝对路径；反斜杠按 Gitignore escape 解释，不当 Windows 分隔符；
- 用户规则按顺序执行，后规则可用 `!` 反选；平台内置规则最后作为 hard deny 求并集，不能被反选。

示例：

```gitignore
# runtime scratch
/.cache-agent/
*.trace
generated/
!generated/schema.ts
```

### 4.3 规则作用域

- 每条规则相对**当前 Git repository root**解释；仓库组每个可写成员各自解释；
- submodule 未被父仓 mount 规则整体排除时，在 submodule 根再次解释同一全局规则；
- symlink 只按链接自身 repo-relative path 匹配，不跟随目标；
- 大小写行为读取该仓 Git 的 `core.ignoreCase`，并以真实 Git oracle 测试 Windows/macOS/Linux 差异；
- 业务仓 `.gitignore` 继续先按 Git 原生规则处理；平台规则再对剩余候选执行严格排除。

### 4.4 严格排除语义

统一候选选择器在提交前处理所有 staged change kind：add/modify/delete/rename/copy/type-change/unmerged。rename/copy 的旧路径
或新路径任一命中，就把整项变更排除；不能留下“删除旧文件但不新增新文件”的半个 rename。

命中项：

- 从本次 commit index 中恢复到 HEAD 状态；
- 工作树内容原样保留（删除仍保持 deleted、未跟踪仍保持 untracked）；
- 不进入 commit diff/stat/message prompt；
- 不作为代码能力 suggestion/anti-cheat/frozen artifact 的候选 diff；
- 下一次平台代理提交仍会重新匹配，绝不因上次已经提示过就放行。

### 4.5 outgoing history 防线

在任何平台代理 push 前，统一内核枚举“远端当前可达点 → 待推 commit”区间的**每一笔 commit、每一个 changed path**，
而不是只看净 tree diff。任一 commit 曾引入命中路径，即使后续又删除/还原，也拒绝平台代理 push：远端一旦收到这段历史，
被还原的文件仍可从旧 commit 读取。

处理：

- 普通任务：本地 commit 保留，commit NodeRun 记为 `commit-local-excluded-history`（failed），不 push；
- 代码能力：freeze 可保留供诊断，但 `pushCas` / `pushNewBranch` 返回 `excluded-history`，工作项不宣称已发布；
- submodule：该 submodule 结果失败，父仓 gitlink 继续按 RFC-210 原子性规则 withheld；
- 远端分支不存在时必须提供受信 base SHA，禁止用“没有远端 tip”跳过扫描；requirement new-branch 路径因此新增必填 base。

### 4.6 全入口覆盖矩阵

| 入口                               | 统一后消费                                   | 排除发生点                                       | 保留的领域语义                                        |
| ---------------------------------- | -------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| RFC-075 顶层节点后自动提交         | `task-execution` 内部 task commit use case   | preview/stage + outgoing scan                    | LLM message、auth degrade、non-FF merge、repair retry |
| RFC-210 submodule                  | 同一 source-control commit engine，bottom-up | mount skip + subrepo-root rules + history scan   | child-first、失败 withheld parent                     |
| RFC-304 comment patch              | `TaskWorkspaceCommitParticipant.freeze/push` | filtered diff + freeze + CAS scan                | 人工确认、artifact digest、lease push                 |
| RFC-304 CI Fix                     | 同 participant                               | anti-cheat diff 与 freeze 同 policy digest       | gate/anti-cheat、CAS push                             |
| RFC-304 requirement                | 同 participant                               | filtered freeze + base→new branch scan           | 新 branch + MR create                                 |
| RFC-304 invoke seed                | 同 participant                               | filtered snapshot commit；不直接 push            | keep-ref 生命周期、子序列审查                         |
| RFC-248 新任务 nested mounts       | `WorkspaceExcludeManager`                    | per-worktree profile + strict dynamic hard rules | 不再产生 `.gitignore` 改动/预置 commit                |
| Fusion scaffold                    | 同一 manager + workspace convention          | `.agent-workflow/fusion/` hard rule              | manifest/copy/result 语义不变                         |
| 四旧目录 / RFC-248 preset old code | 用户确认零使用后删除 reader/writer/fallback  | 不进入新 runtime                                 | 无兼容分支；旧名字归还业务使用                        |
| internal full-state/merge commits  | 不切到管理员规则                             | 成为待推祖先时纳入 history scan                  | 节点状态传递保持完整                                  |

### 4.7 配置生效与策略一致性

规则是 `OperationConfigProjection`：保存成功后的**下一次提交尝试**生效，包含已经运行中的任务；一次尝试从开始到结束固定
一个 `{revision, digest, effectivePatterns}` slice，不在中途热读。

代码能力的 preview 与 freeze 由同一个 task-bound participant、同一 operation policy slice 完成；freeze 随即生成 immutable
commit，人工确认只引用该对象。配置随后收紧时，publish 的 outgoing-history guard 会拒绝该对象；不会用新规则重建另一份 patch。

### 4.8 可见性

`CommitPushMeta` 新增可选 `exclusions`：

- `policyDigest`、`excludedPathCount`；
- 最多前 100 个 repo-relative path + `truncated`；
- 每条标 `source: 'platform' | 'configured'`，不回传 absolute path；
- 全部改动均被排除时 outcome 为 `skipped-excluded`，区别于真实无改动 `skipped-empty`；
- outgoing history 被阻断时 outcome 为 `commit-local-excluded-history`。

正常 untracked canonical/mount 文件已被 per-worktree profile 从 Git candidate 隐藏，不会为每次运行制造 commit 行，也不计入
`excludedPathCount`；若它被 `git add -f`/既有 tracked/history 带回平台代理候选，strict guard 才记录并阻断。Configured patterns
不写 profile，所以 only-excluded/mixed 路径仍可完整统计。

任务详情在 commit 行下复用现有状态/列表样式，展示“排除 N 个路径”，可展开样本。代码能力的 stage failure/awaiting 文案用同一
安全摘要，不把全部路径塞进 MR 评论。

## 5. 能力影响清单

本 RFC 先重构后加防线，以下现有行为必须逐项保真或明确改变：

| #    | 行为                                                                            | 裁决                                                                                        |
| ---- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| I-1  | 普通任务默认 `autoCommitPush=false`                                             | **不变**                                                                                    |
| I-2  | 普通任务 commit hooks 默认执行                                                  | **不变**；统一内核保留 `verification:'normal'`                                              |
| I-3  | 代码能力 freeze `--no-verify --no-gpg-sign`                                     | **不变**；保留 `verification:'artifact'`                                                    |
| I-4  | RFC-075 auth fail 本地 commit + warning、任务继续                               | **不变**                                                                                    |
| I-5  | RFC-075 non-FF 有界 merge；规范拒收可生成修复 message/amend                     | **不变**                                                                                    |
| I-6  | RFC-304 只推人确认的 exact frozen commit，分支移动则拒绝                        | **不变**                                                                                    |
| I-7  | RFC-210 submodule bottom-up，任一失败 withheld parent                           | **不变**                                                                                    |
| I-8  | 业务仓 `.gitignore` 只忽略 untracked                                            | **不变**                                                                                    |
| I-9  | 平台配置命中 tracked/staged 路径                                                | **改变**：平台代理永不提交，符合用户明确黑名单目标                                          |
| I-10 | 平台过去会 push 本地 ahead 历史里的任意路径                                     | **收紧**：命中规则即拒绝平台代理 push                                                       |
| I-11 | 只有被排除改动的任务过去会产生普通 commit                                       | **改变**：产生 `skipped-excluded` 可见行，不 commit/push                                    |
| I-12 | 内部 full-state snapshot 携带运行期临时文件                                     | **不变**；只在远端发布边界过滤/阻断                                                         |
| I-13 | RFC-248 新任务修改/提交业务仓 `.gitignore`                                      | **删除写点**：改用 per-worktree platform exclude profile；业务仓规则只读                    |
| I-14 | Settings 保存后在运行中任务何时生效未定义                                       | **明确**：下一次提交尝试，单次尝试内固定                                                    |
| I-15 | 普通任务 stage 后若另一个 writer 自行改 HEAD/index                              | **收紧**：prepared candidate 验 HEAD/index tree；变化即 `candidate-stale`，不提交另一份内容 |
| I-16 | 代码能力/Fusion/上传使用四套隐藏根名                                            | **改变**：新写点统一为 `/.agent-workflow/{runs,fusion,inputs}`                              |
| I-17 | 单 Agent `.agent-inputs` 上传过去可进入平台代理 commit                          | **收缩**：迁入平台 inputs root 后 hard-excluded；输入仍可读但不作为产品代码提交             |
| I-18 | 仓库组 `.agent-workflow-inputs` 靠 `.gitignore` 隐藏，packed path 还漏掉 prefix | **修正**：迁 canonical inputs root，并让端口值指向实际文件；旧错误短路径不再输出            |
| I-19 | Fusion 写 `.git/info/exclude` 隐藏 `__fusion__`                                 | **等价替换**：canonical fusion root + 同一 manager；manifest/result 语义不变                |
| I-20 | RFC-248 远端 working branch 含一笔平台 `.gitignore` commit                      | **改变**：新任务不再产生；远端只收到业务 commit                                             |
| I-21 | repo-group 可把成员 mount 到 `.agent-workflow`                                  | **收缩**：canonical root 成为平台保留 namespace；legacy 名在新定义中重新可用                |
| I-22 | 旧目录/`gitignoreCommit` 生产消费者                                             | **删除**：用户确认零使用后直接硬切；migration/source ratchet 锁定，不保留 reader/fallback   |
| I-23 | 业务 `.gitignore` 用 `!` 重包含平台 root/嵌套 mount                             | **收紧**：Git 原生视图无法兑现平台 ignore 时启动显式失败，不修改业务文件或静默降级          |
| I-24 | 选定 ref 已跟踪 `.agent-workflow/**`                                            | **收紧**：平台 namespace 被业务占用时启动前失败，避免覆盖或静默吞掉业务内容                 |

## 6. 用户裁决记录

- **U1（2026-08-17）**：先统一任务提交能力，再做排除功能。
- **U2（2026-08-17）**：功能按推荐方案：全平台提交入口、严格覆盖 tracked、平台工作目录 hard deny、不改仓库 ignore、结果可见。
- **U3（2026-08-17）**：架构统一必须考虑 RFC-294。
- **U4（2026-08-17）**：系统现有内置 Gitignore 全部收编，内置目录名统一为一套约定工作目录。
- **U5（2026-08-17）**：以后不要修改代码仓 `.gitignore`，直接使用平台 ignore。
- **U6（2026-08-17）**：平台仓内工作目录统一使用 `.agent-workflow`。
- **U7（2026-08-17）**：不保留旧目录兼容读取。
- **U8（2026-08-17）**：旧名字当前无人使用；该删的老代码直接删除，不保留 runtime inventory/兼容 reader。

本 RFC 对 U3 的具体落实是：不新建 `services/taskCommit.ts` 万能 facade；按 `task-execution → source-control` 单向依赖与
`code-capability → task-execution.public` 收口，配置走 typed operation projection，composition-only path seam 明确登记并交
RFC-294 W5 删除。

## 7. 验收标准

- **AC-1a**：用户确认零使用后 migration/source ratchet 硬切；新生产读写点只出现
  `/.agent-workflow/{inputs,runs,fusion}`，`.aw-run`、`.agent-inputs`、`.agent-workflow-inputs`、`__fusion__` 的生产引用=0，
  全部路径从 shared convention 派生。
- **AC-1b**：task/fusion worktree 全部由唯一 `WorkspaceExcludeManager` 安装 per-worktree profile；业务仓 `.gitignore`
  和 common `.git/info/exclude` 的平台写点为 0。
- **AC-1c**：RFC-248 v1 任务无 `gitignoreCommit` wire/列且不产生平台 preset commit，`baseCommit` 保持远端 base；嵌套仓、sparse、
  上传目录仍从外层 `status/add -A/diff` 消失。
- **AC-1d**：Agent/仓库组上传返回的 packed path 与 canonical 实际落点一致；Fusion 新 manifest 可生成/恢复/复制且
  `.agent-workflow` 不进入 skill 内容。
- **AC-1e**：选定 ref 已跟踪 `.agent-workflow/**`，或业务 `.gitignore` 以更高优先级重包含 canonical/mount hard path 时，
  启动在任何平台文件写入前 fail closed；运行期 root/ancestor 被换成 symlink/非目录也在写前拒绝；业务 tree/ignore/config
  不被平台改写。
- **AC-1**：RFC-075 与 RFC-304 的候选 diff/commit 全部调用同一 source-control selection engine；生产源码中不再有第二个
  `git add -A` 任务提交实现。
- **AC-2**：代码能力不再从 `infrastructure/gitAdapter.ts` 直接 commit/push；只消费 task-execution 的窄 participant。
- **AC-3**：普通任务所有现有 happy/failure/retry/submodule 行为 characterization 逐项不变。
- **AC-4**：代码能力 artifact digest、人工确认、CAS/new-branch、keep-ref 回收行为逐项不变。
- **AC-5**：Settings Git 分区可保存/删除/重开 `taskCommitExcludePatterns`，一行一条、双语、校验错误 field-adjacent。
- **AC-6**：`/.agent-workflow/` 在所有 v1 workspace 中从普通任务与代码能力 diff/commit/push 排除；用户
  `!/.agent-workflow/keep` 无法反选 hard rules；旧名字没有平台语义。
- **AC-7**：配置规则支持 root/glob/directory/negation/comment，并与真实 Gitignore oracle 对拍；Windows 分隔符/ignoreCase 覆盖。
- **AC-8**：untracked/tracked/staged/delete/rename/copy/type-change 命中规则均不进入 commit；旧/新路径任一命中的 rename 不留半边。
- **AC-9**：混合改动只提交未命中的文件；被排除文件留在工作树，下一次仍被排除。
- **AC-10**：本次 Git candidate 全被 configured/strict 规则排除时无 commit/push，任务详情显示 `skipped-excluded` 与有界
  路径清单；profile 已隐藏的普通 untracked 平台运行物不制造噪音 commit 行。
- **AC-11**：本地 ahead commit 历史任一 commit 命中规则时，普通/CAS/new-branch/submodule push 全部 fail closed；
  cutover 后不存在需要特殊解释的 `gitignoreCommit` 分支。
- **AC-12**：父仓规则排除 submodule mount 时整棵不推；未整体排除时规则在 submodule 根重新解释。
- **AC-13**：新任务/恢复/重试全链对业务仓 `.gitignore` 只读；内容、mtime、index、history 均不变；common-dir
  `.git/info/exclude` 不受污染，已有非平台 worktree excludes 不被覆盖。
- **AC-14**：同一代码能力 operation 的 preview/freeze 绑定同一不可变 policy slice；freeze 产出 immutable commit，确认后
  只推该 commit。配置随后收紧时 outgoing-history guard 会拒推，绝不把未审视路径补回 artifact。
- **AC-14a**：普通任务 prepare→message 期间普通文件写入留给下一次 commit；HEAD/index 被其他 writer 改动则本次
  `candidate-stale`，不提交错误 candidate。
- **AC-15**：internal snapshot/merge/port artifact 回归全绿，证明排除没有切断节点间状态传递。
- **AC-16**：任务详情仅向已有 task ACL 可见用户展示 repo-relative excluded paths；本 RFC 新增 metadata/log/WS 字段不出现
  host absolute path（RFC-075 既有 `CommitPushMeta.repoPath` 兼容字段不在本 RFC 删除范围）。
- **AC-17**：架构门证明 `code-capability → task-execution/public/participants`、`task-execution → source-control` 单向，
  无新增 route→DB、跨 context internal import、ambient provider 或 `KNOWN_VIOLATIONS`。
- **AC-18**：真实 daemon E2E：普通 auto commit 与 code-capability CI Fix 各生成 canonical work-dir 文件 + 业务文件，远端只出现
  业务文件；仓库组远端历史不含平台代理 `.gitignore` commit。

## 8. 已批准边界

用户已批准并按以下边界完成实现：

1. 首版只有全局规则；
2. 规则对 tracked/staged 和 outgoing local history 是严格防线，强于原生 `.gitignore`；
3. `/.agent-workflow/` 为唯一工作目录根且不可取消；旧目录不迁移、不双读、不探测；
4. RFC-248/Fusion 的内置 ignore 写点退役，平台以后不修改业务仓 `.gitignore`；
5. 单 Agent 上传不再进入平台代理 commit，repo-group 平台根名成为保留 mount namespace；
6. 业务 tree 已跟踪 canonical root，或 `.gitignore` 以更高 Git 优先级重新包含平台 hard path，任务启动 fail closed，
   不回写业务文件；
7. 配置入口放在 Settings → Git；
8. RFC-294 W4/W5 尚未交付前，允许两条有账、composition-only seam（workspace absolute-path binder + Fusion profile
   adapter），application/public 合同不暴露路径，删除条件明确。

实现、迁移、配置面与验证账见 `plan.md`；本 RFC 已关闭。
