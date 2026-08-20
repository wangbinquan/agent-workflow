# RFC-313 — 信封重试的会话升级（接续触顶后换干净会话再来一轮）

Status: Draft
Author: WangBinquan
Created: 2026-08-19

## 背景

RFC-042 把「模型没按信封输出」识别成可在**同会话内修复**的一类失败。判据是五条并且（`services/scheduler.ts:1659` `decideEnvelopeFollowup`）：上一次 attempt `status='failed'`、`exitCode === 0`、抓到了 native sessionId、该 run 至少有 1 条 `kind='text'` 事件、`failureCode` 命中 `FOLLOWUP_POLICY`（`shared/src/prompt.ts:1189`）。全中则下一次重试**复用同一个 runtime 会话**（opencode `--session`，`services/runtime/opencode/spawn.ts:115-116`；Claude Code `--resume`，`services/runtime/claudeCode/spawn.ts:220-221`），只发一段短纠错提示（`shared/src/prompt.ts:1314`），并**保留同一棵隔离工作树**（D17）。

这套机制的收益是明确的——模型「活干完了只是忘了收尾」时一次追问就救回来了。但它有一个从未被设计过的缺口：

**没有「换个干净会话再试」这一档。** 分叉只按上一次 attempt 的形态二选一，重试预算（`defaultNodeRetries`，默认 3）是**一条直线**烧下去的。于是在最典型的场景——agent 每次都正常退出、每次都说了话、每次都不吐信封——**3 次重试全部落在同一个会话里**，一次干净重启都不会发生；而每一次纠错提示还在往那个已经很长的上下文里继续追加。

如果根因是「上下文到顶 / 模型陷在某个循环里 / 单轮野心太大」，追问就是零收益甚至负收益的自旋——**每一次自旋都在加剧根因**。框架此刻也没有信号能识别这一点：两个 driver 都不上报 context-limit / 输出截断（已 grep 确认零命中），只能靠代理指标。

同构证据在 `docs/audit-backlog.md`：意图构建器被要求单轮产出覆盖 13 种节点的工作流，连续 3 轮 `intent-envelope-missing`（415 / 465 / 459 秒，`exitCode: 0`，会话树里连一条 assistant 文本都没有），根因判断为输出超限 / 模型没收尾；拆小后稳定成功。那条走的是 intent 线（无自动重试），但失败形态与 agent 线的自旋完全同构。

仓内还有一个**反向先例**值得对照：**workgroup 线的协议失败根本不接续**，每次都是 fresh turn（完整 prompt + 一段按 reason 定制的短 notice，`services/workgroup/turnExecution.ts:275-290`），且维护**两套独立预算**——模型协议尝试与运行时中断的 fresh-process 预算，后者「never consumes a model protocol attempt」。所以「双预算 + 分类升级」在本仓已有成例；本 RFC 不发明新范式，只是把 agent 线补齐到同一个模型上。

## 目标

- **(G1) 接续链上限**：同一个 runtime 会话内的连续接续次数达到 `defaultNodeRetries` 后不再继续追问。
- **(G2) 会话升级**：链触顶时执行一次**干净重启**——丢弃隔离工作树并从 canonical 重新分叉、铸新 `envelopeNonce`、开全新 runtime 会话、重新渲染完整 prompt（含协议块）、重新注入记忆与清单。升级次数由新增设置 `sessionRestartBudget` 约束（默认 1）。
- **(G3) 重启告知**：干净重启的完整 prompt 尾部追加一段简短的、按失败 reason 定制的告知（仿 workgroup 的 errorNotice 形态），让新会话知道上一个会话栽在哪，避免原样再犯一遍。
- **(G4) 硬顶可预期**：单次 dispatch 的总 attempt 硬上限 = `(1 + followupBudget) × (1 + restartBudget)`，默认 `(1+3)×(1+1) = 8`。`sessionRestartBudget = 0` 时公式退化为 `(1+3)×1 = 4`，**逐字等于今天的行为**——这就是本特性的关闭开关。
- **(G5) 概念对齐、代码不扩面**：script / workgroup / intent / 动态工作流四条线现状均为「每次 fresh + notice」，等价于 `followupBudget = 0`，天然落在本模型内。本 RFC 只把两套预算的概念与常量收进共享 policy 家族并在文档里说清，**不改这四条线的代码**（用户拍板）。

## 非目标

- 不改 `FOLLOWUP_POLICY` 的成员，不新增失败码，不改信封解析三件套（`detectEnvelopeKind` / `extractLastEnvelope` / `parseEnvelope`）。
- 不引入启发式抽取——仍然不从非信封文本里猜 port。
- **不新增 `node_runs` 列、不新增 rerun cause、不写 migration**：升级只落审计事件，重启行沿用 `cause='process-retry'`（用户拍板；这一选择还顺带保住了一条既有不变量，见 design §5.2）。
- 不改 `retryNode` 人工重试、review 迭代、clarify 轮次这些外层计数器。
- 不给 intent 线加自动重试——「一轮 = 一次一次性 run、无 resume」是它的显式设计（`services/intent/turnEngine.ts:3`）。
- 不试图检测 context limit：驱动侧无信号，不做猜测式判据。

## 行为变更与成本影响（逐项呈确认）

本 RFC **只增不减**，不属于 CLAUDE.md §7 的能力收缩型；但它抬高了单节点最坏成本上限，按同等标准逐条列出：

| 项                               | 现状                         | 本 RFC 默认                                                |
| -------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| 单节点最坏 attempt 数            | 4                            | **8**                                                      |
| 单节点最坏墙钟                   | 4 × 单次 attempt             | **8 × 单次 attempt**                                       |
| 单节点最坏 token                 | 1 份完整 prompt + 3 份短提示 | **2 份完整 prompt + 6 份短提示 + 2 次记忆注入 / 清单物化** |
| 隔离工作树物化次数（纯接续场景） | 1                            | **2**                                                      |
| 丢弃的磁盘成果                   | 无（接续保树）               | 升级时丢弃会话 A 的全部文件写入                            |

最后一行是本 RFC 唯一的**真实损失面**。升级按用户拍板走「丢弃、从 canonical 重新分叉」，因此若 agent 其实已经把代码写完、只是死活吐不出信封，那些改动会在升级时作废重做。取舍理由是语义干净：新会话的记忆是空白的，让它接手一棵已有改动的树，正是 D17 想避免的「模型记忆与磁盘错配」的镜像。**受影响最重的是长耗时写代码节点**；不愿承担的部署把 `sessionRestartBudget` 设为 0 即完全回到现状。

## 用户故事

- **US1（本 RFC 的主场景）**：我的 audit 节点每次都跑完、每次都输出一大段分析、就是不收信封。现状：3 次追问全在同一个越来越长的会话里，全败，节点红。改完后：3 次追问后框架换一棵干净的树、开一个全新会话、把完整任务重新发一遍并告知「上一个会话反复没能产出信封」，模型在干净上下文里一次成功。
- **US2（成果保全仍优先）**：我的 codegen 节点写完代码只是忘了信封。改完后：**前 3 次仍然是同会话追问、树不换**——磁盘成果一格没丢，第一次追问就救回来了，永远走不到升级。升级只在追问确实无效时才发生。
- **US3（成本可控）**：我跑的是每次 15 分钟的重节点，不想让最坏耗时翻倍。改完后：把 `sessionRestartBudget` 设为 0，行为与升级前逐字一致（4 次 attempt 封顶）。
- **US4（可诊断）**：节点最终还是红了，我要知道它到底试了什么。改完后：任务详情页的事件流里能看到 `[rfc313/session-restart]` 审计行（含 reason / 链长 / 已用重启数 / attempt 序号），配合既有的 `[rfc042/envelope-followup]` 行，一眼分得出哪几次是接续、哪一次是换脑重来。
- **US5（其它线不受惊扰）**：我用工作组 / 动态工作流 / 意图构建器。改完后：这三条线的行为一个字节都没变。

## 验收标准

- **AC-1（链上限）**：agent 每次均以 `envelope-missing` 收场且始终 `exitCode=0` + 有 text 事件时，同一个会话内最多发生 `defaultNodeRetries` 次接续；第 `defaultNodeRetries + 1` 次重试必须是升级而非第 4 次接续。
- **AC-2（升级的四要素）**：升级那一次 attempt 必须同时满足：隔离工作树被丢弃并重新物化（新 iso 路径）、`envelope_nonce` 与上一行不同、spawn **不带** resume 参数（全新 runtime 会话）、prompt 走完整 `renderUserPrompt` 路径（含协议块 + 重新注入的记忆块）。四条缺一即不算达成。
- **AC-3（重启告知）**：升级那一次的 prompt 尾部含一段按 `EnvelopeFollowupReason` 定制的告知；`envelope-missing` / `envelope-port-malformed` / `port-validation` / `branch-marker` / `clarify-*` 各有可区分的文案；非升级的 attempt **不得**出现该段落。
- **AC-4（硬顶）**：任何输入组合下，单次 dispatch 的 attempt 总数不超过 `(1 + defaultNodeRetries) × (1 + sessionRestartBudget)`；默认配置下即 8。
- **AC-5（关闭开关等价性）**：`sessionRestartBudget = 0` 时，attempt 序列、prompt 字节、session 复用、iso 处置与本 RFC 落地前**逐项一致**（用现有 RFC-042 测试作为不变量证据，不得修改它们的断言）。
- **AC-6（崩溃不吃重启预算）**：链中途出现 `exitCode !== 0` 的 attempt 时，接续链计数归零、但 `sessionRestartBudget` 不被消耗；后续仍可发生一次真正的升级（整体仍受 AC-4 硬顶约束）。
- **AC-7（不可重试失败不升级）**：`runtime-result-error` 与 `processUnreaped` 的现有「不重试」语义不变——它们既不触发接续也不触发升级（回归锁：`shouldRetryNodeFailure` 的既有测试保持绿）。
- **AC-8（clarify 模式翻转不算升级）**：RFC-122 的 `clarifyModeFlip`（STOP 开关翻转导致走完整 prompt）**保树、保会话**、不消耗重启预算——它与升级是两条互不相干的路径，各有独立测试。
- **AC-8b（实现门 P1-2 新增）**：框架自写的 `kind='text'` 审计事件（rfc042 / rfc049 / rfc313 三个 producer，全部写在**新铸的那一行**上）不得被计入「模型这一轮说过话吗」。否则第 1 次之后每一次 attempt 的 `agentTextCount` 恒 ≥1，RFC-042 的续跑判据当场失效——而 RFC-313 的整条形状判定正架在它上面。**归属**：该缺陷 RFC-042 就有，本 RFC 只多加了一个 producer；按用户拍板在本 RFC 内一并修。
- **AC-9（审计可读）**：每次升级在**新铸的那一行**上写一条 `[rfc313/session-restart]` 事件，payload 含 `reason` / `abandonedAfterFollowups` / `restartsUsed` / `retryAttempt`；不新增 rerun cause，不改 `node_runs` 结构。
- **AC-10（设置面）**：`sessionRestartBudget` 出现在设置页执行策略区、与 `defaultNodeRetries` 同组，边界 0–10，默认 1；未设置的存量部署取默认 1（即存量任务的最坏成本从 4 次涨到 8 次——已在上表逐项呈确认）。
- **AC-11（其它线零改动）**：script / workgroup / intent / dw 四条线的执行路径不出现在本 RFC 的 diff 里（共享常量族的纯新增除外）。
