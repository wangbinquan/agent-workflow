// RFC-359 W5 —— **双引擎判据缺口**的具名 exact 账本（只降不升，逐字相等）。
//
// # 这份账本是什么
//
// 本轮对 SQLite / PostgreSQL 的 **26 对适配器**做了逐方法只读对账，查出一批「同一件事，一侧
// 有校验、另一侧没有」的**判据缺口**。它们**都还没修**——所以这条守卫落地当天就是绿的，它的
// 作用不是把存量照红，而是把这些缺口从「某次分析的口头结论」变成**可计数、有署名、只降不升**
// 的账本：
//
//   · **新增缺口 ⇒ 红**。又有人只在一个引擎上加了判据，守卫立刻要求你要么两侧都加，要么把
//     新缺口写进账本并说明为什么允许它存在。
//   · **缺口被补上 ⇒ 也红**。缺的那一侧出现了判据，守卫报「这条已补，请从账本删除」——每修
//     一条就必须改一次账本，于是每次收敛都留下一次有署名的提交记录。这是 RFC-359 要的
//     forcing function：「不允许再出现两种数据库一个好一个不好的分支」不能靠人记得。
//   · **锚点漂移 ⇒ 还是红**。见下文「为什么它抗重构」。
//
// RFC-359 收敛完后这份账本应当清空：届时把 `DUAL_ENGINE_PREDICATE_GAPS` 改成 `[]`，判据自然
// 就是钉 0。
//
// # 判据机制：两个方向都断言的「存在性探针」
//
// 一条缺口 = 一个探针，同时断言两件事：
//
//   1. **有判据的那一侧仍然有**（`present` 站点的每个锚点都必须命中）——防的是「锚点漂了但
//      守卫还绿」这个假绿：如果 SQLite 那边把 `assertNotBuiltin` 改名 / 挪走，探针不会因为
//      「两边现在都没有了」而误判成「缺口消失」，它会红并指名是哪个锚点漂了。
//   2. **缺判据的那一侧仍然没有**（`absent` 站点的每个锚点都必须**未**命中）——这是缺口本身。
//
// 只断言第 2 条是不够的：一个被删空 / 改名的文件天然满足「没有这个判据」，账本会静默变绿而
// 缺口其实还在（或者已经不再有意义）。所以每条还带第 3 条:
//
//   3. **`context` 语料下限**：`absent` 站点必须仍然含有若干「对应代码路径还活着」的锚点。
//      文件被删 / 函数被改名 / 那段逻辑被搬走时，探针红在「语料消失」而不是静默通过。
//
// # 锚是**按函数作用域**匹配的——补缺口时要注意（RFC-359 W7 实撞）
//
// 每条缺口的锚点写的是「某个**函数体内**必须/不得出现某标识符或字面量」。于是补缺口时
// 有一种写法会让守卫**看不见你补了**：把判据抽成一个辅助函数再调用它。
// 行为完全正确，但被点名的那个函数体里不再出现该标识符，`absent` 断言照旧成立，
// **账本静默保持绿**——收敛发生了却没有留下销账记录，而这条守卫的全部意义就是强制留下记录。
//
// W7 补 `01a` / `01b` / `02` 时第一版正是这么写的（抽了 `assertWorkflowNotBuiltin` /
// `assertChildCallRowDrivable`），实测账本没红；改成在被点名的函数体内直接出现
// `assertNotBuiltin` / `'call-row-finalized'` 之后才按设计变红并给出销账指令。
//
// **规矩**：补一条缺口后，**先确认这条守卫真的红了**再去改账本。它没红有两种可能——
// 你没补上，或者你补的位置守卫看不见；两种都不该直接往下走。
// （想抽辅助函数是合理的，那就把锚点一起改成新的形状，让账本跟着那次重构走。）

// # 为什么它抗重构
//
//   · **锚在语义标识上，不锚行号**。行号一定会漂；锚点是错误码字面量（`call-row-finalized`）、
//     具名函数（`assertNotBuiltin` / `finalizeCanceledTaskWithoutDriver` /
//     `withTaskReviewMutationLock`）、具名参数（`lockProof`）——这些名字改了，说明语义真的动了,
//     那就**应该**红一次让人来对账。
//   · **用 AST，不用文本 grep**。本仓实测过这个坑（`docs/dev-gotchas.md`）：行正则会把讲这条
//     规则的**注释**记成命中，也会把「只剩注释里提了一嘴、真代码早没了」记成还在。这里
//     `identifier` 只数 `ts.Identifier` 节点、`literal` 只数字符串字面量节点，注释和文档天然
//     不参与判据——两个方向都准。
//   · **作用域锚在函数上，不锚整文件**。缺口往往是「同一文件里 A 函数有、B 函数没有」（例如
//     PG 的 resume 有 `call-row-finalized` 门、retry 没有；PG 的 `finalize` 收了 `lockProof`、
//     `resolveCodeHostMutations` 没收）。整文件判据在这些条目上会直接判错。函数名解析本身也是
//     一个抗漂移锚点：函数被改名 / 被删 / 出现同名歧义，探针都红并指名道姓。
//   · **文件路径变了也要报出来**：`corpus floor` 用例逐条检查两侧文件存在且非空，改名 / 删除
//     一律红，不会静默失效。
//
// # 账本里每条缺口的用户可见后果（一句话，逐条也写在 `consequence` 字段里）
//
//   03/04/05/08
//           【RFC-359 W8（1a099379c）已从账本删除】当时只从 `DUAL_ENGINE_PREDICATE_GAPS`
//           里删了行，忘了从这份清单里一并删掉，于是留下四条指向**不存在的条目**的后果说明。
//           这里补删；内容不再复述，要考古看那次提交的 diff。
//   06      【RFC-359 W9 已销账 —— 记载不实】见下文「W9 销账」第一条。
//   07      【RFC-359 W9 已改判 —— 记载不实，转入 ACCEPTED】见下文「W9 销账」第二条。
//   10      【RFC-359 W8-A 已销账】归档维护命令合一为
//           `modules/task-execution/infrastructure/taskArchiveMaintenanceCommand.ts`，
//           恢复按强侧（SQLite）读 cleanupPlan 的 archiveRoot 围栏；对拍见
//           `tests/rfc359-w8-task-archive-conformance.test.ts` 的
//           「recover leaves claims frozen against a different archive root untouched」。
//   12      【RFC-359 W8-A 已销账】5 道亲子准入门抽成
//           `modules/task-execution/domain/childLaunchAdmission.ts` 的一份中立判定
//           （`childLaunchAdmissionIssue`，判定顺序也定死在那里），PostgreSQL 的
//           `assertParentAdmission` 与 SQLite 的 `startTaskImpl` 各自在自己的铸行事务内
//           读同样的两条行快照、调同一份判定；同一次子启动两侧同码同判。对拍见
//           `tests/rfc359-w8-child-launch-conformance.test.ts` 的 `parent admission — …`
//           一族 + 「reports the first failing gate identically on both engines」。
//   13a     SQLite 上资源包恢复不校验 committed receipt，回执缺失 / 错配也照样 roll-forward。
//           【RFC-359 W9 已裁决：**保留缺口，且明确不要照抄 PG 的门**】见下文「W9 裁决」。
//   13b     【RFC-359 W9 已销账，且原记载有一半不实】见下文「W9 销账」。
//
// # RFC-359 W7 销账：17 → 10（两种成因，别混成一句「已收敛」）
//
//   **一、PG 侧补上了判据**（守卫报「缺口已补」，给出逐条销账指令）：
//     01a  内置工作流在 PG 上可被手动执行  —— `assertManualExecutionAllowed` 补 `assertNotBuiltin`
//     01b  内置工作流在 PG 上可被 sync    —— `syncWorkflow` 同上
//     02   父调用节点已终结的子任务 PG 上仍可 retry —— `retryNode` 补 `call-row-finalized` 门
//   补这三条时踩过一个坑：把判据抽成辅助函数会让守卫**看不见**（见上文「锚是按函数作用域匹配的」）。
//
//   **二、这一对合了，缺口不复存在**（锚点文件随合一删除，走「语料消失」那条断言）：
//     09   PG 评审派发无锁无事务
//     11a  PG 封存 clarify 轮次用未翻转的 round 做 reconcile
//     11b  PG 上 `askingNodeId` 为空也照写 stop 指令
//     11c  PG 上 answers 非数组时不报 `clarify-answers-not-array`
//   这四条的 absent 侧都是 `postgresqlCollaborationRuntimeMechanics.ts`，该文件已随
//   `CollaborationRuntimeMechanics` 合一整体退役，两个引擎现在跑同一份实现。
//
// # RFC-359 W9 销账：4 → 2（两条都是**记载不实**，不是修好了）
//
// 两条都先按「写一条能演出差异的双引擎用例」去验，两条都没演出账本里写的那件事。逐条：
//
//   **06 `06-pg-source-termination-driverless-finalize`（销账，不进 ACCEPTED）**
//   账本写的是「PG 上取消一个没有 driver 的任务只改 receipt，不走任务收尾，任务停在半终态」。
//   实测不成立：W8 给 PG 的 cancel 分支补上 `resolveTerminalWorkspacePruneDecision` 之后，
//   PG 那一笔终态 CAS 就把 `status='canceled'` / `finished_at` / 错误摘要 / RFC-300 的两列
//   回收认领**一起**写了，认领也进了 `task.lifecycle-transitioned.v1`。SQLite 侧那句
//   `finalizeCanceledTaskWithoutDriver` 是同一件事的**快路径**，不是 PG 缺的能力——真正把
//   工作树从盘上删掉的，两个引擎都是 `task-workspace-prune-nudge`
//   （`application/taskLifecycleConsumers.ts`）那个持久消费者，两个 bootstrap 都接了它。
//   判据因此不是「本次调用返回前 `workspace_pruned_at` 有没有落章」，而是「认领进没进事件、
//   共享消费者认不认它」——`tests/rfc359-w8-source-termination-conformance.test.ts` 的 ④ / ④b /
//   **⑮**（新增：把事件喂进真正的消费者定义，断言两个引擎都会叫醒回收）逐条锁住。
//   这一条留在 GAPS 里只会让「还欠多少」读大一格，所以删掉而不是挪进 ACCEPTED：SQLite 那句
//   快路径不需要被钉形状，删了它也不改变任何用户可见结果。
//
//   **07 `07-pg-source-termination-cas-race-recovery`（记载不实 → 改判为已裁决分叉）**
//   账本写的是「PG 上状态 CAS 竞态直接抛 409」。实测**不成立**：PG 的 `applyOne` 整笔跑在
//   `withPostgresqlSerializableTaskExecution` 里，并发终态写让那条 UPDATE 撞上
//   `could not serialize access due to concurrent update`（40001），中立会话**重放整笔**，
//   第二遍读到赢家的状态、走 already-terminal 分支收场——投递方一个 409 都收不到。
//   真正的差额在**收据**，而且弱侧是 SQLite：它按开工前那次读报 `priorStatus='running'` /
//   `cancelOutcome='canceled'`，于是投递详情说「这次取消了它」，而任务实际是别人写成的 `done`
//   （`webhook_delivery_*` 读面直出这两个字段）。已按强侧（PostgreSQL）抬齐：SQLite 的 catch
//   分支复读赢家状态后，收据按赢家出。抬齐后两侧逐字相同，剩下的只是**机制**不同
//   （手写 CAS-loss 复读 vs 引擎级序列化重试），于是转入 `ACCEPTED_DUAL_ENGINE_DIVERGENCES`
//   并把两侧形状都钉住。红时用户看到什么、以及抬齐前 SQLite 那半为什么是错的，见
//   `tests/rfc359-w8-source-termination-conformance.test.ts` 的 **⑯**。

// # RFC-359 W9 销账：2 → 1（13b —— 真缺口，已补；但原记载有一半不实）
//
// **补上的那一半（真缺口）**：SQLite 的 `publishStagedVersion` 从头到尾**不读
// `skills.content_version`、也不看技能行还在不在**，无条件 `swapInStaged`。崩溃到收敛之间用户
// 完全可能又发布了一版或把技能删了，于是三格全部静默走错：
//   · 账面更新 ⇒ **陈旧代际被换回 live**，`content_version` 还写着新的，磁盘与账面从此对不上；
//   · 技能已删 ⇒ 已删技能的 `skills/{id}/files` **原地复活**成一棵没有数据库行的孤儿树；
//   · 账面更旧 ⇒ 库根本不认识的代际被换进 live 并**报成功**。
// 修法：四分支判定抽成中立的 `modules/resource-catalog/domain/resourcePackageSkillRecovery.ts`
// （`resourcePackageSkillRecoveryDisposition`，纯算术、零引擎差异），**两个引擎调同一份**——
// PostgreSQL 侧的 `postgresqlResourcePackageSkillRecoveryDisposition` 退化成别名。四格 × 两引擎
// 的用户可见结果由 `tests/rfc359-w9-resource-package-skill-recovery-conformance.test.ts` 钉住
// （补之前跑过：PG 4 格全绿、SQLite 后 3 格全红，与上面逐条对上）。
//
// 销账前按本文件「锚是按函数作用域匹配的」那条规矩验过：合一确实让这条**先红**才删——守卫同时
// 报了「缺口已补（SQLite 现在含 `cleanup-superseded` / `reject-missing-generation`）」与
// 「有判据一侧锚点漂移（`postgresqlResourcePackageSkillRecoveryDisposition` 不再是函数）」两类，
// 没有出现「抽了辅助函数于是账本静默保持绿」那种假绿。
//
// **不实的那一半**：原 `consequence` 还写着「缺**路径 / 版本哈希校验**」——不成立。SQLite 两样都有，
// 只是用自己的字面量：路径是 `resource-package-skill-version-artifact-path-mismatch`
// （不是 PG 命名的 `resource-package-skill-artifact-path-mismatch`，所以 absent 锚点扫不到它），
// 哈希是换盘后校验 live 树的 `resource-package-skill-live-hash-mismatch`（PG 校验的是 version 目录，
// 位置不同、覆盖面等价）。**这两条从来不是缺口，是命名差异被 absent 锚点记成了缺口**——写
// absent 锚点时只写 PG 那侧的字面量，会把「换了个名字做同一件事」误判成「没做」。
//
// # RFC-359 W9 裁决：13a **保留缺口，并且明确不要照抄 PG 的门**
//
// 只读核对的结论有三条，合起来指向「现在补它是负收益」：
//   1. **它守的状态产品自己造不出来**：`state='committed'` 与 `receipt_json` 在两侧都是**同一条
//      UPDATE** 里一起写的（`platform/persistence/sqlite/legacyResourcePackageBundleApply.ts` 与
//      `postgresqlResourcePackageAtomicApply.ts` 的提交臂），schema 上也没有对应 check。
//      也就是说「committed 但回执缺失 / 错配」只可能来自手工改库。
//   2. **照抄 PG 的门会把一个更坏的形态一起复制过来**：PG 的 `parseReceipt` 一抛，收敛器只记一条
//      `resource-package-roll-forward-retryable` 就走，那一行**每一轮重蹈、永远收不掉**
//      （已由 `tests/rfc359-w8-resource-package-maintenance-conformance.test.ts` 锁住）。
//      给 SQLite 加同样的门 = 让两个引擎一起卡死，不是收敛。
//   3. **真正的收敛方向在另一侧**：该让「回执损坏」结算成 `failed` 而不是无限重试，那是改
//      **PostgreSQL** 的行为、且只对手工损坏的行有意义。它同时压在
//      `ResourcePackageMaintenance` 那一对「两套落盘工件格式」的裁决上
//      （`rfc359-w5-artifact-format-portability.test.ts` 的 12 格矩阵），不该由这条缺口顺手带走。
// 所以它**留在 GAPS 里**（确实还是一侧有一侧没有），但**不进 ACCEPTED**——ACCEPTED 的门槛是
// 「不得有任何用户可见的行为差异」，而损坏行上两侧一个空转一个照常 roll-forward，说得出差异。
// 下一把刀接手时：不要直接给 SQLite 补 `parseReceipt`。

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import ts from 'typescript'

import { sourceUnit, type SourceUnit } from './census'

const SRC = resolve(import.meta.dir, '..', '..', 'src')

/**
 * 锚点种类。全部走 AST 节点，注释与文档天然不参与判据。
 *
 * - `identifier`      —— 某个 `ts.Identifier` 的文本恰好等于 `text`（函数名 / 参数名 / 表名…）。
 * - `literal`         —— 某个字符串字面量的文本恰好等于 `text`（错误码 / 状态字面量…）。
 * - `literal-prefix`  —— 某个字符串字面量（含模板串各段）以 `text` 开头。只给
 *                        `` `code:${x}` `` 这种把错误码拼进模板串的写法用；用前缀而不是
 *                        `includes`，避免 `actor-replay-authorized` 误命中
 *                        `actor-replay-authorized-suspended` 这类**互为前缀**的近邻词。
 * - `condition`       —— 某个 `ts.Identifier` 出现在 `if` / 三元的**条件表达式**里。用来钉
 *                        「有没有这道判断」这种形状型判据（值被读了不算，必须被判断）。
 * - `call-arg-object` —— 存在一处对 `text` 的调用，其第 `argIndex` 个实参是**对象字面量**。
 *                        用来钉「传的是就地构造的 effective 值，还是原封不动的那个变量」。
 */
type Anchor =
  | Readonly<{ kind: 'identifier' | 'literal' | 'literal-prefix' | 'condition'; text: string }>
  | Readonly<{ kind: 'call-arg-object'; text: string; argIndex: number }>

/**
 * 一个判据站点：`file` 相对 `packages/backend/src`；`fn` 是由外到内的函数名路径
 * （`null` = 整文件）。函数名路径本身即抗漂移锚点——解析不到 / 解析到多个同名都会红。
 */
type Site = Readonly<{
  file: string
  fn: readonly string[] | null
  anchors: readonly Anchor[]
}>

type PredicateGap = Readonly<{
  /** 稳定 id；账本按它字典序排列。 */
  id: string
  /** 回指本轮 26 对只读对账的编号（1–13），一条发现可能拆成多行探针。 */
  item: number
  /** 缺判据的那一侧。 */
  missingSide: 'postgresql' | 'sqlite'
  /** 有判据的一侧：每个锚点都**必须**命中，否则 = 锚点漂移。 */
  present: readonly Site[]
  /** 缺判据的一侧：`anchors` 一个都**不许**命中（命中 = 缺口已补）。 */
  absent: Site
  /** 语料下限：`absent` 站点必须仍然含有这些锚点，证明对应代码路径还活着。 */
  context: readonly Anchor[]
  /** 一句话的用户可见后果。 */
  consequence: string
}>

/**
 * 双引擎判据缺口账本。**只降不升，逐字相等。**
 *
 * 补上一条 ⇒ 从这里删掉这一行；确需新增一条 ⇒ 在 PR 里说明为什么允许这个缺口存在。
 */
export const DUAL_ENGINE_PREDICATE_GAPS: readonly PredicateGap[] = [
  {
    id: '13a-sqlite-resource-package-receipt-gate',
    item: 13,
    missingSide: 'sqlite',
    present: [
      {
        file: 'modules/resource-catalog/infrastructure/postgresqlResourcePackageMaintenance.ts',
        fn: ['parseReceipt'],
        anchors: [
          { kind: 'literal-prefix', text: 'resource-package-committed-receipt-missing' },
          { kind: 'literal-prefix', text: 'resource-package-committed-receipt-mismatch' },
        ],
      },
    ],
    absent: {
      file: 'modules/resource-catalog/infrastructure/sqliteResourcePackageMaintenance.ts',
      fn: null,
      anchors: [
        { kind: 'literal-prefix', text: 'resource-package-committed-receipt-missing' },
        { kind: 'literal-prefix', text: 'resource-package-committed-receipt-mismatch' },
        { kind: 'identifier', text: 'parseReceipt' },
      ],
    },
    context: [
      { kind: 'identifier', text: 'receiptJson' },
      { kind: 'identifier', text: 'rollForwardArtifacts' },
    ],
    consequence:
      'SQLite 上资源包恢复不校验 committed receipt，回执缺失 / 与 journal 错配也照样 roll-forward。',
  },
]

// ---------------------------------------------------------------------------
// 已裁决分叉账本（与上面的「缺口」是**两回事**）
// ---------------------------------------------------------------------------

/**
 * 一条**被接受的**双引擎分叉：两侧形状不同，且这个不同是被裁决过、要保留的，不是欠账。
 *
 * 与 `PredicateGap` 的判据方向相反：那边是「一侧有 / 另一侧不许有」，这边是**两侧的锚点都
 * 必须命中**。任一侧变形（判据被删、函数被改名、staging 被统一）都会红，逼人回到这份账本
 * 重新对账——分叉还成不成立、`removeWhen` 是不是已经到了。
 *
 * 为什么不塞进 `DUAL_ENGINE_PREDICATE_GAPS`：那份账本的收敛动作是「补上就删掉这一条」，
 * 每一条都在等着被消灭。这里的条目不会被消灭——它们是**正确的**不同，混进去会把「还欠多少」
 * 这个数读错。
 *
 * **进这份账本的门槛：不得有任何用户可见的行为差异。** 曾经有一条
 * `retry-admission-target-status` 记在这里（SQLite 的重试准入 CAS 落 `pending`、PG 落
 * `interrupted`），理由写的是「用户可见收尾已由 `admitResume` 对齐」。实测把它推翻了：那个
 * `interrupted` 会以**终态事件**的形式广播出去，于是 PG 上多出两条真副作用——等在
 * `watchTaskTerminal` 上的父任务被假终态唤醒（RFC-243 的调用节点因此拿着一个从未发生的
 * 「子任务已结束」往下走），以及子任务并发预算被放掉一个名额、窗口里多放行一个排队的调用。
 * 那不是可接受的实现差异，是同一操作在 PG 上产出用户可见的错结果。它已经被修掉
 * （`domain/taskLifecycleCommittedEvent.ts` 的 `continuationHandoff`：中转态照旧落库照旧投递，
 * 但一律不参与终态性判据），条目随之删除。**教训：只要还说得出一句「在 X 上用户会看到 Y」，
 * 就不该往这里写。**
 */
type AcceptedDivergence = Readonly<{
  /** 稳定 id；账本按它字典序排列。 */
  id: string
  /** SQLite 侧的形状锚：**必须全部命中**。 */
  sqlite: Site
  /** PostgreSQL 侧的形状锚：**必须全部命中**。 */
  postgresql: Site
  /** 为什么这个不同是对的（而不是某一侧欠账）。 */
  why: string
  /** 什么条件成立时这一条应当被删除。 */
  removeWhen: string
  /** 用户可见后果；确实没有的也要写清「没有」以及为什么。 */
  consequence: string
}>

/**
 * 已裁决的双引擎分叉账本。**两侧锚点都必须命中**；形状变了就红。
 */
export const ACCEPTED_DUAL_ENGINE_DIVERGENCES: readonly AcceptedDivergence[] = [
  {
    id: 'retry-held-session-reap-order',
    sqlite: {
      file: 'services/task.ts',
      fn: ['retryNode'],
      anchors: [{ kind: 'identifier', text: 'reapHeldRuntimeSessionOwnersForTask' }],
    },
    postgresql: {
      file: 'modules/task-execution/infrastructure/postgresqlChildTaskLifecycleParticipant.ts',
      fn: ['rollbackForResume'],
      anchors: [
        { kind: 'identifier', text: 'runtimeSessionLeaseRows' },
        { kind: 'identifier', text: 'heldIds' },
        { kind: 'identifier', text: 'reapRun' },
      ],
    },
    why:
      '两侧都会围栏「还攥着 native runtime session 租约」的行，只是位置不同：SQLite 在 retry 的' +
      '准入延续里第一件事就做（`reapHeldRuntimeSessionOwnersForTask`），PG 放在交棒之后的 ' +
      'rollbackForResume 里、对整棵任务做同一件事。两者都发生在任何工作树写之前，围栏面 ' +
      'PG 反而更宽（整棵任务的租约行，不只被点的那一条）。',
    removeWhen:
      '两侧的重试启动分段统一时——即 PG 的 retry 不再把 `children.resume` 当作第二段' +
      '（那时 `rollbackForResume` 也就不再是 PG 做这件事的地方，本条的 PG 侧锚点会先失效并把这条红出来）。',
    consequence:
      '无。顺序差异不改变任何用户可见结果——两侧都在写工作树之前完成围栏，租约行也都会被修复；' +
      '差的只是「在 retry 里做」还是「在紧随其后的 resume 里做」。',
  },
  {
    id: 'source-termination-terminal-cas-race-recovery',
    sqlite: {
      file: 'modules/task-execution/infrastructure/sqliteSourceTerminationParticipant.ts',
      fn: ['applyOne'],
      anchors: [
        { kind: 'literal', text: 'terminal-control-source-race-winner' },
        { kind: 'identifier', text: 'revokeExactTx' },
        // 抬齐那一步本身：输掉 CAS 之后收据按**赢家**的状态出，而不是按开工前那次读。
        { kind: 'identifier', text: 'raceWinnerStatus' },
      ],
    },
    postgresql: {
      file: 'modules/task-execution/infrastructure/postgresqlSourceTerminationParticipant.ts',
      fn: ['applyOne'],
      anchors: [
        { kind: 'identifier', text: 'withPostgresqlSerializableTaskExecution' },
        { kind: 'literal', text: 'concurrent-task-transition' },
      ],
    },
    why:
      '「本次源终止的终态 CAS 输给了另一笔终态写」两侧都会复原，只是复原**机制**不同，而机制' +
      '由引擎决定：SQLite 那一笔没有可重放的事务单元（`setTaskStatus` 的读在事务外、写在 ' +
      '`dbTxSync` 里），赢家只可能在 CAS 上被看见，所以它在 catch 里复读赢家、就地把围栏 / ' +
      'owner 撤销 / intent 终态化 / 节点取消补完（`terminal-control-source-race-winner`）；' +
      'PostgreSQL 侧整笔跑在 `withPostgresqlSerializableTaskExecution` 里，同样的并发写让那条 ' +
      'UPDATE 撞 40001，中立会话**重放整笔**，第二遍从新快照读到赢家状态、走 already-terminal ' +
      '分支收场。手写 catch 在 PG 上是够不着的死分支（SERIALIZABLE 下 CAS 不会「静默不匹配」，' +
      '只会 40001），反过来把 SQLite 套进重试也无处可退——它没有第二个快照可读。',
    removeWhen:
      'SQLite 侧的源终止整笔也放进一个可重放的事务单元时（那时 catch 分支就该整个删掉，' +
      '本条的 sqlite 侧锚点会先失效并把这条红出来）；或这一对适配器合一时。',
    consequence:
      '无。RFC-359 W9 抬齐 SQLite 的收据之后两侧逐字相同：投递方都不会收到 409，任务行 / ' +
      '围栏 / 消费位 / 节点跑批 / 执行 intent 的落库结果一致，收据的 `priorStatus` 与 ' +
      '`cancelOutcome` 都按**赢家**的状态出（抬齐前 SQLite 报 `running` / `canceled`，' +
      '投递详情因此说「这次取消了它」而任务实际是 `done`——那是真差异，已经修掉）。' +
      '仅剩的差别是 `task_execution_owners.recovery_code` 记 `-race-winner` 还是 ' +
      '`-terminal`，该列不进任何路由 / 前端读面，也没有任何判据读它。' +
      '对拍见 `tests/rfc359-w8-source-termination-conformance.test.ts` 的 ⑯。',
  },
]

// ---------------------------------------------------------------------------
// AST 判据内核
// ---------------------------------------------------------------------------

const unitCache = new Map<string, SourceUnit | null>()

function unitOf(file: string): SourceUnit | null {
  const cached = unitCache.get(file)
  if (cached !== undefined) return cached
  const abs = resolve(SRC, file)
  const unit = existsSync(abs) ? sourceUnit(abs, readFileSync(abs, 'utf8')) : null
  unitCache.set(file, unit)
  return unit
}

/** 与 `probe.ts` 同口径：函数声明 / 方法 / 变量或属性上的函数表达式与箭头函数。 */
function declaredFunctionName(node: ts.Node, source: ts.SourceFile): string | null {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name === undefined ? null : node.name.getText(source)
  }
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    const parent = node.parent
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
    if (ts.isPropertyAssignment(parent)) return parent.name.getText(source)
    return null
  }
  return null
}

type ScopeResolution =
  | Readonly<{ ok: true; node: ts.Node }>
  | Readonly<{ ok: false; reason: string }>

/**
 * 按由外到内的函数名路径解析作用域。
 *
 * 同名冲突取**最浅**的那个声明：本仓的适配器普遍写成「顶层实现 + 工厂对象里一行同名委派」
 * （`syncWorkflow: (input) => syncWorkflow(dependencies, input)`），委派行不是第二份实现，
 * 判据当然要落在实现上。要指名更深的那一个，就把外层函数名写进路径（例如
 * `['createPostgresqlTaskRouteOperations', 'assertManualExecutionAllowed']`）。
 *
 * 解析不到、或**同一深度**上解析到多个同名函数，一律判为**锚点漂移**并原样报出来——
 * 这正是「文件路径 / 函数名变了要能明确报出来而不是静默失效」那条要求。
 */
function resolveScope(unit: SourceUnit, path: readonly string[] | null): ScopeResolution {
  let current: ts.Node = unit.source
  for (const segment of path ?? []) {
    const matches: Array<{ node: ts.Node; depth: number }> = []
    const walk = (node: ts.Node, depth: number): void => {
      if (node !== current && declaredFunctionName(node, unit.source) === segment) {
        matches.push({ node, depth })
        return // 不再深入：同名嵌套按最外层算
      }
      ts.forEachChild(node, (child) => walk(child, depth + 1))
    }
    ts.forEachChild(current, (child) => walk(child, 1))
    if (matches.length === 0) {
      return { ok: false, reason: `函数 '${segment}' 在 ${unit.path} 里已不存在（锚点漂移）` }
    }
    const shallowest = Math.min(...matches.map((match) => match.depth))
    const outermost = matches.filter((match) => match.depth === shallowest)
    if (outermost.length > 1) {
      return {
        ok: false,
        reason: `函数名 '${segment}' 在 ${unit.path} 里有 ${outermost.length} 个同深度同名声明，作用域不再唯一（锚点漂移）`,
      }
    }
    current = (outermost[0] as { node: ts.Node }).node
  }
  return { ok: true, node: current }
}

/** 作用域内所有字符串字面量文本（含模板串各段）。注释不在其中。 */
function literalTexts(scope: ts.Node): string[] {
  const out: string[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text)
    else if (
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      out.push((node as ts.TemplateLiteralLikeNode).text)
    }
    ts.forEachChild(node, walk)
  }
  walk(scope)
  return out
}

function identifierTexts(scope: ts.Node): Set<string> {
  const out = new Set<string>()
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) out.add(node.text)
    ts.forEachChild(node, walk)
  }
  walk(scope)
  return out
}

/** `if` / 三元的**条件表达式**里出现的标识符。「读了这个值」不算，必须「判断了这个值」。 */
function conditionIdentifiers(scope: ts.Node): Set<string> {
  const out = new Set<string>()
  const collect = (expression: ts.Node): void => {
    for (const name of identifierTexts(expression)) out.add(name)
  }
  const walk = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) collect(node.expression)
    else if (ts.isConditionalExpression(node)) collect(node.condition)
    ts.forEachChild(node, walk)
  }
  walk(scope)
  return out
}

/** 调用 `name(…)` 且第 `argIndex` 个实参是对象字面量。callee 取最后一段标识符。 */
function hasCallWithObjectArgument(scope: ts.Node, name: string, argIndex: number): boolean {
  let found = false
  const walk = (node: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null
      const argument = node.arguments[argIndex]
      if (calleeName === name && argument !== undefined && ts.isObjectLiteralExpression(argument)) {
        found = true
        return
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(scope)
  return found
}

function anchorLabel(anchor: Anchor): string {
  return anchor.kind === 'call-arg-object'
    ? `call-arg-object ${anchor.text}(#${anchor.argIndex} = object literal)`
    : `${anchor.kind} ${JSON.stringify(anchor.text)}`
}

function anchorPresent(scope: ts.Node, anchor: Anchor): boolean {
  switch (anchor.kind) {
    case 'identifier':
      return identifierTexts(scope).has(anchor.text)
    case 'literal':
      return literalTexts(scope).includes(anchor.text)
    case 'literal-prefix':
      return literalTexts(scope).some((text) => text.startsWith(anchor.text))
    case 'condition':
      return conditionIdentifiers(scope).has(anchor.text)
    case 'call-arg-object':
      return hasCallWithObjectArgument(scope, anchor.text, anchor.argIndex)
  }
}

type SiteReport = Readonly<{
  /** 站点解析失败（文件缺失 / 函数名漂移）时的原因；解析成功为 null。 */
  drift: string | null
  /** 命中的锚点标签。 */
  hits: readonly string[]
  /** 未命中的锚点标签。 */
  misses: readonly string[]
}>

function inspect(site: Site, extraAnchors: readonly Anchor[] = []): SiteReport {
  const unit = unitOf(site.file)
  if (unit === null) {
    return { drift: `文件 ${site.file} 不存在（被改名或删除）`, hits: [], misses: [] }
  }
  if (unit.text.trim().length === 0) {
    return { drift: `文件 ${site.file} 为空`, hits: [], misses: [] }
  }
  const scope = resolveScope(unit, site.fn)
  if (!scope.ok) return { drift: scope.reason, hits: [], misses: [] }
  const hits: string[] = []
  const misses: string[] = []
  for (const anchor of [...site.anchors, ...extraAnchors]) {
    ;(anchorPresent(scope.node, anchor) ? hits : misses).push(anchorLabel(anchor))
  }
  return { drift: null, hits, misses }
}

/** 一条缺口的实测结论：`open` = 缺口仍在（账本应当收录它）。 */
type Measurement = Readonly<{ id: string; open: boolean; failures: readonly string[] }>

function measure(gap: PredicateGap): Measurement {
  const failures: string[] = []

  // (1) 有判据的一侧：锚点必须全在，否则 = 漂移，不能当成「缺口消失」。
  for (const site of gap.present) {
    const report = inspect(site)
    if (report.drift !== null) {
      failures.push(
        `[${gap.id}] 有判据的一侧锚点漂移：${report.drift}。请把账本重新指到判据的新位置（不要因为「两边现在都没有」就删掉这一条）。`,
      )
      continue
    }
    for (const miss of report.misses) {
      failures.push(
        `[${gap.id}] 有判据的一侧 ${site.file}${site.fn === null ? '' : ` > ${site.fn.join(' > ')}`} 已经找不到锚点 ${miss}。要么判据真的被删了（那是回归，先修代码），要么它被重命名 / 搬家了（那就更新账本的锚点）。`,
      )
    }
  }

  // (2) 缺判据的一侧：语料下限先行——语料没了，红在语料上，不许静默变绿。
  const absent = inspect(gap.absent, gap.context)
  if (absent.drift !== null) {
    failures.push(
      `[${gap.id}] 缺判据的一侧语料消失：${absent.drift}。这条缺口的对账锚点已失效，请重新对账后更新账本。`,
    )
    return { id: gap.id, open: failures.length === 0, failures }
  }
  const contextLabels = new Set(gap.context.map(anchorLabel))
  for (const miss of absent.misses.filter((label) => contextLabels.has(label))) {
    failures.push(
      `[${gap.id}] 缺判据的一侧 ${gap.absent.file}${gap.absent.fn === null ? '' : ` > ${gap.absent.fn.join(' > ')}`} 已经不含语料锚点 ${miss}——对应代码路径被搬走或改写了，守卫会因此假绿。请重新对账后更新账本。`,
    )
  }

  // (3) 缺口本身：缺的那一侧一个判据锚点都不许命中。
  const closed = absent.hits.filter((label) => !contextLabels.has(label))
  return {
    id: gap.id,
    open: closed.length === 0,
    failures: [
      ...failures,
      ...closed.map(
        (label) =>
          `[${gap.id}] 缺口已补：${gap.absent.file}${gap.absent.fn === null ? '' : ` > ${gap.absent.fn.join(' > ')}`} 现在含有 ${label}。请把这一条从 DUAL_ENGINE_PREDICATE_GAPS 里**删掉**（账本只降不升，每补一条就改小一次）。`,
      ),
    ],
  }
}

// ---------------------------------------------------------------------------
// 守卫
// ---------------------------------------------------------------------------

describe('RFC-359 W5 — 双引擎判据缺口 exact 账本', () => {
  test('账本按 id 字典序排列且无重复', () => {
    const ids = DUAL_ENGINE_PREDICATE_GAPS.map((gap) => gap.id)
    expect(ids).toEqual([...ids].sort())
    expect(ids).toEqual([...new Set(ids)])
  })

  test('每条缺口都指向两个真实存在、非空的文件（改名 / 删除必须红，不许静默变绿）', () => {
    const missing: string[] = []
    for (const gap of DUAL_ENGINE_PREDICATE_GAPS) {
      for (const site of [...gap.present, gap.absent]) {
        const unit = unitOf(site.file)
        if (unit === null) missing.push(`[${gap.id}] ${site.file} 不存在（被改名或删除）`)
        else if (unit.text.trim().length === 0) missing.push(`[${gap.id}] ${site.file} 为空`)
      }
    }
    expect(missing).toEqual([])
  })

  test('每条缺口的两侧作用域都能解析到唯一函数（函数改名 / 同名歧义都算锚点漂移）', () => {
    const drifted: string[] = []
    for (const gap of DUAL_ENGINE_PREDICATE_GAPS) {
      for (const site of [...gap.present, gap.absent]) {
        const unit = unitOf(site.file)
        if (unit === null) continue // 上一条用例已经报过
        const scope = resolveScope(unit, site.fn)
        if (!scope.ok) drifted.push(`[${gap.id}] ${scope.reason}`)
      }
    }
    expect(drifted).toEqual([])
  })

  test('每条缺口的语料下限成立：缺判据的一侧仍含 context 锚点', () => {
    const eroded: string[] = []
    for (const gap of DUAL_ENGINE_PREDICATE_GAPS) {
      const report = inspect({ ...gap.absent, anchors: [] }, gap.context)
      if (report.drift !== null) {
        eroded.push(`[${gap.id}] ${report.drift}`)
        continue
      }
      for (const miss of report.misses) {
        eroded.push(`[${gap.id}] ${gap.absent.file} 已不含语料锚点 ${miss}`)
      }
    }
    expect(eroded).toEqual([])
  })

  test('每条缺口的「有判据一侧」锚点都还在（防止两边都没有时假绿）', () => {
    const drifted: string[] = []
    for (const gap of DUAL_ENGINE_PREDICATE_GAPS) {
      for (const site of gap.present) {
        const report = inspect(site)
        if (report.drift !== null) {
          drifted.push(`[${gap.id}] ${report.drift}`)
          continue
        }
        for (const miss of report.misses) {
          drifted.push(
            `[${gap.id}] ${site.file} > ${(site.fn ?? ['<file>']).join(' > ')} 已找不到锚点 ${miss}`,
          )
        }
      }
    }
    expect(drifted).toEqual([])
  })

  test('实测缺口集合与账本逐字相等（补上了就删除这一条；新增缺口要说明为什么）', () => {
    const measurements = DUAL_ENGINE_PREDICATE_GAPS.map(measure)
    const failures = measurements.flatMap((measurement) => measurement.failures)
    expect(failures).toEqual([])

    const measured = measurements
      .filter((measurement) => measurement.open)
      .map((measurement) => measurement.id)
    expect(measured).toEqual(DUAL_ENGINE_PREDICATE_GAPS.map((gap) => gap.id))
  })

  test('账本条目自身自洽：id 前缀与 item 编号对应，且两侧属于不同引擎', () => {
    const problems: string[] = []
    for (const gap of DUAL_ENGINE_PREDICATE_GAPS) {
      const prefix = gap.id.split('-')[0] ?? ''
      if (!prefix.startsWith(String(gap.item).padStart(2, '0'))) {
        problems.push(`[${gap.id}] id 前缀与 item=${gap.item} 不对应`)
      }
      if (gap.consequence.trim().length === 0) problems.push(`[${gap.id}] 缺少用户可见后果说明`)
      const absentIsPostgresql = /postgresql/i.test(gap.absent.file)
      if (absentIsPostgresql !== (gap.missingSide === 'postgresql')) {
        problems.push(
          `[${gap.id}] missingSide='${gap.missingSide}' 与 absent 文件 ${gap.absent.file} 不符`,
        )
      }
    }
    expect(problems).toEqual([])
  })
})

describe('RFC-359 W8 — 已裁决双引擎分叉 exact 账本', () => {
  test('账本按 id 字典序排列且无重复', () => {
    const ids = ACCEPTED_DUAL_ENGINE_DIVERGENCES.map((entry) => entry.id)
    expect(ids).toEqual([...ids].sort())
    expect(ids).toEqual([...new Set(ids)])
  })

  test('每条分叉都写清了 why / removeWhen / 用户可见后果，且两侧属于不同引擎', () => {
    const problems: string[] = []
    for (const entry of ACCEPTED_DUAL_ENGINE_DIVERGENCES) {
      if (entry.why.trim().length === 0) problems.push(`[${entry.id}] 缺少 why`)
      if (entry.removeWhen.trim().length === 0) problems.push(`[${entry.id}] 缺少 removeWhen`)
      if (entry.consequence.trim().length === 0) {
        problems.push(`[${entry.id}] 缺少用户可见后果说明（「无」也要写，并说明为什么无）`)
      }
      if (/postgresql/i.test(entry.sqlite.file)) {
        problems.push(`[${entry.id}] sqlite 侧指向了 PostgreSQL 文件 ${entry.sqlite.file}`)
      }
      if (!/postgresql/i.test(entry.postgresql.file)) {
        problems.push(
          `[${entry.id}] postgresql 侧指向的不是 PostgreSQL 文件：${entry.postgresql.file}`,
        )
      }
    }
    expect(problems).toEqual([])
  })

  test('两侧的形状锚都还在（任一侧变形 = 分叉可能已消失或已变质，必须重新对账）', () => {
    const drifted: string[] = []
    for (const entry of ACCEPTED_DUAL_ENGINE_DIVERGENCES) {
      for (const [side, site] of [
        ['sqlite', entry.sqlite],
        ['postgresql', entry.postgresql],
      ] as const) {
        const report = inspect(site)
        if (report.drift !== null) {
          drifted.push(`[${entry.id}] ${side} 侧锚点漂移：${report.drift}`)
          continue
        }
        for (const miss of report.misses) {
          drifted.push(
            `[${entry.id}] ${side} 侧 ${site.file} > ${(site.fn ?? ['<file>']).join(' > ')} ` +
              `已找不到锚点 ${miss}。这条分叉的形状变了：要么它已经收敛（那就把这一条从 ` +
              `ACCEPTED_DUAL_ENGINE_DIVERGENCES 删掉，removeWhen 写的就是这一刻），` +
              `要么只是搬了家（那就更新锚点）。`,
          )
        }
      }
    }
    expect(drifted).toEqual([])
  })
})
