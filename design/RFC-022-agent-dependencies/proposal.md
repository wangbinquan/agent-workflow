# RFC-022 Proposal — Agent 依赖其他 Agent（dependsOn）：一次声明，运行期自动注入闭包 + skills

> 状态：Draft（2026-05-16）
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)
> 修订基线：design/proposal.md §3.1（Agent 管理）+ design/design.md §3（agents 表）+ §4.3（运行期注入：OPENCODE_CONFIG_CONTENT 与 OPENCODE_CONFIG_DIR）

## 1. 背景

当前 agent 的"内部资源"只有一类：`skills: string[]`。运行节点时框架按 agent.skills 把 skill 目录拷贝 / symlink 进 `OPENCODE_CONFIG_DIR/skills/{name}/`，让该 agent 在 opencode 进程里能 `Read SKILL.md` / 调内里脚本。

但实际"workflow agent"模式里，一个总控 agent（例如 `code-fix-orchestrator`）经常需要在自己跑的过程中**通过 opencode 自带的 task / subagent 工具调起其他 agent**（例如 `code-auditor` / `unit-test-runner`），让它们专门负责某一块脏活。要让这种调用在 opencode 里成立，被调起的 agent 也必须出现在当前进程的 inline JSON config 里——否则 opencode 找不到 `code-auditor` 这个名字，会直接报错 / 退化为主 agent 自己写。

今天平台的 `OPENCODE_CONFIG_CONTENT` 只 inject **当前节点指定的那一个 agent**（`runner.ts buildInlineConfig` 写死 `{ agent: { [agent.name]: inline } }`）。结果：

- 主 agent 的 prompt 里如果引用了 `<task agent="code-auditor">...`，opencode 进程里没这个 agent 定义，调用失败；
- 即使用户在仓 `.opencode/agents/code-auditor.md` 里有一份，那份的内容不一定与平台 DB 里这条同名 agent 一致——主 agent 行为变得不可预测；
- 被调起的 agent 自己需要的 skills 没人注入，opencode 也找不到。

用户给的诉求很明确：**"声明该 agent 所依赖的其他 agent，和依赖 skill 一样，支持依赖多个 agent，在运行期会把依赖的 agent 以及依赖 agent 所依赖的 skill 都一起加载进来形成一个工作流整体"**。

### 1.1 为什么要现在做

- M1–M5 已全部 Done（81/81 issue 关闭），近期 RFC 集中在 review / canvas / markdown / 任务详情视图，agent 资源管线本身从 P-1-08 / RFC-018（agent.md 导入）落地后基本稳定，是补齐"agent 之间组合"能力的好窗口。
- 改动面集中在 **shared schema + agents 服务/校验 + scheduler 解析 + runner inlineConfig**——runner 主体（spawn、env、prompt 拼接、envelope 解析）零改动，只是构建 inlineConfig 那 1 个函数接受额外参数 + skills 并集换一行。
- 与并行 RFC（RFC-021 任务详情 tab 化等）完全正交，不会撞车。

### 1.2 本 RFC 不动哪些地方

- **不动** `WorkflowDefinition` / 节点引用关系——agent 在 workflow 里仍只通过节点的 `agentName` 直接引用一个 agent，dependsOn 是 agent 自身的属性，不进入 workflow.definition。
- **不动** `OPENCODE_CONFIG_DIR` / `OPENCODE_CONFIG_CONTENT` 这两条 env var 的语义（design/design.md §4.3）。仅 inline JSON 里 `agent` map 的成员数量从 1 变成 N。
- **不动** envelope 解析与 outputs 校验——envelope 永远只看主 agent 声明的 outputs；依赖 agent 的 outputs 仅是它内部 subagent 调用的契约，不冒泡到父节点端口。
- **不动** `agent.readonly` / 写入串行调度的语义——节点 readonly 由主 agent 决定；依赖 agent 自身的 readonly 在 inline JSON 里随原值透传，由 opencode 自己尊重。
- **不动** 单节点 retry / resume / pre_snapshot rollback 路径——它们仍以 node_run 为单位回滚，不感知 dependsOn 闭包。
- **不动** multi-process（agent-multi）分片逻辑——每个 shard 进程的 inline JSON 仍按相同公式构造（主 agent + 闭包），分片本身与 dependsOn 正交。

## 2. 目标

### 2.1 做

1. **Agent 新增 `dependsOn: string[]` 字段**（agent name 列表，去重、保序）。
   - frontmatter / DB / API / agent.md import / 编辑表单四处贯通；与 `skills` 字段平行。
   - 名字必须指向另一个已存在的 agent（保存时校验，与现有"agent-not-found"语义一致）。
   - 自身不能出现在自己的 dependsOn 里（自引用拒绝）。
2. **运行期闭包递归展开**。
   - 调度器为节点 spawn opencode 前，从主 agent 起 BFS / DFS 展开 `dependsOn` 闭包，去重收集所有依赖 agent 实例。
   - **循环依赖**：闭包展开检测到环时 → 节点直接 fail（`agent-dependency-cycle`），不 spawn；UI 在 agent 保存阶段就同样拒绝，正常情况下运行期不会触发，作为兜底。
3. **inline JSON 注入扩展**。
   - 现 `buildInlineConfig(agent)` 返回 `{ agent: { [agent.name]: {...} } }`。
   - 改成 `buildInlineConfig(agent, dependents)` → `{ agent: { [agent.name]: {...primary}, [dep1.name]: {...inline}, ... } }`。
   - 每个依赖 agent 的 inline 内容与主 agent 同公式生成（prompt=bodyMd / description / permission / options{outputs, readonly} / 可选 model/variant/temperature/steps）。**dependents 不接受节点 override**（节点 override 只属于主 agent）。
4. **skills 并集注入**。
   - `resolveSkills(主 agent.skills ∪ 闭包 agents.skills 并集)` —— 同名 skill 视作同一条（按 name 去重）。
   - `prepareSkills` 路径不变；只是入参 skill 列表更长。
5. **校验与守卫**。
   - **保存 agent 时**：dependsOn 中每个 name 必须存在（否则 400 `agent-dependency-not-found`）；不能 = 自己 name（400 `agent-dependency-self`）；闭包内不得有环（400 `agent-dependency-cycle` + 列出环路径）。
   - **删除 / 改名 agent 时**：被任何其他 agent.dependsOn 引用 → 拒绝（400 `agent-dependency-still-referenced` + 列出引用方）。沿用 `services/agent.ts` 现有"被 workflow 引用拒绝"的并列分支。
   - **workflow 静态校验**：节点引用的主 agent 的依赖闭包内任一 agent 不存在 → 报 `agent-dependency-not-found`（语义与现有 skill-not-found 平级）；闭包内 skills 不存在 → 复用 `skill-not-found`。
6. **agent.md 导入扩展**（RFC-018 follow-up）。
   - frontmatter 接受 `dependsOn: [foo, bar]`；parser 输出该字段；未识别值（非字符串数组）落 frontmatterExtra 兜底，与既有规则一致。
7. **UI**：Agent 详情/新建表单在 "Skills" chips 区段下方新增 "Depends on agents" chips（下拉来自现有 agent 列表，自身名字过滤掉）。Preview tab 在拼接 prompt 时无变化（dependsOn 不进 prompt），但在表单顶部显示"运行时还会加载 N 个依赖 agent"提示。
8. **闭包依赖树可视化**：两个入口展示同一棵树（详见 design.md §5.4 / §5.5 / §5.6）。
   - **Agent 编辑表单**："Depends on agents" chips 下方折叠面板 `Dependency tree (preview)` 默认展开，dependsOn 字段变更 → debounce 200ms 调 `POST /api/agents/closure-preview` → 实时渲染。环 / 不存在 / 自引用都在面板里高亮，与表单飘红错误共存。
   - **节点 Stats tab**：在底部追加 `Dependency tree` 区段，调 `GET /api/agents/:name/closure` 现场展开 DB 当前状态。
   - **渲染形态**：缩进列表 + ASCII 连接线（`├─` / `└─` / `│`），每行一个 agent（name + skill 计数 + readonly/writes badge + 可点击跳详情）。BFS 已展开过的同名 agent 重复出现时显示为 `↑ see above`，children 不再递归。零新依赖（不引 xyflow / Mermaid）。
8. **错误码新增**：`agent-dependency-not-found` / `agent-dependency-self` / `agent-dependency-cycle` / `agent-dependency-still-referenced`。

### 2.2 不做

- **不做** "依赖 agent 也能被节点 override（model/variant/temperature）"。override 永远只作用于节点指定的主 agent；依赖 agent 用自己 DB 里写的值。原因：依赖闭包可能任意深，节点表单暴露每层 override 没有清晰 UX 落点；后续如确需可另开 RFC。
- **不做** "依赖 agent 的 outputs 冒泡进父节点 envelope"。envelope 仅看主 agent.outputs，依赖 agent 的 outputs 是它自己被 subagent 调起时的内部契约。详见 §1.2、design.md §4.3。
- **不做** "依赖闭包跨 task 内串行写入互斥"。同一 task 同一节点内的写入串行 / 只读并发由 scheduler 按主 agent.readonly 判定；依赖 agent 即便 readonly=false 也是在主 agent 子进程内由 opencode 自己排队，不影响平台调度器。这与现有 design.md §4.4 写入串行模型保持一致。
- **不做** "运行期允许依赖闭包里某个 agent 不存在仅打 warning"。运行期不存在直接 fail，保守优于静默退化（与 skill-not-found 现行处理一致）。
- **不做** 限制依赖 agent 必须 readonly=true。用户可能正想让依赖 agent 做写入工作（fix subagent），平台不预设。
- **不做** dependsOn 在 YAML workflow 导入导出里的字段——agent 本身不走 workflow YAML，dependsOn 跟随 agent.md 导入/导出走（详见 design.md §7）。
- **不做** "依赖 agent 共享主 agent 的 prompt 模板变量替换"。依赖 agent 的 bodyMd 原样注入 inline JSON 的 prompt 字段，不做 `{{port_name}}` 替换——这个替换只发生在主 agent 的节点 prompt 模板上。
- **不做** "依赖 agent 在节点详情 UI 里展开成可点击的列表 / 查看它们的事件流"。运行期事件流仍以 node_run 为单位记录；UI 仅在节点 Stats tab 末尾追加 "Loaded N dependent agents" 只读列表（点击跳到 agent 详情）。
- **不做** 限制闭包深度上限（如 max=10）。环路已显式拒绝，无环的合理 DAG 自然有限；运行期 inline JSON 字节数若过大（>32KB）才告警，落 §design.md 风险章节。

## 3. 用户故事

**S1（happy path：声明并跑通）**
用户有 3 个 agent：`code-fixer`（写入，主控）、`code-auditor`（只读，依赖 SKILL `code-style-guide`）、`unit-test-runner`（只读，依赖 SKILL `repo-tests`）。打开 `/agents/code-fixer` → "Depends on agents" chips 选中 `code-auditor` + `unit-test-runner` → 保存。后续在 workflow 节点用 `code-fixer` → 启 task → node_run 跑起来：opencode 进程的 `OPENCODE_CONFIG_CONTENT` 里 `agent` map 含 3 个 entry；`OPENCODE_CONFIG_DIR/skills/` 里同时有 `code-style-guide` 和 `repo-tests`。`code-fixer` 用 task 工具调起 `code-auditor` → 正常工作。

**S2（递归闭包）**
`code-fixer` dependsOn `[code-auditor]`，`code-auditor` dependsOn `[code-explainer]`。运行 `code-fixer` 节点时闭包展开 = `{code-fixer, code-auditor, code-explainer}`；三者的 skills 并集都被注入。用户在 `code-fixer` 的表单里**不需要**重复声明 `code-explainer`。

**S3（保存阶段拒绝环）**
用户在 `code-fixer.dependsOn` 加 `code-auditor`；又在 `code-auditor.dependsOn` 加 `code-fixer`。第二次保存时服务端展开闭包检测到环 → 400 `agent-dependency-cycle` + body 携带 `cyclePath: ['code-auditor', 'code-fixer', 'code-auditor']`；UI 在表单上飘红 + 显示路径。

**S4（保存阶段拒绝不存在的引用）**
用户拼写错把 `code-aduitor` 放进 dependsOn → 保存 → 400 `agent-dependency-not-found` + body 列出未找到名字。表单字段标红。

**S5（删除被依赖的 agent）**
用户尝试删 `code-auditor`，平台扫到 `code-fixer.dependsOn` 含它 → 400 `agent-dependency-still-referenced` + body 列出 `[{agent: 'code-fixer'}]`。用户先去 `code-fixer` 解绑或先删掉主 agent，再删依赖。

**S6（改名）**
用户把 `code-auditor` 改名为 `auditor`（POST `/agents/code-auditor/rename` body=`{newName:'auditor'}`）。如果被任何 agent.dependsOn 引用 → 同 S5 拒绝（沿用现有 rename 引用守卫的并列分支，避免悄悄留下死引用）。

**S7（运行期闭包内 skill 不存在）**
依赖 agent `code-auditor` 的 skills 含 `code-style-guide`，但用户把这条 skill 删了又没刷新 workflow。启 task 时 scheduler 在 resolveSkills 里发现 `code-style-guide` 解析失败 → node_run 直接 fail（`skill-not-found`），与主 agent.skills 缺 skill 同路径。

**S8（多进程 fan-out）**
`code-fixer` 是 agent-multi（每文件分片）。每个子 shard 进程都按同样公式注入闭包 inline JSON + skills 并集；fan-out 进程之间相互隔离，dependsOn 与 fan-out 正交。

## 4. 验收标准

### 功能

- **A1（schema）**：`POST /api/agents { ..., dependsOn: ['code-auditor'] }` 接受 string[]，落 DB；`GET /api/agents/:name` 返回字段；`PUT` 增量更新 dependsOn 字段；缺省视作 `[]`（与 skills 一致）。
- **A2（保存校验）**：
  - dependsOn 中任一名字不存在 → 400 `agent-dependency-not-found` + `notFound: string[]`。
  - dependsOn 含自身 name → 400 `agent-dependency-self`。
  - 闭包检测到环 → 400 `agent-dependency-cycle` + `cyclePath: string[]`。
  - 重复名字自动 de-dup（不报错，落 DB 时去重保序）。
- **A3（删除 / 改名守卫）**：删除 / rename 一个被其它 agent.dependsOn 引用的 agent → 400 `agent-dependency-still-referenced` + `referencedBy: string[]`。与现有"被 workflow 引用"守卫并列触发任一即拒绝。
- **A4（workflow 校验）**：`POST /api/workflows/:id/validate` 对节点引用的主 agent 跑闭包展开，闭包内任一 agent 不存在 → 报 `agent-dependency-not-found` issue（指向该节点）；闭包内任一 skill 不存在 → 复用 `skill-not-found`（保留现有 issue 形状）。
- **A5（runner inline 注入）**：节点 spawn opencode 子进程时，`OPENCODE_CONFIG_CONTENT` 里 `agent` map 同时包含主 agent + 闭包内所有依赖 agent 的 inline 定义；每个依赖 agent 的 inline 字段与主 agent 同公式（prompt=bodyMd / description / permission / options{outputs, readonly} / 可选 model/variant/temperature/steps），但 **不接受节点 override**。
- **A6（skills 并集注入）**：`OPENCODE_CONFIG_DIR/skills/` 下出现"主 agent.skills ∪ 闭包 agents.skills"并集的目录；同名 skill 只出现一次（按 name 去重）。
- **A7（运行期失败兜底）**：保存阶段已拒绝环，但若任务跑到一半因人为外部改动出现环（如 dependsOn 被通过 SQL 改坏）→ 闭包展开抛 `agent-dependency-cycle` → 节点 fail，task error_message 携带环路径。
- **A8（agent.md 导入）**：`POST /api/agents/import` 解析 frontmatter `dependsOn: [foo, bar]` 写入字段；非字符串数组的值 → 落 `frontmatterExtra.dependsOn` 兜底（不报错），与 RFC-018 现行规则一致。
- **A9（UI 表单）**：Agent 编辑表单 "Skills" chips 区段下方出现 "Depends on agents" chips，下拉候选 = 现有 agents 列表 \ 自身；保存触发 A1/A2 校验；后端校验失败时表单旁红字 + 指向具体字段（同名字段、循环路径、未找到名字）。
- **A10（multi-process 一致）**：agent-multi 节点的每个子 shard 进程都按同样公式注入（A5+A6），不退化。
- **A11（依赖树可视化）**：
  - 编辑表单：dependsOn chips 字段变化 → debounce 200ms 调 `POST /api/agents/closure-preview` → 下方 `Dependency tree (preview)` 折叠面板渲染闭包树（缩进 + ASCII 连接线 + 每行 name / skill 计数 / readonly badge / 可点击跳详情）；preview 端点返 200 + ok:false 时不抖红浏览器网络面板，按错误码渲染对应错误条（含 `agent-dependency-cycle` 的 `A → B → C → A` 单行环路径）。
  - 节点详情 Stats tab：调 `GET /api/agents/:name/closure` 渲染同一 `<DependencyTree>` 组件；闭包内任一 agent 在 DB 现已不存在时显示 `<missing>` 占位行，让用户察觉外部篡改的死引用。
  - BFS 已展开节点二次出现时（如菱形依赖 A→B→D 与 A→C→D）下层节点显示为 `↑ see above`，children 不再递归——避免视觉刷屏。

### 非功能

- **B1** `bun run typecheck && bun run test && bun run format:check` 全绿；CI 单二进制 build + e2e 不退化。
- **B2** 不退化既有 agent / skill / workflow / runner 测试集（现有节点不声明 dependsOn 时行为 = `dependsOn: []`，inline JSON 仅 1 个 agent entry，与现状逐字节一致）。
- **B3** backend tests 至少 +14（agent service 4 + workflow.validator 2 + scheduler.resolveDependsClosure 4 + runner.buildInlineConfig 多 agent 2 + agent.md parser 2）；frontend tests 至少 +3（chips 选择 + 已禁用自身 + 服务端错误回显）。
- **B4** 一条新 migration `0006_agents_depends_on.sql`，可重复 apply / rollback；启动时 migration helper 自动执行；rollback 删 column。
- **B5** runner.ts 主体（spawn / pumpLines / event 解析 / envelope）0 LOC 改动——只有 `buildInlineConfig` 签名 + `prepareSkills` 入参源头变化。
- **B6** inline JSON 字节数：3 agent 闭包 + 平均 4KB body 时 < 16KB；> 32KB 时 runner 在 log 里 warn（不阻断），留 v1.1 观察空间。

### 回归防护

- **C1** `tests/agent-depends-on-save.test.ts` 顶部注释链回本 RFC：「locks RFC-022 §2.1 #5 — POST/PUT agent 拒绝 dependsOn 中：不存在名 / 自引用 / 环；红了说明保存校验被破坏」。覆盖 A2 四个分支。
- **C2** `tests/agent-depends-on-cascade-guard.test.ts` 锁删除 / 改名守卫（A3）：构造 A→B 后删 B 必须 400，且 referencedBy 携带 A。
- **C3** `tests/scheduler-depends-closure.test.ts` 锁闭包展开（A5）：构造 A→B→C，scheduler 在 spawn 前调 resolveDependsClosure 返回 [A,B,C]（按 BFS 顺序），重复名只出现一次，无环时不抛错；红了说明 §2.1 #2 闭包语义破坏。
- **C4** `tests/runner-build-inline-config-multi.test.ts` 锁 buildInlineConfig 接受 dependents 参数后产出的 inline JSON 含全部 entry + 主 agent override 不渗到依赖 agent；红了说明 A5 被破坏。
- **C5** `tests/workflow-validator-depends.test.ts` 锁工作流静态校验把闭包内缺失 agent / skill 都报出来（A4）。
- **C6** `tests/agent-md-import-depends-on.test.ts` 锁 agent.md frontmatter `dependsOn` 解析与兜底（A8）。

## 5. 风险与回滚

- **风险**：inline JSON 因闭包过大触发 OS arg max（macOS 256KB / Linux 128KB+）。**缓解**：env var 传递不走 argv（已是 env），上限是 `_POSIX_ARG_MAX` 之外的 env 总大小；32KB 警告阈值已在 B6；若用户单 agent body > 100KB 直接拒绝保存（沿用现有 schema 长度约束，本 RFC 不引入新约束）。
- **风险**：用户在 agent.dependsOn 里写大量同名 skill 但其中一条 external 路径不存在 → 运行期 resolveSkills 抛 skill-not-found。**缓解**：保存 agent 阶段已校验主 agent.skills 存在；本 RFC 在保存阶段同步对**闭包内每个 agent 的 skills 是否存在**做一次预检（warning 级别，列入响应 body `closurePreview.missingSkills`，但不阻断保存——因为 skill 可能由父目录 source 在用户运行前补回），仅在运行期 fail。这与现有 skill-not-found 兜底语义一致。
- **风险**：dependsOn 闭包内 agent 出现"同名 + 不同内容"——理论不可能（agent name 在 DB 唯一），但 SQL 篡改场景下 inline JSON map 因 key 唯一仍会保持单一定义，opencode 行为可预测。
- **风险**：opencode 未来收紧 subagent 调用语义（如要求 agent 必须有 `description`）。**缓解**：本 RFC 注入闭包 agent 时与主 agent 同公式（含 description / permission），未来如 opencode 加新字段，runner.buildInlineConfig 单点扩展。
- **回滚**：migration 0006 down 即可（drop `agents.depends_on` 列）；前后端代码以单 PR 落地、`git revert` 即可整体回退；DB 中 `agents.depends_on` 列被 drop 后既有 agents 行不受影响（runner 取默认 `[]`，行为回到 RFC-022 落地前）。
