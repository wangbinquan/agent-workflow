# RFC-119 重跑时回灌「上一次输出」并提示更新/重新生成

状态：Draft
触发：2026-06-28 用户「如果一个 agent 已经完成过输出，当由于反问、评审等原因重跑的时候，在用户提示词里要拼上上一次输出的结果，并且提示本次应该更新或重新生成该输出」。
反问拍板（2026-06-28）：覆盖**所有重跑原因**（反问 / 评审 / 手动重试 / 级联 / 恢复）；**始终开启、无 per-agent 开关**。

## 背景

平台用框架驱动多个 opencode / claude CLI 进程作为协作 agent。一个 agent 节点会因多种原因被**重跑**：

- **反问（self-clarify, RFC-023/026）**：agent 在运行中向用户提问，用户答复后该节点重跑。
- **跨 agent 反问（cross-clarify, RFC-056）**：下游 questioner 替设计者向用户提问，答复后设计者（designer）重跑。
- **评审（review, RFC-005）**：评审节点 reject / iterate 后，被评审的上游节点（及级联下游）重跑。
- **手动重试（retry-node, RFC-052）**：用户在任务详情手动点「重试节点」。
- **级联（retry-node-cascade）**：上游被重试/变更后，下游节点重跑。
- **恢复（resume, RFC-097/108）**：任务失败 / 中断后恢复，节点重跑。

这些重跑大多会起**全新进程**（isolated session），新进程对该节点**上一次产出的内容毫无记忆**。当前现状：

- **cross-clarify 已有**「上一次输出 + 更新指令」机制（RFC-056 §6 update mode）：scheduler 把设计者上一次 done run 的各端口产物渲染成 `## Prior Output (to be updated)`，并附 `## Update Directive`，让设计者**在既有草稿上增量更新**，而不是从零重写。
- **但这套机制只对 cross-clarify 触发的重跑生效**（`scheduler.ts` 的 `isCrossClarifyTriggeredRerun` 门控）。

于是其余重跑路径存在缺口，最突出的是**评审**：

> 一个文档撰写 agent 产出 `docs/audit.md`（done）→ 评审 reject/iterate → 该节点重跑。重跑时它的 prompt 里**只有**评审的拒绝理由 / 评论（reviewContext），**看不到自己上一次写的文档本身**。agent 只能凭评论盲猜「我上次写了啥」，要么大改、要么偏离，迭代质量差。

手动重试同理：重跑时完全无上下文，agent 从零开始，丢掉上一次已经做对的部分。

## 目标

1. **统一能力**：当一个 agent 节点因任意原因重跑、且它**在本轮（同一 loop 迭代内）已经完成过一次输出**时，自动把那次输出回灌进新进程的 user prompt（`## Prior Output …` 段落），并附一段**中性的「更新或重新生成」指令**，让 agent 知道：这是你上次的产物，按下面的反馈把它**更新**好；只有当反馈要求根本性变化时才**重新生成**——无论哪种，都要在信封里吐出**完整**的更新后输出。
2. **覆盖所有重跑原因**：反问、评审 reject/iterate、手动重试、级联、恢复。
3. **复用而非新造**：直接复用 RFC-056 已有的共享原语 `buildPriorOutputBlock`；把 cross-clarify 路径里重复的「读端口产物→按 `agent.outputs` 排序→build」抽成共享 `composePriorOutputBlock`，两条路径共用——遵守本仓「抽一次别 fork」原则。
4. **零回归**：cross-clarify 既有 prompt 逐字不变；首次运行、循环的下一迭代、同会话续跑（inline / followup）、强制反问态均**不**注入。
5. **零 DB migration**：仅复用既有 `node_runs` + `node_run_outputs` 表。

### 非目标

- **不改 cross-clarify 的严格「update-only」语义**（RFC-056 有意为之、已被测试锁定）。cross-clarify 仍用其原有「Do NOT regenerate from scratch」指令；本 RFC 的中性指令只用于其它重跑路径（决策 D4）。
- **不为文件型端口（markdown_file）内联文件内容**：v1 与 cross-clarify 一致，逐字渲染 `node_run_outputs` 里存的「路径」字符串（决策 D8，含 reject+回滚 的已知边界与兜底）。内联文件正文列为 v2 文档化增强。
- **不覆盖多进程 shard 子运行**（parentNodeRunId ≠ null）：shard 从各自 diff 切片重导，不需回灌（决策 D9）。
- **不加 per-agent 开关**（用户决策：始终开启）。

## 用户故事

- **US-1（评审迭代）**：作为文档/代码 agent 的使用者，当我在评审里点「迭代」并写下「第 3 节论据不足」，重跑的 agent 能在 prompt 里看到它**上次写的完整文档** + 我的评论，于是它在原文基础上补强第 3 节、保留其余正确内容，而不是重写一篇风格迥异的新文档。
- **US-2（评审拒绝）**：当我点「拒绝」并说明方向错了，agent 看到上次产物 + 拒绝理由，中性指令允许它**重新生成**——上次产物作为「不要再这样」的参照。
- **US-3（手动重试）**：当我对某个产出不满意、点「重试节点」，重跑的 agent 能看到自己上次的产物，知道「在此基础上做得更好」，而非丢失全部上下文从零再来。
- **US-4（反问）**：当一个已经产出过文档的节点因后续反问答复而重跑，它能带着上次文档 + 新答复增量更新。
- **US-5（无副作用）**：节点**首次**运行、**循环进入下一迭代**、**同一 opencode 会话续跑**时，prompt 不会平白多出「上一次输出」段落（要么没有上次产物，要么会话里已含）。

## 验收标准

- **AC-1**：评审 reject/iterate 重跑某 agent 节点时，若该节点本轮有过 done 产出（即便旧 run 已被 supersede 成 `canceled`），新 prompt 含 `## Prior Output (to update or regenerate)` + `## Update Directive`（中性「更新或重新生成、吐完整结果」文案）。其中 **inline 型端口（string/markdown）回灌完整正文**；**文件型端口（`markdown_file`/`path<ext>`）回灌 worktree-相对路径**（文件在则 agent 读取、不在则按指令重新生成）。
- **AC-2**：手动重试 / 级联 / 恢复 / 反问重跑时，同样满足前提即注入；不满足前提（无上次产物）则不注入。**文件端口在回滚重跑（手动重试必回滚 / reject·resume 视配置回滚）后正文不保证可得**——块给路径 + 中性指令的「失效路径→重新生成」指引（Codex 设计 gate P2 fold，design §8/D8）；inline 端口不受回滚影响、始终完整。文件端口回滚后回灌完整正文属 v2（需存储/migration）。
- **AC-3**：**首次运行**该节点（无更早 done 产出）→ 不注入。
- **AC-4**：**循环下一迭代**（上次产出在 iteration-1）→ 不注入（按同一 iteration 判定）。
- **AC-5**：**同会话续跑**（inline clarify resume / envelope-followup）→ 不注入。
- **AC-6**：**强制反问态**（RFC-100 effectiveHasClarifyChannel=true，协议块为 clarify-only）→ 不注入。
- **AC-7**：**cross-clarify 触发的设计者重跑**仍走其原有 `## Prior Output (to be updated)` + 严格 update-only 指令，**逐字不变**（既有测试全绿），且不与本 RFC 的中性段落重复注入。
- **AC-8**：上次产出**全部端口为空**时不注入（`buildPriorOutputBlock` 返回空 → 抑制段落）。
- **AC-9**：零 DB migration；`bun run typecheck && bun run test && bun run format:check` 全绿；二进制 smoke 无模块环。

## 影响面

- 后端：`packages/backend/src/services/scheduler.ts`（新增 2 个私有 helper + 在 agent 派发处计算并透传）、`packages/backend/src/services/runner.ts`（透传新字段到 `renderUserPrompt`）。
- 共享：`packages/shared/src/prompt.ts`（`RenderPromptInput` 加字段 + 渲染分支）、`packages/shared/src/clarify.ts`（新增中性指令 / 标题常量，与 RFC-056 原语同处）。
- 前端：无（这是 agent-facing 的英文协议文案，非 UI；无 i18n）。
- DB：无 migration。

详见 `design.md`。
