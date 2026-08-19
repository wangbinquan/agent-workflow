# RFC-313 任务分解

**PR 拆分建议：单 PR**。改动面小且强内聚（一条纯策略 + 一条配置管道 + 两处接线），拆开反而会让「关闭开关等价性」这条最重要的回归锁分散在两个 commit 里无法一次验证。commit message 前缀 `feat(scheduler): RFC-313 信封重试的会话升级`。

## 子任务

| 编号 | 内容 | 依赖 | 产出 |
| --- | --- | --- | --- |
| **RFC-313-T1** | `shared/src/prompt.ts` 新增 `DEFAULT_SESSION_RESTART_BUDGET` + `RetryShapeState` / `RetryShape` / `decideRetryShape`（design §2.2 判定表，含防御分支） | — | 纯函数 + 类型 |
| **RFC-313-T2** | `rfc313-retry-shape.test.ts`：状态迁移矩阵、防御分支、`restartBudget=0` 永不 restart、`failures` 透传、硬顶算术全组合（design §8 第 1-5 条） | T1 | 单测 5 组 |
| **RFC-313-T3** | `renderSessionRestartNotice` + `RenderPromptInput.priorSessionAbandoned` + `renderUserPrompt` 尾部追加；含黄金锁（缺省时输出逐字节不变） | T1 | 渲染器 + 单测 2 组（§8 第 6-7 条） |
| **RFC-313-T4** | 配置面：`AppConfig.sessionRestartBudget`（默认 1）+ `SettingsPatch` + `settingsNumericBounds`（0-10）+ 设置页字段（贴 `defaultNodeRetries` 同组，hint 写明两旋钮共同决定 attempt 上限） | T1 | schema + 前端字段 |
| **RFC-313-T5** | 配置透传：`launchRuntimeConfig` → `task.ts` → `fusion.ts` → `routes/fusions.ts` → `SchedulerOpts` + 键白名单（design §3.2 逐点） | T4 | 管道补齐 |
| **RFC-313-T6** | scheduler 接线：`maxRetries` 改公式、两个闭包量、`decideFollowupForRetry` 改调 `decideRetryShape`、`prepareRetryAttempt` 增写 `[rfc313/session-restart]`、`runOneAttempt` 一次性消费告知 reason | T1 T5 | scheduler 改动 |
| **RFC-313-T7** | runner 接线：`RunNodeOpts.priorSessionAbandonedReason` 透传进 `renderUserPrompt` | T3 T6 | runner 改动 |
| **RFC-313-T8** | `rfc313-session-escalation.test.ts`：主场景 8 行断言、崩溃不吃预算、clarify 翻转不算升级、审计事件、记忆重注入（design §8 第 8、10-13 条） | T6 T7 | 集成测试 5 组 |
| **RFC-313-T9** | 关闭开关等价性：`sessionRestartBudget=0` 跑既有 RFC-042 / RFC-122 / malformed-port 测试全绿且**不修改其断言**；必要时只在测试 harness 里补默认值（design §8 第 9 条 / AC-5） | T6 T7 | 回归证据 |
| **RFC-313-T10** | 源码层兜底断言：`decideRetryShape` 单定义点、`scheduler.ts` 内 `restartsUsed +=` 唯一、告知段单出口（design §8 第 14-15 条） | T6 | source-grep 测试 |
| **RFC-313-T11** | 文档：`docs/workflow-yaml.md` 的重试段补两个维度与关闭开关；`docs/dev-gotchas.md` 沉淀「新增配置键」通用坑（全必填 + `mergeDefaults` 回填 + 前端最小写入白名单 + 相乘旋钮撞保险丝）；共享常量族注释写清其它四条线 = `followupBudget 0` 的退化形态（G5）。**实现期修正**：`docs/env-flags.md` 只登记 `AW_*` / `AGENT_WORKFLOW_*` 环境变量，config 键不属于它，原列此文件是笔误 | T4 T6 | 文档 |
| **RFC-313-T12** | 索引登记：`design/plan.md` RFC 索引追加一行、`STATE.md` 顶部「进行中 RFC」一行 | — | 索引 |

## 关键顺序约束

- **T1 必须先于 T6**：形状判定是纯函数，先把矩阵测绿再接线，避免在 scheduler 里调试策略。
- **T9 是硬门**：它证明本 RFC 对既有部署零行为变更（只要不开旋钮）。它红了就说明形状判定或接线改变了默认路径，不得以「新行为更好」放行。
- **T10 先于 declare done**：预算类逻辑最容易在后续 RFC 里被"顺手多给一次"，源码锁是唯一能拦住的手段。

## 验收清单（逐条对应 proposal.md 的 AC）

- [ ] AC-1 链上限：第 `defaultNodeRetries + 1` 次重试是升级而非第 4 次接续 —— T8
- [ ] AC-2 升级四要素（丢树 / 新 nonce / 无 resume 参数 / 完整 prompt）—— T8
- [ ] AC-3 告知按 reason 定制、非升级 attempt 不出现 —— T3 T8
- [ ] AC-4 硬顶 `(1+F)(1+R)` 全组合成立 —— T2
- [ ] AC-5 `sessionRestartBudget=0` 与落地前逐项一致 —— T9
- [ ] AC-6 崩溃归零链长但不吃重启预算 —— T2 T8
- [ ] AC-7 `runtime-result-error` / `processUnreaped` 语义不变 —— 既有测试保持绿
- [ ] AC-8 clarify 翻转不算升级 —— T8
- [ ] AC-9 审计事件字段齐全、不新增 cause / 列 —— T8
- [ ] AC-10 设置项出现在设置页、边界 0-10、默认 1 —— T4
- [ ] AC-11 其它四条线不出现在 diff 里（共享常量族纯新增除外）—— code review 逐文件核对
- [ ] `bun run gate:local` 全绿
- [ ] 推后按 exact SHA 查 CI（含 superseding commit 归属规则）
- [ ] Codex 双门：设计门（本文档请批前）+ 实现门（declare done 前），findings 分「纯实现我改」与「涉及设计方向请用户定」两堆
