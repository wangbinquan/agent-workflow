# Agent Workflow 平台 —— 补充提案

> 本文是对 `../proposal/init.md` 的细化定稿，与作者经过多轮澄清后产出。
> 与 [`design.md`](./design.md)（技术设计）配套阅读。

---

## 1、解决的问题

随着在 opencode 单 session 内挂载的 subagent 数量增加（worker、auditor、fixer 等），父 session 需要在所有 subagent 间反复中转消息，导致父 session 的上下文不可控地膨胀，模型精度下降。

观察：subagent 之间的信息流是确定性的（worker → 产物 → auditor → 审计结果 → fixer → 修复 ……）。这种确定性流程不应该交给一个 LLM session 去做调度，而应交给一个**外部确定性引擎**：

- 把每个 agent 的执行下放到一个**独立的 opencode 子进程**（每个进程上下文都很干净）
- 把进程之间的信息传递（diff、审计结果、修复结果）交给**框架级别的工程编排**
- 在前端给开发者一个 **Dify 风格的可视化编辑器**，把"编码 → 审计 → 修复"这种工作流变成可拖拽、可复用、可观察的图

平台目标用户：希望用多 agent 并行/串行流水线开发的程序员，单机本地工具，不做团队协作。

---

## 2、产品形态决策摘要

| 项 | 决策 |
| --- | --- |
| 项目独立性 | **完全独立的新项目**，不依赖 multica 代码；仅在调研阶段借鉴 multica 的 daemon/agent/skill 实现思路 |
| 项目结构 | **Bun workspaces monorepo**，`packages/{frontend, backend, shared}` |
| 部署形态 | **本地 Web 应用**：单 daemon + 浏览器 UI（不做 Electron / 桌面壳） |
| 支持平台 | **macOS + Linux**（Windows v1 不支持） |
| 后端技术栈 | **Bun + TypeScript + Hono + Drizzle ORM + bun:sqlite + Bun 内置 WebSocket**；ID 生成用 **ULID** |
| 前端技术栈 | **Vite + React 19 + TanStack Router + TanStack Query + xyflow v12 + shadcn (Base UI 变体) + i18next** |
| 持久化 | **SQLite**（WAL + `synchronous=NORMAL` + `busy_timeout=5000`），单文件 `~/.agent-workflow/db.sqlite` |
| 真值源（数据） | **agent / workflow 为 DB**；**skill 整个目录在 fs**（DB 仅存索引）；workflow 可 YAML 导出（fs 非真值源） |
| 默认语言 / 主题 | 默认 **简体中文** + 跟随系统主题（light/dark），settings 可切 |
| 分发 | `bun build` 出**单二进制**（嵌入前端静态资源），GitHub Releases 双平台二进制 |
| Workflow 复用 | v1 仅支持 **YAML 导入导出**；不做 sub-workflow |
| 多 Runtime | v1 仅支持本地 opencode（PATH + settings 覆写绝对路径）；预留 claude-code 接口但不实现 |

---

## 3、核心概念

### 3.1 Agent

一段可被工作流调用的执行能力，对应一个 opencode agent。本平台不做"agent 类型分类"（不区分 primary/subagent），所有 agent 都被框架以非交互模式（`opencode run`）拉起。

Agent 的存储：**DB 为真值源**。frontmatter 各字段拆为 DB 列（含 `name / description / outputs / readonly / model / variant / temperature / permission / steps / max_steps / skills` 等），正文 markdown 也存 DB 列。文件系统不持久化 agent.md（仅在每次执行时由框架以 inline JSON 形式注入到子进程）。

Agent 的 prompt 正文 **允许为空**（此时 system prompt = 空字符串，agent 完全靠节点 prompt + opencode 内置行为驱动）。

frontmatter 完整字段见 [§ 8](#8agentmd-frontmatter-规范)。

Agent 删除采用 **hard delete**；被任何 workflow 引用时**拒绝删除**（UI 列出引用方）。重命名同理（被引用时拒绝）。已运行的 task 持有 workflow snapshot，不受影响。

### 3.2 Skill

一个 SKILL.md 加上若干支撑文件（templates、scripts），按 opencode 原生格式组织。Skill 由 agent 在 frontmatter 中以名字声明依赖。

**真值源是文件系统**（与 agent 不同）：整个 skill 目录在 fs，DB 仅存索引（`name / description / source_kind / managed_path / external_path`）。这样保留了 opencode 原生格式，支撑文件大小不受 DB BLOB 限制。

UI 编辑界面提供文件树 + Markdown 编辑器（含 GFM 实时 Preview tab）。SKILL.md 的 frontmatter **平台仅校验 `name` 与 `description` 必填**，其他字段（如 `version`、自定义元信息）合荷透传给 opencode。

Skill 的来源（`source_kind`）：

- **`managed`**：平台维护，存于 `~/.agent-workflow/skills/{name}/files/`（含 SKILL.md 与所有支撑文件）。UI 可全功能编辑。
- **`external`**：用户在设置里登记的外部目录（如 `~/.opencode/skills/foo`、`/abs/path/to/skill`）。平台仅记录路径，不修改原文件。
- **`project`**（隐式）：仓内 `.opencode/skills/{name}/` 由 opencode 子进程自然发现，平台不维护索引也不显示在 UI 列表里 —— agent 仍可在 `skills:` 字段引用。

注入机制：启动子进程时，`managed` skill 拷贝到 `OPENCODE_CONFIG_DIR/skills/{name}/`；`external` skill 用 symlink；`project` skill 不动（opencode 自发现）。

Skill 删除采用 **hard delete**；被任何 agent 引用时**拒绝删除**。

### 3.3 Runtime

代表一个本地 opencode 可执行文件。v1 只有一个默认 runtime：

- 默认 `PATH` 寻找 `opencode`，settings 可覆写绝对路径
- Daemon 启动时执行 `opencode --version`，与文档约定的最低版本做 semver 对比，低于最低版本则启动失败并引导用户升级
- spawn 子进程时**全量继承** daemon 的 `process.env`（PATH / HOME / TZ / LLM provider key 等都自然透传）

`provider/model` 列表的来源：daemon 启动时调用一次 `opencode models` 拿实时列表（反映用户的 `~/.opencode/auth`）；UI 下拉从此表取，**也允许手输**不在列表里的 model。Settings 里有"刷新模型列表"按钮。

Runtime 概念是为了未来扩展到 claude-code 等其他 CLI 而预留的抽象层。

### 3.4 仓 / Worktree / Task

- **仓（Repo）**：用户本机的一个 git 工作区路径。**仓路径不在平台全局登记**，而是作为每次启动 task 时的一个隐式必备输入项填写（启动表单提供"最近用过"下拉，SQLite 表 `recent_repos` 缓存最近使用列表）。
- **Base 分支**：task 启动表单上一个隐式必备字段，决定 worktree 从哪里 checkout。默认仓当前 HEAD 所在分支；下拉可改其他 ref。
- **Worktree**：每次启动 task，框架自动 `git worktree add ~/.agent-workflow/worktrees/{repo-slug}/{task-id}`，新分支 `agent-workflow/{task-id}`。所有节点都在该 worktree 内执行。
- **未提交变更不带入**：仓主分支上若有未提交修改，启动时**仅提示用户**（"未提交变更不会进入 worktree，如需包含请先 commit/stash"），不阻止启动。
- **同仓多 task**：允许（各 task 独立 worktree）。启动表单顶部信息条列出"该仓上当前正在跑 N 个 task"，提示但不阻止。
- **Worktree 生命周期**：task 完成后默认保留，UI 提供一键删除；可选 GC（默认关闭，`worktreeAutoGc.olderThanDays` / `onlyMerged`）。
- **Task**：一次 workflow 执行的实例。绑定到一个具体的 worktree 和一组用户填写的输入值。Task 持有 workflow definition 的 snapshot（启动时刻拷贝），workflow 后续改动不影响已启动 task。

### 3.5 Workflow / Node / Edge / Port / Wrapper

- **Workflow**：一张有向图。可以含环（用于反馈循环）。在编辑器中以画布呈现。
- **Node**：图上的一个执行单元，引用一个 agent。本身可以承载额外配置（per-node prompt 模板、执行模式 single/multi-process、重试次数等）。
- **Port**：节点的命名输入/输出端点。输出端口列表由 agent.md 的 `outputs` 字段声明；输入端口默认与同名输出对应（按章节拼接到 prompt）。
- **Edge**：连接 `上游节点.输出端口` 与 `下游节点.输入端口`。
- **Wrapper**：可视容器，把若干节点框在一起。本身**作为节点边界**——wrapper 暴露自己的输入/输出端口，外部连线只能连到 wrapper 边界端口。Wrapper 可任意嵌套。Wrapper 类型见 [§ 5](#5wrapper-类型)。

---

## 4、Workflow 节点模型

### 4.1 节点类型

| 节点类型 | 说明 |
| --- | --- |
| **Agent 单进程节点** | 引用一个 agent，启动 1 个 opencode 子进程 |
| **Agent 多进程节点** | 引用一个 agent + 一个分片策略，根据上游某 port 的内容（通常是 git diff）切分后并发起 N 个子进程 |
| **Workflow 输入节点** | 工作流的入口节点，把用户启动时填写的表单值作为下游输入 |
| **Workflow 输出节点** | 工作流的出口节点，**仅作汇总展示**，不触发执行 |
| **Wrapper 节点** | git wrapper / loop wrapper（详见 § 5） |

> 备注：节点视觉上会区分单进程/多进程（多进程显示 fan-out 角标 + 当前并发数）。

### 4.2 端口模型

#### 输出端口

由 agent.md 的 `outputs` 列出。Agent 必须在 stdout 末尾输出一段如下的信封 XML：

```xml
<workflow-output>
  <port name="audit_findings">
    file: auth.go
    line 42: SQL injection
    ...
  </port>
  <port name="summary">Found 2 high, 1 low severity issues.</port>
</workflow-output>
```

框架根据 `<port name="...">` 把内容拆给下游。详细解析规则见 [§ 7](#7输出-xml-信封规范)。

> v1 不做"内置端口自动注入"。git_diff 是通过 git wrapper 暴露在 wrapper 边界端口上，而不是注入到内部 agent 的输出里。

#### 输入端口与扇入合并

- 一个输入端口允许接多条上游边。
- **同 port 多上游 = 顺序拼接为同一章节**：内容依次拼接，中间用分隔符 `\n\n---\n\n` 区分来源；用户在 prompt 模板里通过 `{{port_name}}` 引用时拿到的是拼接好的整段文本。

> 这是 v1 唯一的扇入语义。如果用户希望按数组结构传入，需要在上游节点改变 port 设计，或在节点 prompt 模板里手动写格式。

### 4.3 节点 prompt 模板

每个 agent 节点都有一个**节点级 prompt 文本框**，可空。语义：

- agent.md 正文 → opencode session 的 **system prompt**（一次执行内不变）
  - **agent.md 不做模板替换**：正文中的 `{{x}}` 等字符按字面透传给 opencode，避免双重代入
- 节点 prompt 文本框 → opencode session 的 **user prompt 前导文本**
- 节点 prompt 文本框支持模板替换：
  - `{{port_name}}` —— 上游同名输入端口的内容
  - 内置变量：`{{__repo_path__}}` / `{{__base_branch__}}` / `{{__task_id__}}`
- **未被模板引用的输入端口** 仍按章节拼接追加到 user prompt 后面（章节标题 = port 名，分隔符 `\n\n## {port}\n`）
- 模板里 `{{x}}` 引用了 **不存在的** port（拼写错 / 上游被删）：**静态校验阶段就报错**，task 不能启动

节点抽屉提供 **Edit / Preview** 双 tab：Preview 给每个上游 port 一个 mock 输入框，实时拼出最终 user prompt（含框架追加的协议块），方便调试。

最终 user prompt 结构（伪代码）：

```
{节点 prompt 文本框（其中 {{port_name}} / {{__var__}} 已替换）}

## {未被引用的 port_a}
{port_a 的内容}

## {未被引用的 port_b}
{port_b 的内容}

---
{框架自动追加的英文协议块，指挥 agent 输出 <workflow-output>}
```

模板语法仅支持 `{{name}}` 替换（无表达式、无函数调用），保持简单。

### 4.4 节点级别覆写（per-node overrides）

节点除了引用 agent 名，还可覆写：

- `model` / `variant` / `temperature`（覆盖 agent.md 默认）
- `retries`（默认 0）
- `timeout`（默认 30 分钟，沿用 settings 全局值）
- `dangerously_skip_permissions`（默认全局开启）

**`readonly` 不可被节点覆写**，始终从 agent.md 继承（避免节点谎报导致并发写入冲突）。

节点上还可选 **single-process / multi-process 模式**（创建后可切换；切到 multi 需补填 `sourcePort` 与分片策略）。

### 4.5 多进程节点

- 必填字段：
  - `sourcePort`：上游某节点的某 port，作为分片源（典型场景是 git_wrapper 的 `git_diff`）
  - 分片策略（v1 内置三种）：
    - `per-file`：每个变更文件 1 个子进程
    - `per-n-files`：每 N 个文件 1 个子进程，N 可调
    - `per-directory`：同一 top-level 目录的变更走 1 个子进程
- **非分片输入端口**：节点的其他输入端口对每个子进程**完整复制**（如 `requirement`、`audit_checklist` 在每个 shard 里都看到完整内容）
- **fan-in 时机**：等所有子进程结束（含部分失败容忍）
- 父节点自动追加 **`errors` port**（agent.outputs 不需声明）：聚合失败 shard 列表 + 各自错误信息。下游可选连这个端口
- 单进程节点没有自动 `errors` port

> ⚠️ **实现状态：deferred，v1 未实现**（`design/design.md` §6.3 WP-6b 产品决策）。
> 实际语义是 **fail-all-after-join**：任意一个 shard 失败即整个 wrapper `failed`，**不做部分聚合、不产出 `errors` port**，
> 成功 shard 的输出对下游不可见。由 `packages/backend/tests/scheduler-audit-s18-s19-fanout-failure-semantics.test.ts` 锁定。
> 本文后续所有关于「部分容忍」「自动 errors port」的描述（含 §失败与重试表、§v1 范围清单）在落地前**均属产品意图而非现状**。

- **聚合**：每个子进程按命名端口产出 XML 信封；同名端口跨子进程**按 `shard_key` 字典序拼接**为下游单一输入

#### 分片边界细节

- **重命名**（git status R）作为 1 个 shard，不拆 delete + add
- **二进制文件** 跳过分片（diff 不可读），仅作为"包含二进制文件 N 个"提示跟随其他 shard 输出
- **空 diff**（sourcePort 内容为空 / 无变更文件）：节点不起子进程，直接 `done`，所有命名输出 port = 空字符串，下游正常联动
- 子进程的并发上限**独立于** `max_concurrent_nodes`：fan-out 不会挤占其他节点的全局并发名额（避免单个 multi-process 节点把全局耗尽）

> v1 不做 per-hunk 分片（hunk 粒度对审计/修复上下文常常不够）。也不做用户自定义分片表达式（推迟到 v1.5+）。

### 4.6 Workflow 输入节点（启动表单）

每个 workflow 编辑时声明若干输入节点，启动时变成"启动表单"。输入节点的支持的控件类型（v1）：

| 控件 | 字段配置 | 传给下游的内容 |
| --- | --- | --- |
| **文本**（单行 / 多行 Markdown） | `key / label / placeholder / default / required / multiline / maxLength?` | 字符串原文 |
| **文件 / 多文件路径选择器** | `key / label / required / minCount? / maxCount? / pickerKind: 'file' \| 'dir' \| 'both'` | **相对仓根的路径**列表，换行分隔。选了目录则展开为该目录下所有变更过的相对路径 |
| **枚举 / 下拉** | `key / label / required / multi: bool / allowOther: bool / options: [{value, label}]` | 单选时 = 选中 value；多选时 = 逗号分隔；`allowOther` 时用户可手输不在列表的值 |
| **git 对象** | `key / label / required / objectType: 'branch' \| 'commit-range' \| 'pr'` | branch：分支名（启动表单从仓 ref 列表实时下拉）；commit-range：`A..B` 字符串；pr：PR 号（**前提 settings 配过 GitHub token**，否则 UI 隐藏 PR 选项） |

**隐式必备字段**（不显示在编辑器，但启动表单一定有）：

- 仓选择器：从 `recent_repos` 表下拉 + 自由填路径
- Base 分支选择器：默认仓当前 HEAD 分支，下拉可改
- "从以往 task 填充"下拉：列出同 workflow 最近 5 个 task，选中后拷贝其 inputs 为初值

启动前的**实时校验**：

- required 字段未填 / 文件个数不在 `[minCount, maxCount]` / git ref 不存在 → 表单报错
- 当前仓上有正在跑的 task：顶部信息条提示（不阻止）
- 仓主有未提交变更：提示但不阻止

文本控件支持 `placeholder`、`default`，多行 Markdown 编辑器在编辑界面就预览。

### 4.7 Workflow 输出节点（产出汇总）

- 工作流跑完后，**两种产出形式同时提供**：
  - 默认：在 task 详情页展示 worktree 的 `git diff`（最自然的产出）
  - 可选：如果 workflow 含输出节点，则**重点展示**输出节点收集的若干 port（卡片形式置顶），diff 仍作为附加可见
- 输出节点不触发执行，不计入"全部变绿"判定
- 编辑器中输出节点仍画在画布上（可点击查看绑定），状态色与普通节点一致但永远 `done`
- 节点配置：声明若干"展示用 port"，每个 port 绑定到 `(nodeId, portName)` —— 静态校验时检查目标节点 / port 必须存在

---

## 5、Wrapper 类型

### 5.1 通用规则

- Wrapper 是节点边界：外部连线只能连到 wrapper 暴露的边界端口
- Wrapper 可任意嵌套：`loop` 内可包 `git`，`git` 内可包 `loop`，`loop` 内可包 `loop`
- Wrapper 颜色与状态：与普通节点一致（pending/running/done/loop-running-blue/failed/interrupted/canceled/exhausted）
- 编辑器中通过 **多选节点 + 右键"组合为 wrapper" + 选 git/loop** 创建；也支持先建空 wrapper 再拖节点进去

### 5.2 Git wrapper

- **没有输入端口**（其作用是拍快照而非接收数据）
- **唯一输出端口**：`git_diff`，内容是 wrapper 进入前与离开后的 `git diff`（含未提交的工作区变更 + untracked 文件转 +file 形式）
- 实现：进入第一个内层节点前框架记录 commit-id-pre + 工作区状态；最后一个内层节点 done 后记录 commit-id-post + 工作区状态；输出 = post − pre 的合并 diff
- wrapper 内必须 ≥ 1 个内层节点（保存校验）

### 5.3 Loop wrapper（反馈循环）

提案中"循环节点"的真正实现。Loop wrapper 包裹一个子图（如 audit + fix 两节点），让它反复执行直到退出条件满足。

**配置项**（在 wrapper 上填写）：

- `max_iterations` *必填*：循环上限（防止死循环；UI 默认值 3）
- `exit_condition` *必填*：从 v1 内置选项中选：
  - `port_empty(nodeId, portName)`：内层某节点的某端口内容 trim 后为空
  - `port_equals(nodeId, portName, value)`：某端口完全等于给定字符串
  - `port_count_lt(nodeId, portName, n, separator?)`：按 separator（默认 `\n`）切分后条数 < n（用于"审计 finding 少于 N 条则退出"）
- 退出条件 evaluate 时机：每一轮内层 DAG 全部 done 后立即评估

**Loop body 每轮独立**（v1 不支持跨轮反馈）：

- 一次迭代 = wrapper 内 DAG 跑一遍，每个内层节点的 `node_run.iteration = N`
- **跨轮状态仅靠 worktree 文件**（fix 把改动写到磁盘 → 下一轮 audit 看新内容；这是天然的、不需要框架的反馈通道）
- 框架不提供"上一轮 port → 这一轮 port"的隐式数据通道。如果用户希望 audit→fix 在同一轮里联动，画普通边即可（边在 wrapper 内部）

**边界端口模型**：

- Wrapper 输入端口在**首轮迭代**前收一次值，每轮迭代都能读到（不变）
- Wrapper 输出端口在 **退出条件满足那一轮**结束时，把内层指定节点的对应 port 透传出去
- 输出端口在 wrapper 配置里显式绑定到 `(nodeId, portName)`

**视觉颜色**：

- 当前迭代正在跑的内层节点：黄色
- 当前迭代已结束、未来还可能再跑的内层节点：**蓝色**
- 退出条件满足或 max_iter 到达后，内层节点最终状态：绿色（成功轮）
- wrapper 自身：所有迭代跑完且退出条件满足 → done（绿）；max 但未满足 → **`exhausted`** 状态（独立子状态，红边 + "exhausted" 文字），下游不触发，task = failed

### 5.4 嵌套行为

| 组合 | 行为 |
| --- | --- |
| **git wrapper 嵌套在 loop wrapper 内** | 每轮迭代独立拍快照；wrapper 输出 `git_diff` 是**末轮**（退出条件满足那一轮）的 diff |
| **loop wrapper 嵌套在 git wrapper 内** | git wrapper 包裹整个 loop（含所有迭代），输出 = 全部迭代结束后相对于 wrapper 入口的总 diff |
| **loop in loop** | 内外两层各自计 `iteration`；内层每一轮跑完才进入外层下一轮的求值 |
| **wrapper 链式叠加** | 边界端口逐层透传，`{outerWrapper.outputPort}` 是 `{innerWrapper.outputPort}` 的转发 |

---

## 6、执行模型

### 6.1 进程隔离（解决原提案的开放问题）

**核心理念：仓内 `.opencode/skills/`（业务 skill）、`~/.opencode/`（含 auth）、`~/.claude/skills`、`~/.agents/skills` 都正常加载 —— agent 在执行时可以使用仓内既有 skill。平台只用最小集的环境变量做隔离：**

| Env | 值 | 作用 |
| --- | --- | --- |
| `OPENCODE_CONFIG_DIR` | `~/.agent-workflow/runs/{taskId}/{nodeRunId}/.opencode/` | 仅放入由平台管理（`~/.agent-workflow/skills/` 来源）且本次 agent 声明引用的 skill。每进程独立路径，自然避免文件冲突 |
| `OPENCODE_CONFIG_CONTENT` | `{"agent": {"<name>": {...}}}` | 把本次执行的 agent 定义（agent.md frontmatter 全字段 + 正文 prompt 转 JSON）以 inline 方式注入。该字段在所有目录扫描完成后**最后**被 opencode merge，平台定义恒胜过仓内 / `$HOME` 的同名 agent |

**关键说明 —— 不设置任何 `OPENCODE_DISABLE_*` flag**：

- 仓内 `.opencode/skills/` 的业务 skill 对 agent 可见（核心需求）
- 仓内 `.opencode/agent/*.md` 也照常被加载，但 inline JSON 优先级最高，平台 agent 不会被仓内同名 agent 偷换
- 全局 `~/.opencode/` 继续加载，auth 凭据保留可用
- `~/.claude/skills`、`~/.agents/skills` 等外部 skill 路径继续工作

cwd 仍指向 task 的 worktree，git diff、文件读写自然工作。

#### 6.1.1 agent merge 优先级（从低到高）

1. `Global.Path.config`（= `OPENCODE_CONFIG_DIR`）下的 `agent/*.md`、`opencode.json` agent 字段
2. 仓内 `.opencode/agent/*.md` 的同名定义
3. `~/.opencode/agent/*.md` 的同名定义
4. **`OPENCODE_CONFIG_CONTENT` 的 `agent.{name}`**（平台注入，恒胜）

#### 6.1.2 skill 加载策略

opencode 的 skill 发现是基于绝对路径的集合：每个被发现的 `SKILL.md` 都加入候选集，最终按 skill 名建索引。如果同名 skill 在多处出现，opencode 加载顺序不固定。

为简化 v1，约定如下（只做文档约定，不做强制校验）：

- **平台管理的 skill** 命名应避免与仓内 / 全局已有 skill 重名
- 在 agent.md 的 `skills:` 列表里：写仓内 / 全局 skill 名 → opencode 自然从仓内 / 全局发现；写平台 skill 名 → 平台从 `~/.agent-workflow/skills/` 拷贝 / 链接到 `OPENCODE_CONFIG_DIR/skills/{name}/`
- **同一份 agent.md 可以同时引用平台 skill 和仓内 skill**

#### 6.1.3 清理

执行结束后，整个 `~/.agent-workflow/runs/{taskId}/{nodeRunId}/` 目录立即清理。

### 6.2 Worktree per task（解决跨 task 仓冲突）

- 启动 task 时框架自动 `git worktree add ~/.agent-workflow/worktrees/{repo-slug}/{taskId}` —— 路径名以 task id 为后缀，分支名 `agent-workflow/{taskId}`
- 该 task 的所有 opencode 子进程的 cwd 都是该 worktree
- task 完成后**保留 worktree**，UI 提供一键删除；可选后台 GC（默认关闭）按"已合并主分支" 或 "超过 N 天" 自动清理
- 同一个仓允许同时跑多个 task —— 因为它们各自有独立 worktree

### 6.3 Task 内部节点并发

- agent.md 的 `readonly: true` 标记声明该 agent 不会写文件（如 audit、analyze）
- 调度规则：
  - **只读节点**之间可并发执行（worktree 文件不变）
  - **写入节点**（`readonly: false` 或缺省）强制**全局串行**——同一 task 内任一时刻最多 1 个写入节点在跑
  - 全局并发上限 `max_concurrent_nodes`（默认 4，settings 可调）
  - 多进程节点的子进程**独立于全局并发上限**，避免单个 fan-out 把全局名额吃尽

### 6.4 失败 / 重试 / 权限策略

| 场景 | v1 默认行为 |
| --- | --- |
| opencode 子进程非零退出 | 节点状态 `failed`，下游不触发，task 标 failed |
| opencode stdout 没有合法 `<workflow-output>` 收尾 | 视同失败 |
| 节点 timeout | 杀子进程，节点 `failed` |
| 节点上配置 `retries=N` | 失败后**立即重试**，prompt 与上一次完全一致；每次重试创建独立 node_run（以 `retry_index` 区分；UI 在 Stats tab 列出所有 retry history） |
| 多进程节点的部分子进程失败 | **【deferred，v1 未实现】**意图：节点不算 failed，成功部分按字典序聚合到对应 port；失败信息聚合到自动追加的 `errors` port。**现状**：fail-all-after-join，wrapper 直接 `failed`，无聚合、无 errors port |
| opencode stderr | 也持久化到 `node_run_events`（`kind=stderr`），节点详情 Events tab 与 Raw stdout tab 都可看 |
| opencode 询问权限 | 默认带 `--dangerously-skip-permissions`，自动放行 |
| 节点级开关 `dangerouslySkipPermissions=false` | 该节点取消 flag，permission 询问由 opencode 默认行为 reject |
| task 启动失败（worktree 创建失败 / agent 不存在 / opencode 未安装等） | **仍然创建 task 记录**，状态 `failed`，error_message 填具体原因，UI 可见 |

### 6.5 Task 生命周期与状态词汇

#### 状态值

| 状态 | task | node_run | 含义 |
| --- | --- | --- | --- |
| `pending` | ✓ | ✓ | 已创建，等待调度 |
| `running` | ✓ | ✓ | 正在执行 |
| `done` | ✓ | ✓ | 成功完成 |
| `failed` | ✓ | ✓ | 业务/运行错误（exit code、解析失败、timeout 等） |
| `canceled` | ✓ | ✓ | 用户主动 cancel |
| `interrupted` | ✓ | ✓ | daemon 重启 / 崩溃导致的中断（区别于用户 cancel） |
| `exhausted` | — | ✓ | loop wrapper 达到 max_iterations 仍未满足退出条件 |
| `skipped` | — | ✓ | resume 时已经 done 的节点不重跑 |

UI 颜色：done=绿，running=黄，pending=灰，loop body 蓝（已跑可能再跑），失败族（failed/canceled/interrupted/exhausted）红边 + 文字区分。

#### 操作

- **Cancel**：杀所有运行中 opencode 子进程；running 节点 → `canceled`；**worktree 保留**（不重置）
- **Resume from failed/interrupted**：保留所有 done 节点的输出，从失败节点开始重新调度。重跑前**自动 git reset 到该节点 start 前的快照**（每个写入节点 start 前框架拍一次 `git stash create` snapshot）
- **Retry whole task**：以同一输入新建一个 task（新 worktree、新 task_id），原 task 不动
- **Retry single node**：节点详情弹窗"重跑该节点"
  - 重跑前同样回滚到该节点 start 前快照
  - **默认级联下游**（重跑该节点 + 它原本触发过的所有下游）；弹窗有"仅重跑该节点"toggle
- **彻底删除 task**：task 详情页"彻底删除"按钮，hard delete + 联动删 worktree、events、outputs

#### Daemon 重启对在跑 task 的影响

- daemon 启动时扫描所有 `status='running'` 的 task / node_run
- 检查每个 node_run 的 PID：若进程仍存活 → SIGKILL（这些是孤儿）
- 全部标为 `interrupted`
- 用户可手动 resume 这些 task

#### Daemon 优雅退出

- 收到 SIGTERM / SIGINT → 先停收新 API 请求
- 给所有正在跑的 opencode 子进程 30 秒 SIGTERM 收尾窗口
- 超时仍未退出 → SIGKILL
- 结构化落盘所有 events / outputs / status，再退 daemon

### 6.6 资源限额

- **per-task 最大耗时**：超过自动 cancel 整个 task。Settings 默认 / workflow 可覆写 / 启动表单可覆写
- **per-task 最大 token 上限**：累计所有 node_run 的 input+output token，超过自动 cancel。token 数从 opencode JSON events 提取
- **per-node 最大耗时**：默认 30 分钟，settings 可调，节点上可覆写

三者命中任一即触发 cancel；触发原因写到 task.error_message。

---

## 7、输出 XML 信封规范

### 7.1 信封格式

```xml
<workflow-output>
  <port name="<port_name>">
    任意文本内容（保留 CDATA / 转义）
  </port>
  ...
</workflow-output>
```

- agent stdout 中**最后一段**完整匹配的 `<workflow-output>...</workflow-output>` 被作为有效输出（前面的部分被忽略，允许 agent 在思考过程中输出过多次草稿）
- `<port name="...">` 的 `name` 必须是 agent.md `outputs` 列表里声明过的名字
- 解析失败的判定：
  - 找不到 `<workflow-output>` 闭合 → 节点失败
  - 出现未声明的 port name → 警告但不失败（保留内容到 `node_run_outputs`）
  - 缺失声明过的 port → 警告但不失败（下游对应 port 视为空字符串）

### 7.2 在 prompt 中告知 agent 应输出的格式

平台在每次启动 opencode 子进程时，**在 user prompt 末尾追加固定的协议块**（用户看不到，agent 看得到）。**协议块固定使用英文**（LLM 在英文控制语上服从性更高，且不干扰业务 prompt 的中文上下文）：

```
---
You MUST end your reply with a `<workflow-output>` block containing the
following ports:
- audit_findings
- summary

Format:
<workflow-output>
  <port name="port_name">content</port>
</workflow-output>
```

> 这段是框架自动注入的，agent.md 编写者无需自己在 system prompt 里写。

---

## 8、agent.md frontmatter 规范

### 8.1 必填字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | agent 唯一名（用于工作流引用） |
| `description` | string | 一句话说明用途 |
| `outputs` | string[] | 输出端口名列表，决定信封 XML 的可声明 port |
| `readonly` | boolean | 该 agent 是否不写仓内文件（决定能否并发） |

### 8.2 可选字段（大部分透传给 opencode）

| 字段 | 类型 | 备注 |
| --- | --- | --- |
| `model` | `provider/model` 字符串 | 不填用 settings 全局默认 |
| `variant` | string | 模型变体（reasoning effort 等） |
| `temperature` | float | |
| `permission` | object | opencode 原生 permission schema：`{ edit / bash / read / write / question / plan_enter / plan_exit: 'allow'\|'ask'\|'deny' }`。UI 表单提供常用项 + 高级 raw JSON |
| `steps` / `max_steps` | int | opencode 原生最大迭代步数 |
| `skills` | string[] | 启动时要被识别 / 注入的 skill 名列表（managed 拷贝、external symlink、project 自发现） |
| `tools` | object | opencode 旧版 tool 控制 schema，透传 |

未在上表中的 frontmatter 字段：UI 在"高级"折叠区有原始 YAML 输入框，保存时合荷透传给 opencode。

### 8.3 正文（system prompt）

- 文件正文（frontmatter 之后）作为 opencode session 的 **system prompt**
- **正文允许为空**：表示该 agent 没有 baseline system prompt，全靠节点 prompt 与 opencode 内置行为驱动
- 正文 **不做模板替换**：内含 `{{x}}` 等字符按字面透传
- 正文支持 Markdown，编辑界面有 GFM 实时 Preview tab

### 8.4 示例

```markdown
---
name: code-auditor
description: 审计 git diff，找出潜在缺陷
outputs:
  - audit_findings
  - summary
readonly: true
model: anthropic/claude-opus-4-7
skills:
  - go-conventions
  - security-checklist
permission:
  edit: deny
  bash: deny
---

You are a senior security & quality auditor. Review the provided git diff and
list concrete issues. Be precise: include file path, line number, severity.

When you finish, emit a `<workflow-output>` block with the ports declared above.
```

---

## 9、UI / UX

### 9.1 应用骨架

- 左侧栏：Agents / Skills / Workflows / Tasks / Settings 五个一级入口
- 主体区域随入口切换：列表页 / 编辑器 / 详情页
- 默认中文 UI（i18next + react-i18next）；预留多语言切换
- 主题：默认跟随系统（light / dark），settings 可手切

### 9.2 列表页（Agents / Skills / Workflows / Tasks）

- shadcn DataTable 表格布局，行末菜单（打开 / 复制 / 删除）
- 顶部：搜索框 + 状态/仓/workflow chips 筛选 + 时间排序
- 顶部右上："新建"按钮
- URL 标识：agent / skill 用 `name`（唯一），workflow / task 用 ULID

### 9.3 Workflow 编辑器

#### 画布
- xyflow v12：平移、缩放、minimap、自动布局（DAG 一键整理）、网格吸附
- 撤销 / 重做（Cmd+Z / Shift+Cmd+Z），仅覆盖画布操作（节点位置、边、创建删除），不覆盖节点抽屉的字段编辑
- 多选 + 复制粘贴（粘贴会生成新 ID）
- 自动保存：debounce 1s 写 DB；UI 顶部显示"已保存 / 保存中"指示

#### 侧栏（节点创建源）
- 分组：**Agents**（列出全部 agent，顶部搜索框） / **Wrappers**（git-wrapper, loop-wrapper） / **IO**（input-node, output-node）
- 拖拽到画布即创建对应节点
- agent 节点默认为 single-process，可在节点抽屉切到 multi-process

#### 节点抽屉（右侧 480px）
- **Edit / Preview** 双 tab
- **Edit tab** 字段：
  - agent 选择器（必选）
  - 节点 prompt 模板（多行 Markdown 编辑器，支持 `{{port_name}}` + `{{__repo_path__}}` 等）
  - per-node overrides：model（来源：`opencode models` + 手输）/ variant / temperature
  - retries（默认 0）/ timeout / dangerouslySkipPermissions
  - **single ↔ multi-process** toggle；切到 multi 后补：sourcePort 选择器 + 分片策略
- **Preview tab**：每个上游 port 一个 mock 输入框，实时拼出最终 user prompt（含框架协议块）

#### 右键菜单
- 节点：复制 / 删除 / 组合为 wrapper（子菜单选 git/loop）/ 解组 / 跳到 agent 详情页
- 边：删除 / 反转 source-target / 重路由 port
- 画布空白：粘贴 / 全选 / 自动布局

#### 静态校验（保存时）

校验失败 **不阻止保存**（中间态允许，UI 高亮错误），但**阻止启动 task**。完整列表：

1. 边端口存在性：每条边的 source/target port 必须在节点输出/输入中存在
2. 拓扑合法：环只允许出现在 loop wrapper 内
3. wrapper 必填字段：loop wrapper 必有 `max_iterations` + `exit_condition`；git wrapper 必有 ≥1 内层节点
4. 引用合法：节点引用的 agent / skill 名、sourcePort 节点&端口、输出节点 binding、输入节点 inputKey 都能解析到实体
5. 节点 prompt 模板里 `{{port_name}}` 必须能匹配到该节点的输入端口（拼写错或 port 已删 → 校验失败）

#### 多 tab 同步

- 同一 workflow 在多浏览器 tab 打开 → **后写胜出 + 实时 sync**
- 服务端 `/ws/workflows` 频道推送 update 事件；其他 tab 收到后 toast 提示并自动 reload 最新版本

### 9.4 Workflow 启动表单

- 输入字段按 workflow.inputs 渲染（4 种控件类型）
- 隐式必备：仓选择器（最近用过下拉 + 自由填）/ base 分支选择器（默认仓 HEAD，下拉换 ref）
- "从以往 task 填充"下拉：列出同 workflow 最近 5 个 task，选中后拷贝 inputs 为初值
- 顶部信息条：当前仓上正在跑的 task（提示但不阻止）/ 仓主未提交变更（提示但不阻止）
- 校验：required / minCount / git ref 存在性

### 9.5 任务状态视图（task 详情页）

#### 三区布局

- **顶："产出"面板** —— 如果 workflow 有输出节点，置顶展示输出节点收集的 port 卡片；没有则不显示该面板
- **中：状态画布** —— 70vh 高度，与编辑器同布局但只读；节点点击触发右侧抽屉
- **下：git diff** —— 默认展开，展示 worktree 当前 diff（diff2html 渲染）

#### 节点颜色

| 状态 | 颜色 |
| --- | --- |
| pending | 灰 |
| running | 黄 |
| done | 绿 |
| loop body 已跑过且未来仍可能再跑 | 蓝 |
| failed | 红色边 + "failed" |
| canceled | 红色边 + "canceled" |
| interrupted | 红色边 + "interrupted" |
| exhausted（仅 loop wrapper） | 红色边 + "exhausted" |

#### 顶部错误概述条

- 如果 task 状态为 failed / interrupted，顶部一条红色提示条：错误摘要 + "跳到失败节点"按钮

### 9.6 节点详情抽屉（右侧 480px）

包含四个 tab，记忆每个节点最后访问的 tab：

1. **Prompt** —— 拼接后传给 opencode 的完整 user prompt 原文（含模板替换结果 + 框架协议块）
2. **Events** —— opencode `--format json` 流式事件，前端 200ms throttle 渲染。顶部 chips 按 kind 过滤（text/tool/reasoning/permission_asked/step/error/stderr）。"Raw stdout"切换器：直接看原始 stdout 拼接（含未解析为 event 的部分），便于 debug 信封解析问题
3. **Output** —— 解析后的 `<workflow-output>`，按命名端口分卡展示，可复制
4. **Stats** —— Token (input/output/cache_creation/cache_read/total) + 耗时（总用时 + 启动 + 结束时间）+ opencode exit code + Retries history（同一节点其他 retry_index 的 node_run 列表，可点跳）+ 子进程列表（仅多进程父：shard_key / status / token / 点击进入 shard 详情，shard 自身有同样的 4 tab）

### 9.7 任务管理列表

- 表格列：task id / workflow / repo / 启动时间 / 状态 / 耗时 / 操作（cancel / resume / retry whole / 重跑某节点 / 删除 worktree / 彻底删除）
- 默认按启动时间倒序
- 筛选：状态 chips / 仓 / workflow / 时间范围
- 排序：启动时间 / 耗时 / token
- 实时刷新：`/ws/tasks` 频道推送状态变迁

### 9.8 Agent 编辑界面

- 混合布局：左侧 frontmatter 表单（name / description / outputs[chips] / readonly / model / variant / temperature / steps / skills[chips] / permission[表单 + 高级 raw JSON] / 高级 frontmatter [raw YAML]）
- 主区：Edit / Preview 双 tab，Markdown 编辑器写正文 prompt（GFM 渲染预览）
- 保存按钮（自动保存可选；编辑界面 v1 用显式 Save 按钮 + 未保存离开提示，避免 prompt 误改）

### 9.9 Skill 编辑界面

- 左侧文件树：列出该 skill 下所有文件（SKILL.md + 支撑文件）
- 主区：Markdown 编辑器（Edit / Preview tab）；二进制文件展示元信息 + "在 Finder 显示"
- 工具栏：上传文件 / 新建文件 / 重命名 / 删除
- frontmatter 校验：仅 `name` + `description` 必填，其他透传

### 9.10 Settings

四个分组（标签页）：

- **运行时**：opencode 路径覆写 / 默认 model / 默认 variant / 默认 temperature / `max_concurrent_nodes`
- **限额**：默认 per-task 最大耗时 / 默认 per-task token 上限 / 默认 per-node 最大耗时
- **GC**：worktree GC 开关与阈值 / events 表归档阈值
- **网络**：bind host / bind port / 是否允许 0.0.0.0（仅重启后生效）

按钮：

- "导出备份"（dump db.sqlite + skills/ + workflows YAML 到 `~/.agent-workflow/backups/{date}.tar.gz`，不含 worktree / runs / logs）
- "重生 token"
- "刷新 model 列表"

绝大多数项保存即生效；bind host/port 与多实例 lock 仅重启后生效，UI 在保存后会标注哪些需重启。

---

## 10、v1 范围与不做项

### 10.1 v1 必做

- Agents / Skills / Runtime（默认 opencode）/ Workflows / Tasks 的 CRUD 与列表 UI（agent / skill / workflow / task hard delete + 引用拒绝）
- Workflow 拖拽编辑器（侧栏拖拽 + agent 搜索 + 节点抽屉 Edit/Preview + 右键菜单 + minimap + 自动布局 + 撤销重做 + 自动保存 + 多 tab sync）
- 静态校验全集（5 项）
- 启动表单（4 种控件 + 仓 + base 分支 + 复用历史输入 + 同仓在跑 task 提示）
- 单进程节点 + 多进程节点（per-file / per-N-files / per-directory 三种分片，含重命名/二进制/空 diff 边界）
- 多进程节点自动 errors port（**deferred，v1 未实现** —— 见上文 fan-in 段的实现状态说明）+ 子进程独立并发上限
- Git wrapper、Loop wrapper（三种内置退出条件，loop body 每轮独立无跨轮反馈）+ 任意嵌套
- 进程隔离（`OPENCODE_CONFIG_CONTENT` 注入 agent + `OPENCODE_CONFIG_DIR` 隔离 managed skill；不设 DISABLE flags）
- Worktree per task（base 分支可选）+ task 完成后保留
- 写入串行 / 只读并发（agent.readonly 不可被节点覆盖）
- 失败处理 + retry_index 历史 + interrupted/canceled/failed/exhausted 状态分离
- Resume / retry whole / retry single node（默认级联下游） + 重跑前 worktree 回滚到节点 start 前快照
- Cancel：杀子进程 + worktree 保留
- 资源限额：per-task 耗时 / per-task token / per-node 耗时
- 任务状态视图三区（产出 / 画布 / diff）+ 顶部错误概述条
- 节点详情四 tab（含 retries history / 子进程列表 / Raw stdout 切换 / kind 过滤 / 200ms throttle）
- 流式 opencode events 推送 + WS 三频道（`/ws/tasks/{id}` / `/ws/workflows` / `/ws/tasks`）+ since-id 重放
- YAML 导入（同名 / 同 ID 冲突弹窗：跳过 / 覆盖 / 导为新件） + YAML 导出
- SQLite (WAL + NORMAL + busy_timeout) + Drizzle migration（启动时自动 apply）+ `$schema_version` 字段
- Daemon flock 单实例 + graceful shutdown 30s + 重启扫描孤儿
- token 防误访问（127.0.0.1 + 32 字节 token + 可选 0.0.0.0）
- 浏览器登录：stdout 打印 `?token=...` URL → localStorage 存
- CLI 子命令：start / stop / status / version / doctor / config get|set / migrate / backup
- 日志：stdout + `~/.agent-workflow/logs/daemon.log` 自动 rotate（10MB × 5）
- 后端：Bun + Hono + Drizzle + ULID；前端：Vite + React 19 + TanStack Router + xyflow v12 + shadcn/Base UI + i18next
- 中文 UI + 系统主题（light/dark）
- API 错误统一 schema + healthcheck endpoint
- 测试：bun:test 后端 + Playwright e2e + vitest 前端关键组件
- 分发：Bun build 单二进制 + GitHub Releases (macOS+Linux)
- 备份：settings 导出按钮 + `agent-workflow backup` CLI

### 10.2 v1 不做

- Sub-workflow 嵌套节点
- Claude Code / 其他 CLI runtime（接口预留）
- Windows 支持
- 多机分布式 / 云端
- Per-hunk 分片
- 自定义分片表达式 / 插件
- 团队协作、用户系统
- Token → USD 成本汇总报表（仅 token 数）
- Workflow 模板市场
- Loop wrapper 跨轮反馈端口（仅靠 worktree 自然反馈）
- agent.md 系统占位符模板（{{port_name}} 仅在节点 prompt 模板生效）
- 详细审计日志 / 多用户审计

---

## 11、已解决的开放问题

原提案在 § 2 第 1 节中列出"多 agent 同时启动的冲突问题，需要调研方案"。**已解决**：

1. **多 opencode 进程的 agent / skill 配置冲突** ——
   - **agent 定义**：用 `OPENCODE_CONFIG_CONTENT` 把平台的 agent 配置以 inline JSON 注入，opencode 在所有目录扫描完成后最后 merge，平台定义**恒胜过**仓内 / `$HOME` 的同名 agent。
   - **平台管理的 skill**：写入每进程独立的 `OPENCODE_CONFIG_DIR=~/.agent-workflow/runs/{task}/{node}/.opencode/skills/`，进程之间互不干扰。
   - **不再设置 `OPENCODE_DISABLE_*` flag**：仓内 `.opencode/skills/` 业务 skill、`~/.claude/skills`、`~/.agents/skills`、`~/.opencode/`（含 auth）都正常加载，agent 执行期间可直接使用仓内既有 skill。
2. **同 task 内多写入节点的工作区冲突** —— `agent.md` 加 `readonly` 标记，框架对写入节点强制串行。
3. **同仓多 task 的工作区冲突** —— 每个 task 启动时自动 `git worktree add`，task 之间在物理上隔离。

详见 [`design.md` § 7](./design.md#7opencode-子进程隔离实现) 的实现细节。
