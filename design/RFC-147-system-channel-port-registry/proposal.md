# RFC-147 · 系统通道端口描述符注册表（proposal）

- **状态**：Draft（G3-G10 批量授权第 3 弹，设计门后直接实现）
- **来源**：`design/flag-audit-2026-07-07.md` §4.5（RFC-G5）
- **前期调研**：六现场逐一精读（本 RFC design.md §1 全录语义矩阵），无需 fan-out

## 1. 背景

「哪些端口是系统通道、图遍历时该不该当数据流依赖」这份知识存在 **6 份、3 种语义家族**，
成员集互不一致：

1. `shared/clarify.ts isClarifyChannelEdge` — 5 端口、**分侧判**（source∈{**clarify**,
   to_designer, to_questioner} / target∈{**clarify_response**, **external_feedback**}）。
2. `shared/workflow-sync-diff.ts` 私有 `CHANNEL_PORTS` — 同 5 端口但**任一侧命中即算**
   （更宽，展示防御性语义）。
3. `shared/prompt.ts` 私有 `SYSTEM_PORT_NAMES` — 仅 2 端口（`__clarify_response__` /
   `__external_feedback__`），管 auto-append 跳过。
4. `scheduler.ts buildScopeUpstreams` — 手写第三种语义：`__clarify__` **仅当 target
   kind==='clarify' 才跳过**（cross-clarify 目标保留为数据流依赖——2026-05-22 无上游
   泄洪 bug 的修复语义），其余 4 端口按侧跳过。
5. `dispatchFrontier.ts wrapperExternalUpstreamSources` — #4 的逐字手抄副本，注释自我
   要求 "Keep the two in lockstep"（靠人肉）。
6. `taskQuestionDispatch.ts` 私有 `isChannelEdge` — 第四变体：`__clarify__` 无条件跳过。
   **调研结论：该变体与 #1 逐字等价**（同 5 端口同分侧），其「无条件」只是注释里对
   agent-ancestry 场景等价性的论证，代码形状即共享谓词。

下一个 RFC-056/120 式功能新增通道端口时 ≥6 处改动、零交叉锁。

## 2. 目标

1. **单一注册表**：shared `SYSTEM_CHANNEL_PORTS: Record<portName, SystemChannelPortSpec>`
   （spec = `{ side: 'source'|'target', promptInjected: boolean,
dataflow: 'never'|'unless-target-clarify' }`），键用既有端口常量（schemas/workflow.ts）。
2. **三个语义家族全部改为表投影**：
   - 分侧成员判 `isClarifyChannelEdge`（#1/#6 及其 canvas/validator 消费者）；
   - 任一侧宽判（#2，sync-diff 展示）；
   - 数据流跳边 `channelEdgeDataflowSkip(edge, kindOfTarget)`（#4/#5 收敛为一个共享
     实现——"lockstep" 从注释约定变为结构事实）；
   - prompt 注入集（#3）。
3. **先钉后收**：收敛前先用 shared 单测把 #4 的 nuanced 语义逐格钉死（`__clarify__`→
   clarify 跳 / →cross 保留 / →agent（残迹边）保留 / 其余四端口按侧跳）。
4. 新增一种通道端口的改动面收敛为：**注册表 1 行 + declaredPorts owner 行**
   （漂移互锁测试强制两处同步；家族语义各消费面自动生效。设计门修订：原
   「仅 1 行」的说法低估了 kind 归属维，validator 环检补录为第 7 消费点）。

## 3. 非目标

- **前端「连接通道注册表」**（audit §5.5：WorkflowCanvas 4 条平行 if 链 + drag helper
  对）——那是交互层的 classify/apply/cascade 注册表，体量数倍于本 RFC，按审计建议
  「前后脚」另立（归前端批 G8/G9 之后评估）。
- **不改变任何一处现行语义**：topologicalOrder 的均匀跳过（cycle-break 用途）与
  buildScopeUpstreams 的 nuanced 保留是**有意的语义差**，注册表让这两种投影都能表达，
  不做「统一成一种」的行为变更。
- 端口常量本身不迁移（`schemas/workflow.ts` 既有导出面不动）。

## 4. 验收标准

1. 注册表落 shared + 逐端口表值锁；五个私有拷贝（sync-diff CHANNEL_PORTS / prompt
   SYSTEM_PORT_NAMES / scheduler 手写块 / dispatchFrontier 手抄块 / taskQuestionDispatch
   isChannelEdge）全部消亡，grep 棘轮防回潮。
2. `channelEdgeDataflowSkip` 语义格测试全绿（先于收敛提交）；既有 cross-clarify 集成
   测试（2026-05-22 泄洪回归）零改动全绿。
3. isClarifyChannelEdge 语义字节不变（canvas/validator/topology 消费者零改动）。
4. 门禁 + CI conclusion=success + Codex 双门收敛。
