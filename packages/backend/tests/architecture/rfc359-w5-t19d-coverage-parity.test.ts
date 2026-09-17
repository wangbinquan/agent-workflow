// RFC-359 W5-T19d —— 成对适配器的**覆盖对等**账本（只降不升）。
//
// 事故形态：覆盖倒挂 ⇒ PostgreSQL 侧**静默变弱**
// ------------------------------------------------
// 一个 port 落成两份实现之后，两侧的测试注意力几乎从来不是对半分的。SQLite 侧被几十个套件
// 天天跑，PostgreSQL 侧一条行为判据都没有——于是它可以**长期比 SQLite 弱而没有任何东西转红**：
// 漏引用完整性复核、漏幂等回放、漏状态校验，全都要等到 W4 把两侧合一时才第一次被看见
// （`design/dual-provider-parity-audit-2026-09-04.md` 的 12 条 P0 全是这么漏过去的）。
// 换句话说，**倒挂本身就是缺陷的孵化器**：哪一侧没人看，哪一侧就会长出分歧。
//
// 本轮实做撞到的两个实例，就是这条守卫的来由：
//   - `rfc328-durable-ownership.test.ts` —— 1495 行的正确性矩阵（耐久归属 / 效应围栏 / 意图回放 /
//     终态维护），**全部只跑 SQLite**：它 import 的是 `sqliteTaskExecutionRecovery` /
//     `sqliteTaskExecutionContext` / `sqliteLocalEffectObserver`，PG 侧的同名实现零行为覆盖；
//   - **Skill 三对** —— 合一前覆盖是 **52 : 6** 的倒挂（`plan.md` §W4 甲类表：
//     「SQLite / legacy 侧 52 个套件，PG 侧 6 个」，且 PG 那 6 个「多为源码形状锁」）。
//     两侧归一化相似度只有 7%——不是同一份逻辑的两种写法，是两套机器。
//
// 为什么是**代理判据**，不是真行覆盖率
// ------------------------------------
// 先量过 `bun test --coverage`：它确实能按文件给行覆盖（lcov 的 `DA:` / `LF:` / `LH:`，
// 函数体内逐行，且 `--isolate` 下能跨测试文件聚合）。真覆盖率仍然做不成常驻守卫，三条硬伤：
//   1. **PG 侧的行覆盖需要一个真 PostgreSQL**。没有 `AW_TEST_POSTGRESQL_URL` 时 PG 适配器的
//      覆盖恒为 0，判据退化成同义反复；而 macOS lane 是显式的 sqlite-only lane（起不了服务容器），
//      它**永远**测不出对等。守卫在半数 lane 上零预言力，不如不做。
//   2. **backend 在 CI 上是四分片**，每片只看到四分之一的测试，per-shard lcov 是残缺视图；
//      要一份可比的数只能新造「四片 lcov 合并」的 CI 管道——那是 T21 之后的事，不是本条的前置。
//   3. 未被 import 的文件**根本不出现在 lcov 里**（实测：没人 import 的模块整条记录缺席，
//      不是 0%）。而「PG 侧零覆盖」恰恰就是这个形态——最该报的那一格，报告里没有行。
// 所以本条按 plan §5 T19d 的「过渡期」定位取零运行代价的代理判据，真覆盖率留到 T21
// （四分片各带 postgres 服务容器）之后再谈。
//
// 判据：两个通道，口径与 `scripts/tests-referencing.sh` 对齐
// ---------------------------------------------------------
// `scripts/tests-referencing.sh` 是本仓「谁引用了这个实现」的既有单一工具，RFC-359 的
// 52:6 / 13:3 两组数就是用它数出来的。这里沿用同一口径，并拆成两个通道：
//   - **ref**（引用）：测试文件按标识符边界提到该侧的**模块名**或它的**任一导出符号**。
//     这就是 `tests-referencing.sh` 数出来的那个数。
//   - **drive**（驱动）：测试文件有一条**值 import**（非 `import type`）直接落到该侧模块上
//     ——也就是它真能把这份实现构造出来跑。**源码形状锁只 `readFileSync` + 正则，drive 记 0**，
//     于是「PG 侧 3 个，多为源码形状锁」这种虚高会被这一列当场拆穿。
// 两个通道一起看才有意义：ref 高 drive 低 = 一堆人提到它、没人跑它。
//
// **判据的已知偏斜**（读这份账本排合一优先级时必须知道）：薄壳对（SQLite 侧只是 legacy 机器上的
// 一层壳）的 SQLite 行为不在 `sqliteX.ts` 里，而在它下面的 legacy 实现里，测试也多经由组合根
// 接进去；于是这类对的 SQLite 列会**系统性偏低**，个别对甚至显得 PG 更高。反过来，把判据放宽成
// 「静态可达」则完全失效——量过：`TaskOwnershipPersistence` 两侧各 832，因为按 provider 分派的
// 组合根把两侧一起 import 了，可达 ≠ 执行，倒挂被抹成假对等。两害相权取偏斜可解释的那个，
// 并在这里写明，别拿单行数字当结论。
//
// 机制同 RFC-317 T17 / `rfc359-sync-transaction-highwater.test.ts`：**逐字相等，只降不升**。
// 倒挂加深了红——有人又往已经偏斜的那侧加判据；倒挂收敛了也红——把账本一起改小，
// 让每一次补齐都留下一次有署名的提交记录。

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..', '..', 'src')
const TESTS = resolve(import.meta.dir, '..')

/** 「我只服务一个引擎」的自述式文件名前缀，后接大写字母（`sqliteFoo.ts` / `postgresqlFoo.ts`）。 */
const PROVIDER_PREFIX = /^(sqlite|postgresql)(?=[A-Z])/

/**
 * `<目录>/<去掉引擎前缀的名字>: sqlite <ref>/<drive>, postgresql <ref>/<drive>`，按路径字典序。
 *
 * `ref` = 提到该侧模块名或其导出符号的测试文件数；`drive` = 有值 import 能真正构造它的测试文件数。
 * 只降不升：任何一格变了都要改这份账本。
 */
export const COVERAGE_PARITY_LEDGER: readonly string[] = [
  // RFC-359：**`IntentApplyArtifactLifecycle` / `IntentApplyOperations` 两对已销账**（两台
  // apply 引擎合一）。销账前 `IntentApplyOperations` 是本账本里最深的一处倒挂——
  // `sqlite 21/3` 对 `postgresql 7/5`：判据几乎全喂在 SQLite 那一侧，PG 那一侧的编排在
  // 无人看管地漂移。合一照出的三处用户可见缺陷（名字域 dangle 容忍、特权节点回填、
  // in-place 改名）**全部落在 PG 那一侧**，正是这条倒挂预言的形状。
  // RFC-359 W8：两侧各 +1 ref / +1 drive（`rfc359-w8-resource-package-maintenance-conformance.test.ts`
  // 是 `describeEachProvider`，一条 body 同时驱动两侧的 journal + 恢复端口）。
  // RFC-359 W9：两侧各 +1 ref / +1 drive —— `rfc359-w9-resource-package-skill-recovery-conformance.test.ts`
  // 同时驱动两侧的恢复端口（判据缺口 13b 的对拍）。两侧同步上涨，倒挂没有加深。
  // W12：journal 合一后 oracle 改 import 中立文件，剩余 artifact 两侧各少一条直接引用。
  // RFC-359（plan §5dy）3/3 → 4/3：`rfc271-impl-gate-fixes` 的 P1-5 源码锁改指统一那条恢复链
  // （原来指着随通用 bundle 引擎退役的 legacy 引擎）。**倒挂没有加深**——弱侧 sqlite 那一份
  // 现在是「合一前存量格式的读回侧」，它的 3/2 由 `rfc359-w5-artifact-format-portability`
  // 的 12 格矩阵与回落链判据一起盯着。
  'modules/resource-catalog/infrastructure/ResourcePackageMaintenance: sqlite 3/2, postgresql 4/3',
  // RFC-359 AC-1（plan §5hn 批次二 ⑤）：**这一对整行销账**——SQLite 那半（87 行转发壳）
  // 已删除，两个组合根叫同一个工厂，`classify()` 再也配不出这一对。
  // RFC-359 W8：双引擎对拍 `rfc359-w8-source-termination-conformance.test.ts` 把两侧各 +1/+1。
  // RFC-359 W10：SQLite 侧再 +1 ref / +1 drive —— 三笔 `dbTxSync` 转成中立事务之后，
  // `rfc359-w10-task-execution-sync-transaction-cutover.test.ts` 在**两个引擎上都构造这一个**
  // SQLite 命名的参与者（它跑得动 PostgreSQL 正是转换成功的判据），于是它的引用/驱动数上涨。
  // 倒挂随之从 +1 变成 +2，但方向是「弱侧 PG 的那份原生重写更该退役」，不是新债。
  // W12：共用 atom 的真实回滚、终态 CAS 赢家、提交后停止回归，两侧各加 1 ref/drive。
  // 第八批：非状态写入快照转到共有 writeFence，旧 SQLite 文件少一条文本引用；驱动数不变。
  'modules/task-execution/infrastructure/SourceTerminationParticipant: sqlite 4/4, postgresql 3/2',
  // W12：真实执行夹具提升到 providerRuntime 整体装配，底层 PG participants / launch 的
  // 直接 import 各少一条，但 factory 的返回对象驱动同一真实任务；不以直接引用数冒充行为覆盖。
  // W12 第十三批：完整 dynamicWorkflow 类型负例新增 PG participants 引用；
  // ref 5 → 6，drive 仍 1，不能把纯类型证明记成新增直接行为驱动。
  // RFC-359 AC-1（plan §5hn 批次二 ⑤）：`10/3 → 11/3`。子任务启动合一之后，
  // 参与者这一对的 SQLite 侧多了一处引用——`rfc359-w8-child-launch-conformance` 的 SQLite lane
  // 现在按 SQLite 组合根那条拼法造端口（`createDatabaseTaskDriverLifecyclePort`），
  // 于是它提到了这一侧的模块。**倒挂差 4 → 5，但这一格是记账不是倾斜**：涨的那条引用
  // 恰恰来自一份 `describeEachProvider` 的双引擎对拍，它同时喂着两侧。
  // RFC-359 AC-1（plan §5hn 批次二 ⑤ 收尾）：`11/3 → 12/3`。**这一格也是记账不是倾斜**——
  // 第 12 条引用来自 `rfc359-w8-child-launch-conformance` 的注释里写了
  // `sqliteTaskExecutionRuntimeParticipants.ts` 这个文件名（本账本按**文本**数引用，注释也算）。
  // 记账教训：这条棘轮要在**所有编辑做完之后**再跑一次——批次二 ⑤ 那一提就是中途跑绿、
  // 之后又改了注释，把 11 推上了 main（见 `docs/dev-gotchas.md` 对应条目）。
  'modules/task-execution/infrastructure/TaskExecutionRuntimeParticipants: sqlite 12/3, postgresql 6/1',
  // RFC-359 AC-1（plan §5hh）：`postgresql 5/1 → 6/2`。新增的那次**驱动**是
  // `rfc359-w5-kernel-launch-provider-parity`——它在**两个引擎上各真启动一次**启动内核。
  // 账本按**符号名**归边，而这台内核顶着 `Postgresql` 前缀（它只服务一条启动路，
  // 按 proposal AC-1 第三款该保留前缀），所以这笔两边都跑的覆盖被记到了 postgresql 一侧。
  // **倒挂看起来加深，实际是覆盖变好了**：此前「内核 + SQLite 库」零覆盖（plan §5hg）。
  // 等启动面合一收尾、这一对塌成一份，这两行会一起消失。
  // RFC-359 AC-1（plan §5hi）：`postgresql 6/2 → 7/3`。数字员工动作执行的启动面合一，
  // **SQLite 的两个组合根现在也用这台内核**——经模块的中立组合入口
  // `composition/hostTaskLaunch.ts`（+1 ref），而 `rfc359-w14-legacy-mission-execution` /
  // `rfc310-pr4-execution-host` 在 SQLite 上真驱动它（+1 drive）。同 §5hh：账本按**符号名**
  // 归边，这台顶着 `Postgresql` 前缀的内核所收的两边覆盖全记在 postgresql 一侧，
  // **倒挂数字变大 = 覆盖变好**。它现在已经没有 provider 语义了（两个引擎共用一台），
  // 按 proposal AC-1 第三款是**命名债**，该改成中立名——那一刀连着整个文件的
  // 路由级 PG 类型，单独立一批做（plan §5hj）。
  // RFC-359 AC-1（plan §5hl）：`7/3 → 7/2`。测试侧的内核装配助手改成**转调生产那个组合入口**
  // （`composeHostTaskLaunchKernel`），不再直呼带品牌名的 `createPostgresqlRootTaskLaunchKernel`——
  // 于是直接驱动这个品牌符号的地方少一处，引用数不变。**这是收敛，不是覆盖变少**：
  // 同一批用例现在驱动的是生产那台内核的装配路径。
  // RFC-359 AC-1（plan §5hn 批次一）：`7/2 → 8/2`。新用例
  // `rfc359-w5hn-agent-launch-provider-parity` 在**两个引擎上各真启动一次**单代理任务，
  // 而这条判据按符号名归边、启动内核顶着 `Postgresql` 前缀，于是这笔两边都跑的覆盖
  // 又记到 postgresql 一侧（同 §5hh / §5hi）。**倒挂数字变大 = 覆盖变好**：
  // PG 侧那份 `launchAgent` 编排此前零行为用例。
  // RFC-359 AC-1（plan §5hn 批次一）：`2/1, 8/2 → 3/1, 9/2`。**两侧各 +1，差额不变（6）**——
  // 单代理启动的编排合成一份后，SQLite 那份文件开始引用 PG 文件导出的
  // `createAgentRouteLaunch` / `AgentRouteLaunchDependencies`，两边的测试提及面随之各长一个文件。
  // 这条判据盯的是**倒挂深度**（两侧差 >= 3 的对），差额没动，所以不是新的倒挂。
  // RFC-359 AC-1（plan §5hn 批次二）：`9/2 → 10/2`。新用例
  // `rfc359-w5hn-workgroup-launch-provider-parity` 在**两个引擎上各真启动一次**工作组任务，
  // 按符号名归边记到 PG 一侧（同前几刀）。**倒挂数字变大 = 覆盖变好**：
  // 合并那 470 行之前，先有了双引擎等价性基线。
  // RFC-359 AC-1（plan §5hn 批次二 ①）：`10/2 → 11/2`。新用例
  // `rfc359-w5hn-scheduled-launch-provider-parity` 在两个引擎上各真跑一次**定时启动**
  // （run-now → fireSchedule → 触发器参与者 → 启动参与者），同样按符号名归到 PG 一侧。
  // **这一对的「倒挂」此刻已经是命名残留，不是覆盖倾斜**：两条臂的编排都在 PG 那个文件里，
  // SQLite 那份（3 个引用）只剩一层把依赖翻译过去的委托壳，它的行为**就是**被 PG 那一侧
  // 的用例覆盖着的。真正的销账动作是把那个文件改名成中立名（§5hj 记的命名债），
  // 不是往 SQLite 那侧硬凑用例。
  // RFC-359 AC-1（plan §5hn 批次二 ①②）：`3/1 → 5/3`，**倒挂收敛了两格**（差 8 → 6）。
  // 这次是真的覆盖变好，不是记账：`rfc165-scheduled-kinds` 与 `rfc287-t13-deferred-prep`
  // 的定时夹具从 `services/scheduleLaunch.ts`（已删）改成生产同一份编排，于是它们**值 import**
  // 了 `createSqliteTaskExecutionLaunchParticipant`——drive 那一列 1 → 3 就是这个意思。
  // RFC-359 AC-1（plan §5hn 批次二 ④）：`11/2 → 12/2`，**这一格是记账不是判据**——
  // 涨的那一条引用来自 `rfc345-resource-acl-facade-retirement.test.ts` 的兼容债账本：
  // 启动输入契约补进 PG 那份参与者时，该文件成了 `services/workflowLaunchInputs.ts` 的
  // 第 6 个消费者，于是账本里多写了一次它的文件名。没有任何新的行为判据只喂给 PG 那一侧。
  // 这一对此刻正在**收敛**：批次二 ④ 已经把工作流 JSON 路由接到这份共用实现上，
  // SQLite 那份剩的是委托壳，销账动作是 §5hj 记的改中立名，不是往 SQLite 侧硬凑用例。
  // RFC-359 AC-1（plan §5hn 批次二 ⑦）：`5/3, 12/2 → 6/3, 16/3`。**这一格是命名债的读数，
  // 不是倾斜**——`startExecution` 门面与 `services/multipartTaskStart.ts` 整份删除之后，
  // 一批源码文本锁改锚到了**共用实现**上，而共用实现此刻还叫 `postgresql*`（§5hj 记的命名债）。
  // 于是「PG 侧引用数」涨的其实是「共用实现被引用的次数」。真正的处置是把那两个文件改成中立名，
  // 不是往 SQLite 那侧硬凑用例——SQLite 侧剩下的只是一层委托壳。
  // RFC-359 AC-1（plan §5hn 批次二 ⑧）：`6/3, 16/3 → 7/3, 17/3`，**两侧同步 +1，倒挂差额不变**。
  // 新增的那条引用来自 `tests/helpers/participantLaunch.ts`——它是这次把
  // `startAgentTask` / `startWorkgroupTask` 的测试调用点迁到启动参与者时加的测试助手，
  // 两侧的模块名都被它提到（它装的是 SQLite 组合根那条拼法、造的是共用的那台参与者）。
  // 同一笔里 PG 侧再 +1：`rfc287-t13-preset-task-id` 的源码锁改锚到内核的
  // `workspace.prepare(...)`（`materializeSpace` 的 agent / multipart 两个调用点都随函数删除了）。
  // 仍是**命名债的读数**——共用实现还叫 `postgresql*`（§5hj）。
  // 再 +1（同一笔）：`rfc165-contract-v2` 的 `applySpaceFields` 源码锁也改锚到了启动参与者的
  // 两条臂——`startWorkgroupTask` 删除后，原来那句「`workgroup/launch.ts` 里必须有
  // `applySpaceFields(`」不再成立，同一个不变量的新家就在共用实现里。
  'modules/task-execution/infrastructure/TaskRouteLaunchOperations: sqlite 7/3, postgresql 19/3',
  // RFC-359 W8：两侧各 +1 ref / +1 drive（`rfc359-w8-task-route-capability-parity.test.ts`
  // 是 `describeEachProvider`，一条 body 同时驱动两侧），倒挂差额不变。
  // W12：协作能力合同各增加一条 type import；仅引用 +1，驱动数不变。
  // RFC-359 W58：PG 侧多一处引用——`workflowSyncPreview` 的内置工作流分支补齐了
  // （此前它只在 SQLite 侧有，PG 上内置工作流的任务拿到的是 `workflow-deleted`）。
  // 两侧的 ref 差因此从 2 拉到 3，越过阈值，进下面的观察名单。
  // RFC-359 AC-1（plan §5hn 批次一）：12 → **11**，回到原值。**这一格的移动与覆盖无关**——
  // `refs` 数的是「提到该实现任一导出符号（或其 basename）的测试文件数」，而这个「提到」
  // **连注释里的提及也算**。上一版里 `rfc359-w5hn-agent-launch-provider-parity` 的注释
  // 写了一句「靠读时投影补（`postgresqlTaskRouteOperations.ts:413`）」，于是它被记成一次引用；
  // 那处差异修好之后那句话删了，计数就退回去了。
  // **给下一个人**：这条账本的数字**会因为改注释而动**，看到它变化时先确认是不是这种情况，
  // 别当成覆盖真的增减了。
  // RFC-359 AC-1（plan §5hn 批次二 ④）：`8/2 → 9/2`。新基线
  // `rfc359-w5hn-workflow-route-launch-provider-parity` 在两个引擎上各真打一次
  // JSON `POST /api/tasks`，按符号名归到 SQLite 一侧（它的头注释点名了那条仍走
  // `startExecution → startTask` 的路）。**倒挂差额 3 → 2，跌破阈值**，这一对因此
  // 退出下面的观察名单。
  // RFC-359 AC-1（plan §5hn 批次二 ⑥）：PG 侧 `11 → 10`，**倒挂收敛**（差 2 → 1）。
  // multipart 路由改走共用的启动参与者之后，`postgresqlTaskRouteOperations.ts` 不再自己跑
  // 启动输入契约，`rfc345` 兼容债账本里那条点名它的边随之出账——少的是一条**记账提及**，
  // 而它对应的是一处真实的编排合并。
  // RFC-359 AC-1（plan §5hn 批次二 ⑦）：`10/2 → 14/2`，来源同上（改锚到共用实现）。
  // RFC-359 AC-1（plan §5hn 之后的盘点，第 2 刀）：`postgresql 14/2 → 19/6`。纯读三件
  // （`diff` / `stdout` / `events`）合一，SQLite 侧那三份实现连同 `services/task.ts` 里的
  // `getTaskDiff` / `getNodeRunStdout` / `getNodeRunEvents` 一起删除，四个消费者测试
  // （`rfc311-stdout-tail` / `events-archive` / `task-diff-multi-repo` /
  // `task-diff-multi-repo-truncation`）改按共用投影 import——**+5 ref / +4 drive 全部落在
  // postgresql 一侧，因为共用的那份住在 `postgresqlTaskRouteOperations.ts` 里**。
  // 这是**命名债的读数，不是倾斜**：涨上去的覆盖是两个引擎共享的同一份实现，SQLite 那一侧
  // 现在根本没有第二份可漂移。本账本已有三格这么读（`TaskRouteLaunchOperations` / 本格 /
  // `TaskExecutionRuntimeParticipants`），债本身按 plan §5hj 单独一刀还。
  // `19/6 → 20/6`：`source-text-rfc066-pr-b-guards` 的 PB-G5 改锚到共用的 diff 投影，
  // 于是它的路径常量提到了这个模块。同样是**命名债的读数**，不是新判据。
  // RFC-359 AC-1（plan §5hn 之后的盘点，第 3 刀）：`20/6 → 35/20`。列表三件
  //（`list` / `listItems` / `get`）合一，`services/task.ts` 里的 `listTasks` /
  // `listTaskItems` / `listTaskSummaryRows` / `rowToSummary` / 单飞合并表一并删除，
  // 十四个消费者测试改按共用投影 import。**+15 ref / +14 drive 全部落在 postgresql 一侧，
  // 因为共用的那份住在 `postgresqlTaskRouteOperations.ts` 里**——仍是命名债的读数，
  // 不是倾斜：涨上去的覆盖是两个引擎共享的同一份实现。
  //
  // 这一格现在是本账本上**最响的一次假信号**（35 vs 9）。命名债按 plan §5hn 的收尾计划
  // 在这一对合完之后一并还：那时 `postgresqlTaskRouteOperations.ts` 会塌成中立名，
  // 这两行随之一起消失。
  'modules/task-execution/infrastructure/TaskRouteOperations: sqlite 9/2, postgresql 35/20',
  // RFC-359 W8：两侧各 +1 ref / +1 drive（`rfc359-w8-logical-source-conformance.test.ts`），
  // 倒挂差额不变（下面观察名单里那条随之从 `7 vs 4` 变成 `8 vs 5`）。
  // W18: original SQLite copy/Worker and historical-contract fixtures add four
  // actual source drivers; the old-PG backup/restore case adds one PG driver.
  // Other real PG reads go through the production backup/upgrade entrypoints,
  // so this direct-import census does not claim to count all behavior coverage.
  // W19: the hosted SQL regression directly constructs the actual PG source
  // with a controlled connection; this is a driver count, not a real-PG claim.
  'platform/persistence/LogicalSource: sqlite 12/8, postgresql 7/5',
  // W55 CI：原 SQLite 迁移器全文逐字移入既有 PostgreSQL 迁移器所在目录，
  // 同目录判据首次识别这两个原文件；补录原 ref/drive，不代表新增实现或行覆盖。
  // RFC-359 W8（2026-09-11）：两侧各 +1（2/1 → 3/2、11/10 → 12/11），来自
  // `tests/rfc359-w8-migrator-conformance.test.ts` 对**两侧迁移器各一条值 import**——
  // 它在两个引擎上各把迁移器从零跑一遍，正是上一版注释预告的收敛路径（harness 每文件一库落地后
  // PG 迁移器终于能在隔离库上被驱动）。倒挂的**绝对差没变**（9），但两侧现在被同一条用例喂到，
  // 这一行的性质已经从「强侧独自变强」变成「两侧同步」。
  // 剩下的 9 是 PG 侧多出来的机制专属判据（迁移生成代、schema 锁作用域、计划审计…），
  // SQLite 侧没有对应物；真正的收敛要等那些机制本身消失，不是再补 SQLite 侧的空壳用例。
  'platform/persistence/Migrator: sqlite 3/2, postgresql 12/11',
]

/** plan §5 T19d 的「阈值」：两侧 ref 差到这个数就算倒挂，要么补测试、要么进下面的观察名单。 */
export const REFERENCE_GAP_THRESHOLD = 3

/**
 * ref 差 >= `REFERENCE_GAP_THRESHOLD` 的对，`<对>: <sqlite ref> vs <postgresql ref>`，按路径字典序。
 * 这是「先合谁」的排序依据：倒挂越深，合一时撞出行为差异的概率越大（D19b 实证）。
 */
export const INVERTED_PAIRS: readonly string[] = [
  // RFC-359：两条 intent apply 的倒挂随合一一起消失（见 `COVERAGE_PARITY_LEDGER` 的注释）。
  // RFC-359 AC-1（plan §5hn 批次二 ⑤）：10 vs 6 → 11 vs 6，来源见上一格的注释
  //（双引擎对拍的 SQLite lane 改按组合根那条拼法造端口）。
  // RFC-359 AC-1（plan §5hn 批次二 ⑤ 收尾）：11 vs 6 → 12 vs 6，来源见上一格的注释。
  'modules/task-execution/infrastructure/TaskExecutionRuntimeParticipants: 12 vs 6',
  // 同上（§5hh）：差额 5 → 6 来自那次双引擎的内核启动，不是新的单侧倾斜。
  // RFC-359 AC-1（plan §5hi）：6 → 7，来源同上（SQLite 两个根改用这台内核）。
  // RFC-359 AC-1（plan §5hn 批次一）：7 → 8，来源同上。
  // RFC-359 AC-1（plan §5hn 批次一）：2 vs 8 → 3 vs 9，差额不变。
  // RFC-359 AC-1（plan §5hn 批次二）：9 → 10，来源同上。
  // RFC-359 AC-1（plan §5hn 批次二 ①）：10 → 11，来源同上（定时启动的双引擎基线）。
  // RFC-359 AC-1（plan §5hn 批次二 ①②）：3 vs 11 → 5 vs 11，差额 8 → 6（收敛）。
  // RFC-359 AC-1（plan §5hn 批次二 ④）：5 vs 11 → 5 vs 12，差额 6 → 7。**记账，不是倾斜**：
  // 多出来的那一条引用是兼容债账本里的一次文件名提及（见上一格的注释），不是新判据。
  // RFC-359 AC-1（plan §5hn 批次二 ⑦）：5 vs 12 → 6 vs 16，来源见上（命名债的读数）。
  // RFC-359 AC-1（plan §5hn 批次二 ⑧）：6 vs 16 → 7 vs 17，**差额不变**（两侧同步 +1）。
  'modules/task-execution/infrastructure/TaskRouteLaunchOperations: 7 vs 19',
  // 新入名单，同样是命名债的读数：共用的那条 multipart 编排（`launchMultipartTask`）住在
  // `postgresqlTaskRouteOperations.ts` 里，改锚过去的几条源码锁都提到了它。
  // RFC-359 AC-1（plan §5hn 之后的盘点，第 2 刀）：9 vs 14 → 9 vs 19，来源同上一格
  //（纯读三件合一，共用实现住在 PG 命名的文件里）。
  // PB-G5 改锚：9 vs 19 → 9 vs 20，来源同上一格。
  // 第 3 刀：9 vs 20 → 9 vs 35，来源同上一格（列表三件合一 + 十四个消费者改锚）。
  'modules/task-execution/infrastructure/TaskRouteOperations: 9 vs 35',
  // RFC-359 W58：新入名单。PG 侧 workflowSyncPreview 补内置分支所致；SQLite 侧的同一段判据
  // 早就有，只是它的实现更集中（`computeWorkflowSyncPreview` 一个函数里）。判据本身现在两侧
  // 共用 `domain/workflowSyncPreview.ts`，ref 差是形状差，不是覆盖差。
  // RFC-359 AC-1（plan §5hn 批次一）：12 → 11，来源同上（注释里的提及被计入引用数）。
  // RFC-359 AC-1（plan §5hn 批次二 ④）：**退出名单**——差额 3 → 2，跌破阈值
  //（新基线 `rfc359-w5hn-workflow-route-launch-provider-parity` 归在 SQLite 一侧）。
  'platform/persistence/LogicalSource: 12 vs 7',
  // 同上：原文件落位使这一既有引用差首次进入观察名单，阈值保持不变。
  'platform/persistence/Migrator: 3 vs 12',
]

interface Side {
  readonly refs: number
  readonly drives: number
}

interface Scan {
  /** 扫到的 backend 源文件数——语料下限的分母（RFC-317 T13：扫空 = 假绿）。 */
  readonly sourceFiles: readonly string[]
  /** 扫到的测试文件数（不含 `architecture/`）——同上。 */
  readonly testFiles: readonly string[]
  /** 全树 provider 命名的实现文件数——判据「还咬得动」的证据（账本清空后仍非零）。 */
  readonly providerNamed: number
  /** `<对>: sqlite <ref>/<drive>, postgresql <ref>/<drive>`，字典序。 */
  readonly rows: readonly string[]
  /** ref 差 >= 阈值的对，字典序。 */
  readonly inverted: readonly string[]
}

function listTypescript(base: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(base, dir), { withFileTypes: true })) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (entry.name.endsWith('.ts')) out.push(rel)
    }
  }
  walk('')
  return out
}

/** 顶层导出的具名符号。needle 用它而非「首字母大写的模块名」，才能咬到 `openSqliteLogicalSource` 这种。 */
const EXPORTED_SYMBOL =
  /^export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/

/**
 * 按**标识符边界**匹配：`sqliteTaskExecutionRecovery` 不得被
 * `sqliteTaskExecutionRecoveryPersistence`（另一个模块）满足，否则一侧会被邻居的引用虚抬。
 */
export function mentionsIdentifier(text: string, needle: string): boolean {
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const before = at > 0 ? (text[at - 1] ?? '') : ''
    const after = at + needle.length < text.length ? (text[at + needle.length] ?? '') : ''
    if (!IDENTIFIER_CHAR.test(before) && !IDENTIFIER_CHAR.test(after)) return true
  }
  return false
}

/** `import type` 不算 drive——只借类型不构造实现，跑不到任何一行。 */
const VALUE_IMPORT =
  /(?:^|\n)\s*import\s+(?!type\s)[\s\S]{0,600}?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g

/** 把一个测试文件里的值 import 解析成 `src` 相对路径集合（解析不到 `src` 的一律丢弃）。 */
function valueImportsOfTest(rel: string, text: string): Set<string> {
  const from = join(TESTS, rel)
  const out = new Set<string>()
  VALUE_IMPORT.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = VALUE_IMPORT.exec(text)) !== null) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4]
    if (specifier === undefined) continue
    let base: string
    if (specifier.startsWith('@/')) base = join(SRC, specifier.slice(2))
    else if (specifier.startsWith('.')) base = normalize(join(dirname(from), specifier))
    else continue
    for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
      if (candidate.endsWith('.ts') && existsSync(candidate)) {
        out.add(candidate.slice(SRC.length + 1))
        break
      }
    }
  }
  return out
}

let cached: Scan | undefined

/** 两棵树各读一遍，五个用例共用（全树扫描必须缓存，否则 CI 上按秒累加）。 */
function scan(): Scan {
  if (cached !== undefined) return cached

  const sourceFiles = listTypescript(SRC)
  // `architecture/` 整体排除：守卫的账本按路径点名 provider 文件，却一行都不驱动它们
  // ——把它们计进来会给每一侧均匀加一份噪声，还会让本文件扫到自己。
  const testFiles = listTypescript(TESTS).filter((rel) => !rel.startsWith('architecture/'))

  const pairs = new Map<string, { sqlite?: string; postgresql?: string }>()
  let providerNamed = 0
  for (const rel of sourceFiles) {
    const cut = rel.lastIndexOf('/')
    const directory = cut < 0 ? '' : rel.slice(0, cut)
    const base = rel.slice(cut + 1).replace(/\.ts$/, '')
    const prefix = PROVIDER_PREFIX.exec(base)?.[1]
    if (prefix === undefined) continue
    providerNamed += 1
    const key = `${directory}/${base.slice(prefix.length)}`
    const slot = pairs.get(key) ?? {}
    slot[prefix === 'sqlite' ? 'sqlite' : 'postgresql'] = rel
    pairs.set(key, slot)
  }

  const texts = new Map<string, string>()
  const imports = new Map<string, Set<string>>()
  for (const rel of testFiles) {
    const text = readFileSync(join(TESTS, rel), 'utf8')
    texts.set(rel, text)
    imports.set(rel, valueImportsOfTest(rel, text))
  }

  const measure = (implementation: string): Side => {
    const base = implementation.slice(implementation.lastIndexOf('/') + 1).replace(/\.ts$/, '')
    const needles = new Set<string>([base])
    for (const symbol of readFileSync(join(SRC, implementation), 'utf8').matchAll(
      EXPORTED_SYMBOL,
    )) {
      const name = symbol[1]
      if (name !== undefined) needles.add(name)
    }
    const all = [...needles]
    let refs = 0
    let drives = 0
    for (const rel of testFiles) {
      if (all.some((needle) => mentionsIdentifier(texts.get(rel) ?? '', needle))) refs += 1
      if (imports.get(rel)?.has(implementation) === true) drives += 1
    }
    return { refs, drives }
  }

  const rows: string[] = []
  const inverted: string[] = []
  for (const [key, slot] of [...pairs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (slot.sqlite === undefined || slot.postgresql === undefined) continue
    const sqlite = measure(slot.sqlite)
    const postgresql = measure(slot.postgresql)
    rows.push(
      `${key}: sqlite ${sqlite.refs}/${sqlite.drives}, postgresql ${postgresql.refs}/${postgresql.drives}`,
    )
    if (Math.abs(sqlite.refs - postgresql.refs) >= REFERENCE_GAP_THRESHOLD) {
      inverted.push(`${key}: ${sqlite.refs} vs ${postgresql.refs}`)
    }
  }

  cached = {
    sourceFiles,
    testFiles,
    providerNamed,
    rows,
    inverted,
  }
  return cached
}

describe('RFC-359 W5-T19d —— 成对适配器的覆盖对等（高水位，只降不升）', () => {
  test('语料非空：两棵树都扫到了，且 provider 命名匹配器仍咬得动（扫空 / 不咬 = 假绿）', () => {
    expect(
      scan().sourceFiles.length,
      '扫到的 backend 源文件太少——扫描根多半失效了，此刻这条守卫零预言力。',
    ).toBeGreaterThanOrEqual(1_500)
    expect(
      scan().testFiles.length,
      '扫到的 backend 测试文件太少——扫描根多半失效了，两个通道都会一起归零。',
    ).toBeGreaterThanOrEqual(1_500)
    expect(
      scan().providerNamed,
      '全树一个 provider 命名的实现文件都没扫到——前缀匹配器已经不咬人了。' +
        '账本清空后这条守卫会变成永久假绿，先修匹配器再说。',
    ).toBeGreaterThanOrEqual(40)
  }, 30_000)

  test('客户端机制对仍被识别（配对判据失效不能让账本静默变空）', () => {
    expect(
      scan().rows.some((row) => row.startsWith('platform/persistence/LogicalSource:')),
      '两侧已登记的 LogicalSource 客户端机制没有配上，先检查扫描根与前缀匹配器。',
      // RFC-359 W12：自动修复合一使 10 → 9。固定债务下限会阻止真实收敛，改用必须保留的
      // 客户端机制对作正向锚点；整树语料地板与精确账本继续独立生效。
    ).toBe(true)
  }, 30_000)

  test('逐对的两侧引用 / 驱动数与账本逐字相等（倒挂加深了红，收敛了也红）', () => {
    expect(
      [...scan().rows],
      '成对适配器的覆盖对等与账本不符。口径见文件头：`ref` = 提到该侧模块名或导出符号的测试文件数' +
        '（同 `scripts/tests-referencing.sh`），`drive` = 有值 import 能真正构造它的测试文件数' +
        '（源码形状锁记 0）。' +
        '**倒挂加深**（一侧涨 / 另一侧跌）说明又在给已经被盯着的那一侧加判据——那一侧越强，' +
        '另一侧就越是在无人看管地漂移，正是 dual-provider-parity-audit-2026-09-04 里 12 条 P0 的孵化方式；' +
        '优先把判据写成 `describeEachProvider`，让一条测试同时喂到两侧。' +
        '**倒挂收敛**（补齐了弱侧、或两侧合一了）也要改账本，让这次补齐留下一次有署名的提交记录。',
    ).toEqual([...COVERAGE_PARITY_LEDGER])
  }, 30_000)

  test(`两侧引用差 >= ${String(REFERENCE_GAP_THRESHOLD)} 的对与观察名单逐字相等（新的深度倒挂即红）`, () => {
    expect(
      [...scan().inverted],
      `两侧引用差 >= ${String(REFERENCE_GAP_THRESHOLD)} 的对与观察名单不符。` +
        '**多**了一对说明有个 port 的两侧注意力刚刚拉开到阈值以上——这是「先合谁」的信号，' +
        '不是记账问题：弱侧此刻正在无人看管地漂移。' +
        '**少**了一对说明补齐或合一发生了，把它从名单里删掉。',
    ).toEqual([...INVERTED_PAIRS])
  }, 30_000)

  test('两份账本都按路径字典序、无重复（清点稳定的前提）', () => {
    for (const [name, ledger] of [
      ['COVERAGE_PARITY_LEDGER', COVERAGE_PARITY_LEDGER],
      ['INVERTED_PAIRS', INVERTED_PAIRS],
    ] as const) {
      const paths = ledger.map((row) => row.slice(0, row.indexOf(': ')))
      expect(new Set(paths).size, `${name} 里有重复的对`).toBe(paths.length)
      expect([...paths].sort(), `${name} 没有按路径字典序排列`).toEqual(paths)
    }
  }, 30_000)

  test('标识符边界匹配的负 fixture：邻居模块的引用不得被算到本模块头上', () => {
    // 真语料之外的独立证明——匹配器一旦被放宽成裸 `includes`，这条当场红。
    expect(
      mentionsIdentifier("from '@/x/sqliteTaskExecutionRecovery'", 'sqliteTaskExecutionRecovery'),
    ).toBe(true)
    expect(
      mentionsIdentifier(
        "from '@/x/sqliteTaskExecutionRecoveryPersistence'",
        'sqliteTaskExecutionRecovery',
      ),
      '邻居模块 `…RecoveryPersistence` 的引用被算成了 `…Recovery` 的——一侧会被虚抬，倒挂就此测不准。',
    ).toBe(false)
    expect(mentionsIdentifier('new SqliteRealtimeStore(db)', 'SqliteRealtimeStore')).toBe(true)
    expect(mentionsIdentifier('legacySqliteRealtimeStore', 'SqliteRealtimeStore')).toBe(false)
  }, 30_000)
})
