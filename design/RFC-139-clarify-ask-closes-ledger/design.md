# RFC-139 技术设计：反问收场的承接 run 关闭改派台账

## 0. 改动一览

**唯一生产代码改动**：`packages/backend/src/services/clarifyRerunLedger.ts` ——
`isDispatchedEntryConsumed` 的 bound（trigger 非 null）分支，'revivable' 模式对
done-no-output 承接 run 的判定由「未消费（open）」改为「已消费（consumed）」：

```ts
// 现状（:135-136）
if (hr === null || hr.status !== 'done') return false
return mode === 'in-flight' ? true : hr.hasOutput

// 改后
if (hr === null || hr.status !== 'done') return false
return true // done（无论有无 output）= 已消费；两种 mode 在 bound 分支合流
```

外加同文件头部 `LedgerOpenMode` 文档注释改写（§4）。零 migration、零新端点、零 schema 变更、
零前端改动。

## 1. 机制现状（三方关系）

同一个 oracle `isDispatchedEntryConsumed(entry, runs, lineageViews, mode)` 服务两个消费方：

| 消费方 | mode | 位置 | 职责 |
|---|---|---|---|
| dispatch 门 `assertNoInFlightDispatch` → `findOpenDispatchTarget` | `'in-flight'` | `taskQuestionDispatch.ts:867` | 拒绝「目标节点还欠着一条未完成 rerun」时的新 dispatch（防 double-mint） |
| borrow 守卫 `resolveBorrowForNode` 的两本台账<br>`resolveDeferredSelfQuestionerBorrowForNode` / `resolveDesignerBorrowForNode` | `'revivable'` | `taskQuestionDispatch.ts:1142` / `:1224` | 数同一 home+iteration 上 open 台账数，>1 → `task-question-borrow-ledger-conflict`（防两条互斥 cause 的 pending rerun 重复执行） |

bound 条目的承接 run 由 `resolveHandlerRun`（`packages/shared/src/task-questions.ts:393`）按
**lineage 窗口**解析：窗口 = `[triggerRunId, 下一条 NEW_CLARIFY_TRIGGER_CAUSES rerun 的 id)`，
取窗内 freshest top-level run。关键性质：**新 mint 的 clarify-answer rerun（QMGP5 的 retry 12）
自身就是窗口上界**——designer 台账精确解析到自己的承接 run（retry 11），不会把别的台账刚 mint
的 pending run 误认成自己的。这保证了本修复的判定对象恰是「本台账自己的承接 run 的终态」。

两种 mode 的判定矩阵（现状）：

| 承接 run 状态 | 'in-flight'（门） | 'revivable'（守卫） |
|---|---|---|
| queued（trigger NULL） | run-obligation / mintCause 条件判定（RFC-133） | **open（无条件）** |
| pending / running | open | open |
| failed / canceled(非 supersede) / interrupted | open | open |
| done + output | consumed | consumed |
| **done 无 output** | **consumed**（2026-07-01 死锁修复） | **open** ← 本 RFC 唯一改动 |

## 2. 缺口的形式化

设节点 N 上有 designer 台账 D（bound，承接 run R）与即将 dispatch 的 self 轮 S：

1. R 以 `<workflow-clarify>` 收场 → runner `kind === 'clarify'` 分支保持 `status='done'`、
   不写 output port（`runner.ts` ≈1315-1327），且该状态**永久**（done 的 run 不参与
   revival/retry；下一轮是全新 mint 的 node_run）。
2. 门（in-flight）：D consumed → S 的 dispatch 放行 → S 条目盖 `dispatched_at` + mint
   frontier rerun R'（`clarify-answer`，pending）。
3. 守卫（revivable）：D 的承接 run done-no-output → **open**；S queued → open →
   `openLedgers.length === 2` → throw → `scheduler.ts:2131-2138` 转节点失败 → `runTask` 收
   任务 failed。R' 永远 pending。
4. 解除条件「D 的承接 run 变 done+output」不可满足（①R 终态永久；②窗口上界=R' 自己，R' 又
   被本守卫挡死——循环依赖）。

∴ 该形态**必然失败**，非 race。deferred self/questioner 台账与 designer 台账角色互换后同构
（两本台账同一 oracle，对称成立）。

## 3. 修复语义论证

**台账的不变量**：一本 open 台账 ⇔ 该 dispatch 还欠一条「未执行完的 rerun」。

- done（无论有无 output）：承接 run **带着答案执行完了**。无 output 只说明它以再问一轮收场
  ——续跑义务已由新轮次的条目（新台账）接管。本台账不欠了 → consumed。
- failed / canceled / interrupted：revival/retry 会在**同一窗口内**续跑（revival cause 不在
  `NEW_CLARIFY_TRIGGER_CAUSES`，不构成上界——QMGP5 的 retry 10→11 正是这样被窗口跟进的），
  这条 rerun 还欠着 → open。**保留**。
- queued：rerun 还没 mint 或刚 mint，全欠着 → open。**保留**。

**为什么答案不会丢**（关账 ≠ 老化）：prompt 注入走 `selectAgentQueue` → 按
`isTargetNodeConsumed`（`clarifyRerunLedger.ts:241`，RFC-131 派生老化）决定条目是否还渲染进
队列。该判据对 done-no-output 判 **FALSE（不老化）**——「答案留队列、下一次 rerun 继续注入」
（多轮丢历史修复的根基，本 RFC 不动）。QMGP5 修复后重演：retry 12 起跑时 designer 5 条 Q&A
因未老化照常注入，叠加第 9 轮 self 答案——语义正确。

**为什么改守卫而不是改门**：门的 done=consumed 已经是对的（不放行则死锁，QMGP5 第一次踩坑
已证）；真正过期的是守卫侧借壳时代的 hasOutput 条件（§proposal「为什么已无存在意义」）。

**为什么不干脆删掉 mode 参数**：queued 分支两 mode 语义仍然不同（'revivable' 无条件 open vs
'in-flight' 的 RFC-133 run-obligation 矩阵），必须保留。本改动把 mode 分歧从两处收窄到一处
（queued），bound 分支合流。

## 4. 注释 / 文档随动

`clarifyRerunLedger.ts` 头部两段 doc comment 是行为规格，必须与代码同步改写：

- `:41-54`（`LedgerOpenMode` 注释）：现状写「They agree on everything EXCEPT a done-NO-output
  continuation」——改为「They agree on every **bound** state; the ONLY divergence is the
  QUEUED branch」。原 'revivable' 段引用的 *"locked by the RFC-127 'done but emitted NO
  output → still open (keeps borrowing)' test"* 已随 RFC-132 去借壳失效（rfc127 两个测试文件
  中已无此测试；现锁在 `rfc133-queued-run-obligation.test.ts` case 8），引用一并更新为本 RFC。
- `:76-85`（done-NO-output 分歧段）：改写为单一语义 +「QMGP5 第二次踩坑」case 引用
  （任务 id 已在 :65 出现，保持可追溯）。
- `taskQuestionDispatch.ts:967-990`（resolveBorrowForNode 的 RFC-127 borrow authority 大注释）
  中「done+output => consumed, drop borrow; queued / failed / outputless => keep borrowing」
  两处措辞同步改为「done => consumed; queued / failed / interrupted => keep」。

## 5. 失败模式分析（修复引入的新风险）

| 风险 | 分析 | 结论 |
|---|---|---|
| A. designer 答案未消化就关账 | 关账只影响守卫计数；注入由 `isTargetNodeConsumed` 独立判定（done-no-output 不老化，答案留队列） | 无丢失（验收 6 手动确认） |
| B. 削弱真冲突 reject | queued→open 逐字不变；done-no-output 的 run 物理上不可能再跑，本就不构成 duplicate execution 的一方 | reject 的保护面不变（验收 2） |
| C. 窗口内混合终态（如 failed 后 revival done-no-output） | freshest 取窗内最大 id，revival 的 done-no-output 是最新态 → consumed；符合「义务已履行」 | 正确 |
| D. fanout 子 run 干扰 | `resolveHandlerRun` 只取 top-level（`parentNodeRunId===null`），不变 | 无影响 |
| E. 门与守卫的第三处消费方漂移 | 'revivable' 全仓生产调用点仅 `:1142` / `:1224`（本 RFC 已 grep 确认）；测试断言随动 | 无隐藏消费方 |
| F. done-no-output 但**不是** clarify-ask（模型忘发 envelope） | 不存在——runner 对无 envelope 收场判 `failed`（`no <workflow-output> envelope found`），done-no-output 唯一来源就是合法 clarify-ask | 状态空间闭合 |

## 6. 测试策略（随改动落地，缺一不可）

新文件 `packages/backend/tests/rfc139-clarify-ask-closes-ledger.test.ts`，顶部注释链接本 RFC +
QMGP5 任务 id（回归锚点）：

1. **纯函数矩阵**（`isDispatchedEntryConsumed`，bound 分支）：
   - `'revivable'` + done-no-output → **true**（本 RFC 核心，新语义）；
   - `'revivable'` + done+output → true（不变）；
   - `'revivable'` + failed / interrupted / pending / running → false（revival 语义保留）；
   - `'revivable'` + queued → false（无条件 open 保留）；
   - `'in-flight'` 对应各档全部不变（防对门的意外破坏）。
2. **QMGP5 集成复现**（`resolveBorrowForNode`，in-memory db）：designer 条目 dispatched +
   trigger 指向 done-no-output run；self 条目 dispatched（queued）+ pending `clarify-answer`
   rerun → 不抛、返回 null。这是主回归 case（修复前红、修复后绿）。
3. **对称 case**：self/questioner 台账 bound→done-no-output + designer queued → 不抛。
4. **真冲突仍 reject**：designer queued + self queued 同 home → 仍抛
   `task-question-borrow-ledger-conflict`（与既有 rfc128-p5-bc 三例互为冗余锁，故意保留双份）。
5. **既有锁翻转**：`rfc133-queued-run-obligation.test.ts` case 8 `:159` 断言
   `'revivable'` + doneNoOut 由 `false` 翻 `true`，标题/注释改写并指向本 RFC（锁的原语义随
   借壳废弃）。同文件其余断言（含 `:79` queued-revivable、`:147` mintCause-ignored、`:161`
   done+output）逐字不动。
6. **门不回归**：`assertNoInFlightDispatch` 相关既有测试（rfc133 矩阵 case 1-7）零修改跑绿。

## 7. 依赖与兼容

- 依赖：无新依赖；不触碰 shared 包导出面（`resolveHandlerRun` 不动，单二进制 build 无模块环
  风险，仍按惯例跑 `bun run build:binary` smoke）。
- 向后兼容：判定是读时派生（无落库状态），部署即生效；存量 failed 任务重试失败节点即走新判定。
- 多人并发：改动集中在 `clarifyRerunLedger.ts` + 一个测试文件 + 两处注释，与当前 working tree
  上其他 RFC 的改动面无交集。
