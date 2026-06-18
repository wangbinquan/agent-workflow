# RFC-100 — 反问节点强制 ask-back（移除输出逃逸口 + 富化反问提示词）

状态：Draft

## 背景

给一个 agent 挂载反问节点（self-clarify，RFC-023 / cross-clarify 的 questioner，RFC-056）后，
观察到的现象是：**该节点通常反问 2 次左右就自行收尾、不再反问**，与"挂了反问节点就应该持续追问、
把所有细节问清楚再动手"的预期不符。

根因有两层（两层都得堵）：

1. **提示词层**：当前反问激活时注入的是 RFC-039 的"双模前导"（bi-modal preamble）——
   它把 `<workflow-clarify>` 设为默认，但**同时给了 Agent `<workflow-output>` 的完整格式与一条软逃逸口**
   （"当一切都已敲定时你可以直接输出 (A)"）。Agent 倾向于尽快交付，问个一两轮后就给自己找个
   "差不多够了"的理由切去输出。
   （见 `packages/shared/src/prompt.ts buildProtocolBlock(hasClarifyChannel=true)` + `renderClarifyDirectiveTrailer('continue')` 末行。）
2. **运行时层**：即便提示词不鼓励，运行时 `detectEnvelopeKind` 只要看到 `<workflow-output>` 就判为
   `output` 并接受为 `done`（缺端口仅告警、不失败），**对"反问激活期间擅自输出"零拦截**。
   （见 `packages/backend/src/services/runner.ts` envelope 分类 + `envelope.ts detectEnvelopeKind`。）

## 目标

- 反问节点一旦激活（通道已接线 **且** 用户尚未点"停止反问"），Agent 进入**强制 ask-back 模式**：
  - 注入的提示词**只**给反问（`<workflow-clarify>`）格式 + 一段强力、丰富的"必须反问"指引；
    **不**给 `<workflow-output>` 的格式与说明。
  - 运行时**拦截**反问激活期间出现的 `<workflow-output>`，判为违规并按既有 followup 机制要求 Agent 改回反问。
- 只有当用户点击"停止反问"（`directive='stop'`）后，本轮 rerun 才注入输出格式提示，Agent 据此产出最终 `<workflow-output>`。
- 反问提示词按用户给定原则**显著富化**，核心目标：**不允许 Agent 有任何臆测 / 编造，必须由人给齐所有细节才能动手**。
- self-clarify 与 cross-clarify questioner **行为同步**（两者共用同一注入与门控路径）。

## 非目标

- 不改"停止反问"的触发方式与 UI——复用既有 `directive='stop'` 控件（本 RFC **无前端改动**）。
- 不改 cross-clarify designer 侧的 External Feedback 注入 / update-mode（RFC-056 §6）逻辑。
- 不改反问的数据模型（`clarify_rounds` / `clarify_sessions`）、会话模式（inline/isolated）选择规则。
- 不引入"跨迭代反馈端口"等新机制。
- 不改 wrapper-loop 的 `maxIterations` 语义（反问轮数本就不吃 loop 预算——见 design §失败模式）。

## 用户故事

- 作为工作流作者，我给"需求澄清"agent 挂上反问节点后，它会**持续、深入**地追问，直到我主动点"停止反问"，
  而不是问两轮就开始按自己的猜测干活。
- 作为使用者，当 agent 遇到它不懂的专有名词 / 缩写 / 内部系统名时，它会**问我**而不是臆测含义。
- 作为使用者，只有当我确认"细节已给齐"并点"停止反问"后，agent 才会产出正式交付物。
- 作为工作流作者，跨节点反问（questioner 复核另一个节点产物并向我提问）与挂在单 agent 上的反问，**表现一致**。

## 验收标准

1. **反问激活 → 只给反问格式**：反问通道激活且非 stop 时，注入到 user prompt 的尾块**不含** `<workflow-output>`
   端口清单 / 格式示例；含强力"必须反问"指引 + `<workflow-clarify>` 格式。（self & cross questioner 均满足。）
2. **富化指引可断言**：注入文本包含"先调研后提问 / 用尽所有 skill / 问题要深入 / 所有细节敲定前不动手 /
   不懂的专有词必问 / 零臆测零默认 / 反问即正确产出"等要点（源码层文本断言 + 渲染断言）。
3. **运行时拦截**：反问激活期间，Agent 若产出 `<workflow-output>`（或 both / 既非 clarify 也非 output），
   runner 判 `failed`，错误码前缀 `clarify-required`，并触发**同会话 followup 要求改回反问**；
   重试耗尽则节点 `failed`（不静默收尾）。
4. **停止反问 → 给输出格式**：`directive='stop'` 的那次 rerun 注入 `<workflow-output>` 格式（含 inline 模式——
   此前各轮从未给过输出格式，stop 轮必须首次完整注入），Agent 产出正式输出；运行时不再拦截其 output。
5. **continue 轮指引无逃逸**：`renderClarifyDirectiveTrailer('continue')` 不再含"零未决时你可以直接输出"那条软逃逸；
   改为"本节点处于强制反问模式，下一条必须是 `<workflow-clarify>`"。
6. **cross 同步**：cross-clarify questioner 走与 self 相同的强制反问注入 + 运行时拦截（共用路径，回归测试双侧覆盖）。
7. **不回归既有契约**：无反问通道的普通 agent 节点的输出注入字节不变；stop 轮答案块（`STOP CLARIFYING` trailer）保持；
   cross-clarify designer 侧 External Feedback / update-mode 字节不变。
8. **测试齐备**：所有改动点带正向 / 边界 / 错误路径用例；改写受影响的 byte-level 回归基线并说明意图；
   `bun run typecheck && bun run test && bun run format:check` 全绿，CI 全绿。

## 决策登记（落档前与用户澄清，2026-06-18）

用户以"持续反问"方式逐轮澄清，4 个结构决策全部钉死：

- **D1 生效范围 = 全局强制·无开关**：所有反问节点一律强制 ask-back，不加节点级 `mode` 字段 / 无 schema / 无前端。
  用户已知"会改掉别人工作流的行为"并接受（与 RFC-099 多租户并存）。最简实现。
- **D2 顽固 Agent 终态 = 硬失败**：反问激活期 Agent 硬发 output → `clarify-required` 拒 → 同会话 followup 重试，
  耗尽则节点 failed。**用户知情确认其爆炸半径**：按 `decideScopeOutcome` 优先级（awaiting_human > awaiting_review >
  firstFailure），node failed 会让**整个任务 failed**（fail-all-after-join），不是"单节点跳过/重试"。不做"优雅停泊"。
- **D3 终止语义 = 纯人工停止**：只有用户点"停止反问"（`directive='stop'`）能结束反问；不加"连续 K 轮无新问题自动收尾"
  的收敛兜底。推论：含反问节点的工作流**无法无人值守**（会无限停泊等人）——有意。
- **D4 提问风格 = 优先级 + 成批 + 有后果**：preamble 引导先问最能改变产出的决策、相关问题成批、不堆砌"确认你要 X 吗"
  式琐碎确认（深度优先），而非穷举式最大覆盖。

附带（实现期定，非用户决策）：preamble 加"用 inputs/用户的语言提问"一行；`buildProtocolBlock` 去 `hasClarifyChannel`
形参降 2 参；followup 的 `port-validation` 一律走输出向 bullets（它只在 output 被接受后触发，反问激活期不可达）。

## 已知限制

- **中断的 stop（收尾）轮被 daemon 重启复活后丢失 directive**：`isClarifyRerunCause` 不含 `'revival'`
  （RFC-098 既有 `applyLatestDirective` 门），故复活的收尾轮 `directive` 被丢、回落"continue"→重新进入强制 ask-back，
  Agent **再问一轮**（用户再答 stop 即收尾）。RFC-100 前此降级因输出逃逸口而无感，现表现为"多问一轮"。罕见
  （需在收尾 rerun 完成前的窄窗重启），登记为后续可选修复（让复活保留 clarify 谱系的 directive）。
- **编辑器 Prompt 预览不传 `hasClarifyChannel`**：`PromptPreview.tsx` 一直只渲染输出格式（预览与反问节点运行时本就
  有差异，非本 RFC 引入）。本 RFC 维持现状（D1 决定无前端改动），登记为已知差异。
