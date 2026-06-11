# RFC-096 — 技术设计

行号基线：`f39664d`（2026-06-11）。落档前事实核查（专项 agent，全部 file:line 实证）结论已
并入；实现前按惯例复核行号。

## 1. 比较器下沉（freshness.ts）

- `isFresherNodeRun`（scheduler.ts:455-461）与 `buildFreshestDonePerNode`（:964-978，未导出）
  移入 freshness.ts 并导出；isFresherNodeRun 形参放宽为泛型 `<R extends { id: string }>`
  （它只比较 id——对抗检视缺口 2：options-T1 的 RepairNodeRunRow 无 parentNodeRunId 列，
  全行类型过不了 typecheck）；scheduler.ts 改 import 并保留
  `export { isFresherNodeRun } from '@/services/freshness'` 兼容层（6 个测试文件 from
  '../src/services/scheduler' 零改动）。
- review.ts:67 改 `import { isFresherNodeRun } from '@/services/freshness'` ——
  scheduler↔review 环断一半（review.ts:66↔scheduler.ts:81 的另一半不在本 RFC）。
- scheduler.ts:991-994「放这里避免 import cycle」注释失效，删除。

## 2. 共享 picker（freshness.ts）

```ts
export interface PickFreshestOpts {
  /** 排除 fan-out 子行（parentNodeRunId !== null）。默认 true。 */
  topLevelOnly?: boolean
  /** 仅这些状态参与挑选；缺省 = 不滤 status。 */
  statusIn?: readonly string[]
}
export function pickFreshestRun<
  R extends { id: string; parentNodeRunId: string | null; status: string },
>(rows: readonly R[], opts: PickFreshestOpts = {}): R | undefined
```

实现 = 单趟扫描 + isFresherNodeRun。nodeId / iteration 谓词留在调用方 SQL WHERE（picker 不做
分组——需要 per-node map 的调用方继续用 buildFreshestDonePerNode 形态）。

机械迁移（行为零变化，回归网为证）：

- review.ts:315-326 `pickFreshestReviewRun` 内部改为两次 pickFreshestRun（reuse:
  `{topLevelOnly:true}`；latestDone: `{topLevelOnly:true, statusIn:['done']}`），保留导出薄壳。
- review.ts:384-400 `sourceRun` → `{topLevelOnly:true}`（**不加 statusIn**——:401 的
  `status!=='done'` post-check 是显式失败语义，过滤化会静默降级为读旧 done 行）。
- review.ts:1681-1705 applyReviewDecision `latest` → `{topLevelOnly:true}`（supersede 有意
  不滤 status）。
- scheduler.ts:1891-1900 `priorDoneDesigner` → `{topLevelOnly:true, statusIn:['done']}`
  （rows 已 done-only，等价）。
- scheduler.ts:815-827 commit&push 归属挑行（对抗检视缺口 1——proposal 列了、初版 design 漏了）：
  SQL 改取全行，内存 `pickFreshestRun(rows, {topLevelOnly:true, statusIn:['done']})`——原查询
  已 done-only，差异仅 startedAt→id 序（归属语义等价）；消掉后 src 中 `desc(nodeRuns.startedAt)`
  清零，§4 新守卫白名单为空。

## 3. 四处病理修复（各为行为变更，红→绿）

### 3.1 triggerDesignerRerun（crossClarify.ts:760-765）

`desc(startedAt)` 整段换为：SQL 只留 (taskId, designerNodeId) WHERE，内存
`pickFreshestRun(rows, {topLevelOnly: true})`。修复面（核查实证）：

- NULL startedAt 沉底 → 自家/review 铸的 rerun 行（不写 startedAt）永远选不中——id 序天然
  覆盖；
- mark-running 重写 startedAt 的排序漂移消失；
- 子行不再可选（top-level 过滤）。
- status 不滤：与 review.ts applyReviewDecision 同型——supersede/rollback 目标就是「该节点
  最新一行（无论状态）」；rollback 用 lastDesigner.preSnapshot、继承 iteration 等字段的语义
  保持，只是行选对了。
- **前置（对抗检视 1a）**：`cross-clarify-designer-retry-index.test.ts` test 3 的 fixture 用
  随机非单调 id 且注释明言依赖 startedAt 序——迁移前先把其 seedRun 改为显式单调 id
  （monotonicFactory 先例），断言语义不变；否则 id 序落地后该测试 ~2/3 概率 flaky 红。
  其余 cross-clarify 测试 seeded `nr_*` id 恒大于产线 ULID，新增用例一律显式单调 id。

### 3.2 retryNode 级联继承（task.ts:1131-1155）

`existing` 查询删 `orderBy(desc(retryIndex)).limit(1)`，改全量行 +
`pickFreshestRun(rows, {topLevelOnly: true})`：

- `nextRetry` 保守用**全行 max+1**（对抗检视 2b：现行 bug 自身可在存量 DB 铸出
  「子行/继承行 retryIndex 超 top-level」的病理形态——triggerDesignerRerun 选中子行时继承
  非 null parent 且 retryIndex bump；保守口径零成本规避 UNIQUE 撞车）。
- 继承源（仅影响非目标下游；目标节点 inherit=runRow 不变，但其 nextRetry 同样换保守口径）
  不再可能是 shard 子行 → 占位行 `parentNodeRunId` 恒 null / iteration 取该节点最新
  top-level 行的 iteration——级联占位行恢复 frontier 可见。
- **prev=undefined 形态（对抗检视 2b-2）**：fanout 内层节点可能只有子行、无 top-level 行——
  picker 返回 undefined 时维持现行 `?? 0` 兜底（占位行落 iteration 0 / 全新顶层 failed 行）：
  该行对顶层 scope 惰性（inner 不在顶层 scope，wrapper 重派走 priorChildren），与现行行为
  等价、不引入新害；显式注释并配用例锁定惰性。
- 遗留混合帧（对抗检视 2c，不修只记）：对旧迭代历史行 retryNode 时「目标占位=runRow 旧
  iteration、下游占位=最新 iteration」——现行已存在，本 RFC 不引入也不解决，入 §5。

### 3.3 readPortAtIteration（scheduler.ts:3776-3814）

挑行循环加 `if (r.status !== 'done') continue`（与 buildFreshestDonePerNode :975 对齐）；
:3793-3802 过期三元组注释删除并改述 done-only 语义。修复面：同 iteration 的更新非 done 行
（pending rerun / running）不再把端口读成 `''` → loop `port-empty` 不误退出、wrapper 输出
不被 `''` 覆盖、output 快照不落空。已核实非 done 行恒无 outputs（runner 仅 done 时持久化
ports），现行 '' 即「查 outputs 落空」。非目标声明（对抗检视 3a）：竞态窗内被跳过的 pending
rerun 行在 loop 推进后无人消费（orphan）——本 RFC 仅改读值口径与 RFC-074 对齐，orphan 行
的消费归 wrapper 语义后续（boundary 读不写 consumed 的缺口同记）。

### 3.4 options-T1.ts:63

`group.reduce(retryIndex 最大)` → `group.reduce(id 序)`（直接用 isFresherNodeRun，import 自
freshness）。:62-63 注释同步（options-S3.ts:62-63 的"highest retryIndex"失实注释顺手修，代码
本身已 id 序）。

### 3.5 死代码

删 `lifecycleRepair/helpers.ts:33-43 loadNodeRunsForNode`（零调用点，git 史实证从未被调用）。

## 4. 守卫（s13 翻转 + 新增）

- s13 按各 [FLIP-ON-FIX]：G1 → 比较器移籍 freshness.ts（scheduler 仅 re-export）；G3 →
  task.ts `desc(nodeRuns.retryIndex)` 清零；G5 → loadNodeRunsForNode 不存在；G6 → 全 src
  `desc(nodeRuns.retryIndex)` 清零（lifecycleRepair/helpers.ts 删除后达成）。
- 新增守卫：① `desc(nodeRuns.startedAt)` 在 src 中清零（§2 commit&push 收敛后白名单为空）；
  ② 内存 retryIndex 比较模式（`retryIndex > ` reduce 形态）的启发式 grep——宁可白名单宽松
  也要让新 fork 至少被 review 看见。
- **G5 实现坑（对抗检视 5）**：s13 的 extractSection 在 loadNodeRunsForNode 删除后会直接
  throw（找不到 start marker），不是断言翻 false——G5 守卫改写为「该函数名在文件中零出现」
  或整体删除，不能机械「翻转期望」。

## 5. 失败模式

| 风险                                                   | 缓解                                                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 改变 designer rerun 的选行使某些既有场景选到不同行 | cross-clarify 全套回归 + 专项 red 测试（NULL startedAt 新铸行 / 重派漂移行两形态）；语义上 id 序选行是 resumeTask 修复时已确立的权威口径 |
| 3.2 nextRetry 口径差异                                 | 实现时先跑 retry-cascade-kind-matrix 等既有用例；如出现子行 retryIndex 反例改保守口径（设计已预留）                                      |
| 3.3 done-only 改变 loop 退出行为                       | 既有 exit-condition / loop 用例全绿为界；red 测试限定「同迭代存在更新非 done 行」的新形态                                                |
| 比较器移籍破坏 import                                  | scheduler 一行 re-export + typecheck + 全量；freshness 是纯模块无环风险                                                                  |
| review 迁移引入谓词漂移                                | §2 表逐点列谓词；sourceRun 的 post-check 红线写死在设计与测试注释                                                                        |

## 6. 测试策略

1. freshness 名下新增 `rfc096-pick-freshest.test.ts`：picker 谓词矩阵（topLevelOnly ×
   statusIn × 空集/全子行/混合）、与 isFresherNodeRun 基线一致性。
2. 病理修复 red→green：
   - `rfc096-designer-rerun-pick.test.ts`：铸 NULL-startedAt rerun 行 + stale 高 startedAt
     行 → 断言选中前者（修前红）；病理行（子行 / 其他 iteration 高 startedAt）不被选。
   - `rfc096-retry-cascade-inherit.test.ts`：fanout 子行为最高 retryIndex 时 retryNode → 占位
     行 parentNodeRunId=null、iteration=top-level 最新（修前红）。
   - `rfc096-port-read-done-only.test.ts`：loop 内 port-empty 条件 + 同迭代新铸 pending 行 →
     不误退出（修前红）；output 绑定不落 `''`。
   - options-T1：扩展既有 lifecycleRepair T1 用例（clarify-rerun shadow 场景）。
3. s13 守卫翻转 + 新守卫。
4. 回归网：cross-clarify 全套、review 全套、lifecycleRepair 全套、loop/exit-condition 用例、
   6 个 isFresherNodeRun 测试（零改动）、全量套件。
