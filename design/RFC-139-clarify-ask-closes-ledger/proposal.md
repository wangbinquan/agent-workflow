# RFC-139 反问收场的承接 run 关闭改派台账（修双台账守卫必然误杀）

状态：Draft（待用户批准）
触发：2026-07-03 本机任务 `01KWFZRQFPZFQQEM8JTCHQMGP5`（"QMGP5"，`clarifyRerunLedger.ts` 注释里
RFC-133 live-deadlock fix 点名过的同一个任务——**第二次**在台账机制上踩坑）failed 根因诊断
→ 用户「走 RFC 立档修这个缺口」。

## 背景

### 失败现场（全部从 DB / daemon.log 取证）

任务 QMGP5 是「设计节点 `agent_m7p3n1` + 反问者节点 `agent_1k2ftd`」的贪吃蛇设计文档工作流：

1. 设计节点跑完 initial + 8 轮 self 澄清（retry 0~8）。
2. 反问者节点跑完，发起 cross 反问轮（5 问）。
3. 07-02 22:53 用户答完 cross 问题 → 5 条 **cross/designer 条目** dispatch（目标 = 设计节点，
   无改派）→ mint retry 10（`cross-clarify-answer`）。
4. retry 10 被 daemon 重启打断 → revival mint **retry 11**，designer 台账的 lineage 窗口跟进。
5. 07-03 14:40 retry 11 **done，零 output port**——它没产出文档，而是发起了第 9 轮 self 澄清
   （`<workflow-clarify>` 收场；runner `kind === 'clarify'` 分支保持 status=done、不写 port，
   **该状态永久不变**——clarify-ask 永远不会变成 done+output）。
6. 07-03 14:46:37 用户答完第 9 轮提交 → 5 条 self 条目 dispatch。dispatch 门
   （`assertNoInFlightDispatch`，'in-flight' 判定）：designer 条目的承接 run（retry 11）done
   → consumed → **放行**（这正是 2026-07-01 死锁修复 + RFC-133 特意改宽的——否则多轮澄清链死锁）。
7. mint retry 12（`clarify-answer`，pending）→ scheduler 拿起 → `resolveBorrowForNode`
   （'revivable' 判定）：designer 台账 done **但无 output → 未消费 → open**；新 self 台账
   queued → open。双台账 open → `task-question-borrow-ledger-conflict` → **节点失败 → 任务失败**，
   retry 12 永远停在 pending。

### 根因

同一个「done 无 output」的承接 run，`isDispatchedEntryConsumed` 的两种判定模式给出**相反结论**
（`packages/backend/src/services/clarifyRerunLedger.ts`）：

- **'in-flight'（dispatch 门）**：done 即 consumed → 放行下一轮 dispatch。正确——done 的 run
  已终结、物理上不可能再跑、不构成 double-mint 风险；不放行则多轮澄清链死锁（QMGP5 上一次
  踩的坑，RFC-133 修掉的方向）。
- **'revivable'（borrow 守卫，`resolveBorrowForNode` 的两本台账用）**：done 必须**且有 output**
  才 consumed → done-no-output 台账**永久 open**。

于是「cross designer 修订 rerun 以新一轮 self 澄清收场」的任务**确定性地**死在下一次答题提交：
门放行 dispatch → 新台账 open → 守卫看到两本台账 → reject；而解除条件（designer 承接 run 变
done+output）永远不可能满足。上次 RFC-133 把死锁解开，水流到下一个坝，变成显式失败。

### 为什么 'revivable' 的 done-no-output→open 已无存在意义

该语义是 RFC-127「借壳」时代的遗产：done-no-output 的承接 run「什么都没产出 → 下次续跑**继续
借同一个 handler 的壳**」。但 RFC-131 T4 去借壳（move 语义）+ RFC-132 ③ 删 immediate 台账后，
`resolveBorrowForNode` 恒返回 null（scheduler.ts 注释：*"resolveBorrowForNode never returns an
agent anymore — its remaining job is the multi-ledger duplicate-execution REJECT"*）——'revivable'
判定的**唯一消费方就是双台账 reject 的 open 计数**。「继续借壳」没有了，done-no-output→open
只剩误报：把一个已终结、不欠任何 rerun 的台账算成「还有一条 pending 续跑」。

台账的职责是「这条 dispatch 欠不欠 rerun」：done 的承接 run（无论有无 output）已经**带着答案
跑过了**，欠的 rerun 还清了。「答案要不要继续注入」由独立判据 `isTargetNodeConsumed`
（RFC-131 派生老化）负责——它对 done-no-output 判「不老化、答案留队列、下一次 rerun 继续注入」，
与台账解耦，**关账不会丢答案**。

## 目标

1. 「cross designer 修订 rerun 以新一轮澄清收场 → 用户答新轮提交」不再触发
   `task-question-borrow-ledger-conflict`，任务正常续跑。deferred self/questioner 台账的对称
   形态（self 承接 run 以再问一轮收场 + 后续 designer dispatch）一并修复——两本台账共用同一
   判定函数，一处改动。
2. 双台账守卫对**真冲突**（两本台账各欠一条未执行的 rerun，如双 queued）的 reject 逐字保留。
3. failed / canceled / interrupted 承接 run 的「未消费 → open」语义逐字保留（revival/retry
   还欠着这条 rerun，台账必须开着）。

## 非目标

- **不动 dispatch 门**（'in-flight' 判定、`assertNoInFlightDispatch`、RFC-133 queued
  run-obligation 矩阵全部不变）。
- **不动注入老化**（`isTargetNodeConsumed` 的 done-no-output 不老化语义不变——那是「多轮丢
  历史」修复的根基）。
- **不动 lineage 窗口**（`resolveHandlerRun` 的框窗规则不变）。
- **不动 echo / collapse 机制**（RFC-134 / RFC-138 边界不变）。
- **不做存量数据迁移**：已 failed 的任务（如 QMGP5 本尊）不自动复活；修复落地后用户手动重试
  失败节点即可走通（守卫按新判定放行），retry 12 类 pending 行无需清理。
- 不改 `LedgerOpenMode` 的 queued（trigger NULL）分支：'revivable' 下 queued 无条件 open 是
  台账的立身之本（新 dispatch 的条目就是 pending rerun 的台账）。

## 用户故事

- 作为任务发起人，我在跨节点反问的答案触发设计节点修订、而修订跑完又追问一轮时，答完新一轮
  提交后任务应继续执行，而不是整个任务 failed、答案卡在库里。
- 作为平台维护者，双台账守卫只拦「两条互斥 cause 的 pending rerun 同时欠着」的真冲突，不把
  「一本已终结的账」误算成冲突方。

## 验收标准

1. **QMGP5 形态回归测试**（新）：designer 条目 dispatched、trigger 指向 done-no-output 承接
   run；新 self 条目 dispatched（queued）+ pending `clarify-answer` rerun →
   `resolveBorrowForNode` 不抛、返回 null。
2. **真冲突保留**：既有双台账 reject 测试（`rfc128-p5-bc-self-questioner-rerun.test.ts` 三例，
   全部 queued × queued）保持绿、不修改。
3. **revival 语义保留**：trigger 指向 failed / interrupted / pending / running 承接 run 的台账
   仍判 open（纯函数级断言）。
4. **既有测试锁按新语义翻转**：`rfc133-queued-run-obligation.test.ts` case 8 中
   `bound + done-no-output + 'revivable' → false` 的断言翻转为 `true`，注释同步改写（该行锁的
   是借壳时代语义）。
5. `bun run typecheck && bun run test && bun run format:check` 全绿；push 后 CI 绿。
6. 本机手动验证：修复部署后重试 QMGP5 的 `agent_m7p3n1` 节点，任务继续执行（第 9 轮答案 +
   cross designer Q&A 均注入 retry 12 的 prompt）。
