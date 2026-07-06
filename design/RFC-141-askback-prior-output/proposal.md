# RFC-141 反问轮携带上轮产出（翻案 RFC-119 D6 + RFC-120 §18 改派抑制）

- 状态：Draft（2026-07-06 落档；同日用户三问拍板文案 / inline / 改派）
- 触发：用户复查任务 `01KWFZRQFPZFQQEM8JTCHQMGP5` 节点 `agent_m7p3n1` 最后一次执行（retry_index 17，
  `cross-clarify-answer`）发现 prompt 无 Prior Output，指出「这种情况也是要带啊，就算不做最终输出，
  也是要在原有输出上修改的反问问题」。

## 背景

### 现状

RFC-119 建立了泛化的重跑 prior-output 注入：任何重跑（评审 reject/iterate、手动重试、级联、恢复、
反问答复）把该节点**最新一次捕获过端口输出的 run** 渲染为 `## Prior Output (to update or
regenerate)` + `## Update Directive` 两节注入 prompt，让 agent 在旧产出基础上增量修订。

但有两个抑制门把一部分重跑排除在外：

1. **RFC-119 D6「强制反问态不注入」**（`scheduler.ts:2758` + `prompt.ts:588` 双门控）：
   `effectiveHasClarifyChannel=true`（接了 clarify 通道且用户未停）的轮次协议块是 clarify-only、
   要求 agent 只发 `<workflow-clarify>`，当年判断「注入『更新你的输出』自相矛盾」，且认为该组合
   「**正常流几乎不可能**：产出 output 需 'stop' 轮，'stop' 后 effectiveHasClarifyChannel 即 false」
   （RFC-119 design.md D6 原文）。
2. **RFC-120 §18 改派抑制**（`clarifyQueue.ts:336` 派生 `suppressPriorOutput` → `scheduler.ts:2657/2756`）：
   队列是「纯 override designer 交接」（全部 designer 条目都是别人改派来的、无一 graph-owned）时
   不注入，理由是「override target 应处理改派问题，不是改写自己的旧 artifact」。

### 失败现场（D6 前提被实证推翻）

任务 `01KWFZRQFPZFQQEM8JTCHQMGP5` 节点 `agent_m7p3n1` 共 18 次 run，`docpath` 端口产出过 4 版
（idx 9/13/14/16）。逐 run 检查 `node_runs.prompt_text`：

| retry_index | rerun_cause | 协议块 | Prior Output |
|---|---|---|---|
| 9（首次产出） | revival | 定稿 | 无（当时无旧产出，正确） |
| 10 / 13 / 14 / 15 / 16 | cross-clarify-answer / revival / questioner-rerun | 定稿 | **有**（正确） |
| 11、**17（最后一次）** | revival / cross-clarify-answer | **强制反问** | **无（D6 抑制）** |

即：cross-clarify 多轮场景下「已有产出 + 反问轮」是**常态**——节点产出草稿后，新答案触发重跑、
ask-back 仍激活，此时 agent 在 prompt 层面完全看不到自己的草稿，只能凭 `## Clarify Q&A` 的问答
记忆提问。D6 的「几乎不可能」前提不成立；反问轮的问题本该围绕「怎么改现有草稿」来提。

## 目标

1. **反问轮（强制 ask-back 激活）也注入 Prior Output**，配套**反问版强指令**（用户拍板）：明确
   「这是你上轮产出；本轮仍只许发 `<workflow-clarify>`；反问应围绕如何修改这份产出提出，不要
   重新讨论已定稿的决策；文件路径端口先读文件再提问」。
2. **改派交接轮（纯 override handoff）也注入**（用户拍板，有意推翻 RFC-120 §18 的抑制）——反问轮
   与定稿轮一并生效。
3. **inline 续跑轮维持不注入**（用户拍板维持 RFC-119 D5：session 记忆里已有，重灌浪费 token 且
   诱发陈旧锚定）。
4. 其余 RFC-119 决策（D8 文件端口只给路径 / D9 aggregator 注入、shard 不注入 / D10 iterate 限
   目标端口 / cross-clarify 互斥 / D7 无开关）逐字不变；非反问、非改派 rerun 的 prompt
   byte-identical（黄金锁）。

## 非目标

- 不改 Q&A 注入 / RFC-131 老化机制（`## Clarify Q&A` 块的内容与本 RFC 无关）。
- 不引入任何开关 / 配置项（延续 RFC-119 D7「始终开启」）。
- 不做 prior output 的多版本历史注入（仍只带最新一份）。
- 不动 followup（同会话 envelope 修复）路径——天然不注入，维持。
- 无 schema / migration。

## 用户故事

1. 设计 agent 产出 v1 设计文档后，评审者的反问答案触发它重跑且 ask-back 仍激活。它在 prompt 里
   看到 `docpath: docs/xxx.md` 和反问版指令，先读文件，然后提出「§3 的存储方案要不要按新答案换成
   SQLite？」这类**围绕改稿**的问题，而不是从零重新盘问需求。
2. 一个问题被改派给节点 B 处理。B 曾产出过自己的 artifact。B 重跑时 prompt 里带上自己的旧产出作
   背景 + Clarify Q&A 里的改派问答，处理问题时能对齐自己既有的产出，不再「失忆」。
3. inline 续跑的反问轮行为不变：session 里已有完整上下文，prompt 保持精简。

## 验收标准

1. 已有产出的节点进入强制反问轮（self-clarify / cross-clarify / 改派 handoff 任一形态），prompt
   含 `## Prior Output (your previous run's output)` + `## Prior Output Directive`（反问版文案），
   且尾部协议块仍为 clarify-only（两者共存、语义不冲突）。
2. 无产出的首轮反问不注入（`freshestPriorRunWithOutput` 找不到 → 无块，现状保持）。
3. inline 续跑轮（`resumeDecision.inlineMode`）不注入（现状保持）。
4. 纯 override 交接轮注入：反问轮用反问版指令；定稿轮用既有 `## Update Directive`。
   `suppressPriorOutput` 派生与门控整体拆除。
5. 非反问、非改派、非 inline 的 rerun prompt 与现状 byte-identical（黄金锁测试）。
6. `bun run typecheck && bun run test && bun run format:check` 全绿；相关源锁测试
   （rerun-prior-output-source-guards / rfc098 / rfc120 系列）随新语义翻转而非删除。
