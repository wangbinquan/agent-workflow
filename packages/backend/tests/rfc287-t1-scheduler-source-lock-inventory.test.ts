// RFC-287 T1① —— scheduler.ts 源码文本锁的**全量清单与迁移账本**。
//
// 为什么存在：RFC-287 把五条 spawn 装配线收进 `runAssembly` 骨架。三轮设计门
// 反复指出同一个风险——现在锁着这些行为的测试里有一大批是**源码文本锁**
// （断言 scheduler.ts 里出现/不出现某段字符串）。骨架一抽，它们必然大面积转红，
// 而**改锚之后它们就不再有独立的预言力**（锚到新文件的新文本，等于把断言重写成
// 「现在的代码长这样」）。最危险的是那种「把阈值改小就绿了」的锁：rfc210 的
// `discardNodeIso(...) >= 8` 与 rfc208 的 try-depth 扫描器都属此类，一改数字/
// 换文件，不变量就静默失守。
//
// 本文件不锁任何行为，只锁**清单本身**：迁移期每动一个文件，这里必须同步；
// 新增一个读 scheduler.ts 源码的测试也必须登记。它是 T1 交付物①，也是 T3-T7
// 各批的改锚检查表。
//
// 处置分类（见 design §10.2/§10.10）：
//   · 纯改锚      —— 锁的文本随代码搬家，改成新文件路径即可。
//   · 须换行为夹具 —— 锁的是「不变量」而非「代码形状」，改锚会让它失效，必须由
//                     行为断言接手。当前已识别：rfc210（keep 语义 + discard 带
//                     writeSem 的安全棘轮）、rfc208（释放序 + try-depth 扫描器）、
//                     process-node-concurrency（script 分支不取 agentSem）。
//   · 迁移后作废  —— 锁的段落本身被删除。

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const TESTS_DIR = resolve(import.meta.dir)

/** 迁移期必须由行为夹具接手、不得靠改锚了事的（design §10.10）。 */
const MUST_BECOME_BEHAVIOR_FIXTURE = [
  'rfc208-unbounded-git-and-permits.test.ts',
  'rfc210-publish-failure-hard-fails.test.ts',
  'process-node-concurrency.test.ts',
] as const

/**
 * 读 `src/services/scheduler.ts` 源码文本的测试文件全集（2026-08-13 基线，79 个）。
 * 改动本清单 = 迁移动作，必须同批说明处置分类。
 */
const SCHEDULER_SOURCE_LOCK_FILES: readonly string[] = [
  'agent-output-kinds-scheduler-load.test.ts',
  'clarify-inline-fallback.test.ts',
  'clarify-prompt-wire-up.test.ts',
  'cross-clarify-baseline-patches.test.ts',
  'cross-clarify-stop-directive-scoped-to-cci-rerun.test.ts',
  'depcheck-gate.test.ts',
  'envelope-followup-source-grep.test.ts',
  'freshness.test.ts',
  'node-run-mint.test.ts',
  'process-node-concurrency.test.ts',
  'rerun-prior-output-source-guards.test.ts',
  'retry-budget-single-source.test.ts',
  'review-dispatch-prefers-clarify-rerun.test.ts',
  'rfc064-source-grep-guards.test.ts',
  'rfc098-commitpush-nonblocking.test.ts',
  'rfc098-git-wrapper-diff-fail.test.ts',
  'rfc098-rerun-cause-gates.test.ts',
  'rfc098-write-lock-registry.test.ts',
  'rfc103-fanout-kind-aware-split.test.ts',
  'rfc103-launch-config-passthrough.test.ts',
  'rfc120-deferred-dispatch.test.ts',
  'rfc122-clarify-directive-dispatch.test.ts',
  'rfc123-clarify-directive-single-source.test.ts',
  'rfc123-stop-enforcement.test.ts',
  'rfc127-borrow.test.ts',
  'rfc127-self-questioner-borrow.test.ts',
  'rfc128-p5-a-pre-refactor-net.test.ts',
  'rfc128-p5-d-autodispatch.test.ts',
  'rfc130-shard-rerun-undo.test.ts',
  'rfc143-runtime-driver-capability.test.ts',
  'rfc144-stale-replay-regression.test.ts',
  'rfc146-kind-predicate-guard.test.ts',
  'rfc147-system-channel-ports.test.ts',
  'rfc164-workgroup-engine.test.ts',
  'rfc165-optional-clarify.test.ts',
  'rfc167-dynamic-workflow-engine.test.ts',
  'rfc181-autonomous-hardening.test.ts',
  'rfc183-clarify-invite-accept-symmetry.test.ts',
  'rfc187-wg-merge-conflict-abandon.test.ts',
  'rfc187-zero-delta-done.test.ts',
  'rfc188-isolated-agent-run.test.ts',
  'rfc193-wrapper-review.test.ts',
  'rfc200-source-lock.test.ts',
  'rfc202-source-locks.test.ts',
  'rfc208-unbounded-git-and-permits.test.ts',
  'rfc210-publish-failure-hard-fails.test.ts',
  'rfc223-pr2-refs.test.ts',
  'rfc230-wrapper-finalize-superseded.test.ts',
  'rfc243-execution-outcome.test.ts',
  'rfc243-executor-facade.test.ts',
  'rfc243-parent-child-lifecycle.test.ts',
  'rfc253-script-execution.test.ts',
  'rfc266-task-fanout-pools.test.ts',
  'rfc271-ref-contract.test.ts',
  'rfc282-b2-resolve-injection.test.ts',
  'rfc284-t20-child-inheritance.test.ts',
  'rfc285-b3-inherited-actor.test.ts',
  'rfc287-t1-broadcast-sequence.test.ts',
  'rfc287-t1-discard-failure-paths.test.ts',
  'rfc287-t1-line-throw-disposition.test.ts',
  'rfc287-t1-merge-disposition-matrix.test.ts',
  'rfc287-t1-release-before-discard.test.ts',
  // T14 新增（字符串序里 `t14` 在 `t5` 之前：第 9 位 '1' < '5'）：
  //  · fanout 两条线撞冲突落 abandon（既存缺陷，用户拍板本 RFC 内补）；
  //  · 实现门抓出的迁移期回归（脚本线 preAttempt 抢占位置 + 两处对外契约）。
  'rfc287-t14-fanout-merge-conflict-abandon.test.ts',
  'rfc287-t14-impl-gate-fixes.test.ts',
  'rfc287-t5-script-merge-throw.test.ts',
  // T8 新增：取行前奏收编后的「单一实现 + 四线×五项差异矩阵」锁。
  'rfc287-t8-run-row-prelude-single-source.test.ts',
  // T9 新增：G3 四条豁免的理由锁 + 装配散写的终局灭绝锁（三处显式挖洞）。
  'rfc287-t9-exemptions-and-extinction.test.ts',
  'rfc292-trigger-source-locks.test.ts',
  // RFC-304 §2.3：daemon 代际的接线锁。代际只在**跨进程**才不同，一个进程内的
  // 行为断言看不出「恒为 'dev'」与「每次启动新铸」的区别，所以这条只能锁源码：
  // scheduler 必须走 `resolveDaemonGeneration`，且不得退回字面量兜底。
  'rfc304-lease-heartbeat-and-generation.test.ts',
  // RFC-304 §11.2：人工指令回执的接线锁。加它的直接原因是一次过界的回退把
  // `closeReceiptForRound` 的调用整块删掉了——照样编译、单测照样全绿，只有
  // `--max-warnings 0` 因为那个 import 变成未使用才报出来。没有锁的接线可以在
  // 没有任何红用例的情况下消失，而那正是本 RFC 一直在修的那类缺陷。
  'rfc304-manual-receipt.test.ts',
  // RFC-304 2ter.2：能力配置的主键锁——`repo_capability_config.repo_id` 存的是
  // cached-repo ULID，而调度器曾传 `task.repoPath`（文件路径）。两者都是 string，
  // 类型与运行时都抓不住，只能锁「那个错误写法不许再出现」。
  'rfc304-round-lifecycle-and-keys.test.ts',
  // RFC-305 delegated-authority architecture lock verifies the three reviewed
  // scheduler launch sources while keeping the underlying behavior fixtures.
  'rfc305-architecture-lock.test.ts',
  'runner-injected-memories.test.ts',
  'runner-resume-session-flag.test.ts',
  'scheduler-audit-s02-multirepo-retry-rollback-noop.test.ts',
  'scheduler-audit-s05-fanout-inner-chain.test.ts',
  'scheduler-audit-s13-freshest-fork-source-guards.test.ts',
  'scheduler-audit-s17-readonly-starved-by-writer-queue.test.ts',
  'scheduler-audit-s21-fanout-aggregator-idempotency.test.ts',
  'scheduler-boundary-resume-retryindex-vs-id.test.ts',
  'scheduler-clarify-baseline.test.ts',
  'scheduler-cross-clarify-dispatch.test.ts',
  'scheduler-cross-clarify-no-runaway.test.ts',
  'scheduler-node-overrides.test.ts',
  'scheduler-shard-item-kind-stringify.test.ts',
  'scheduler-subagent-live-capture-passthrough.test.ts',
  'scheduler-transitive-dispatch-gate.test.ts',
  'scheduler-wrapper-fanout-routing.test.ts',
  'source-text-rfc066-guards.test.ts',
  'source-text-rfc066-pr-b-guards.test.ts',
  'source-text-rfc067-guards.test.ts',
  'workgroup-host-output-isolation.test.ts',
  'wrapper-git-list-path.test.ts',
]

function scanActual(): string[] {
  const out: string[] = []
  for (const name of readdirSync(TESTS_DIR)) {
    if (!name.endsWith('.test.ts')) continue
    if (name === 'rfc287-t1-scheduler-source-lock-inventory.test.ts') continue // 本清单自身
    const src = readFileSync(resolve(TESTS_DIR, name), 'utf8')
    const readsFile = /(readFileSync|readFile)\(/.test(src)
    const namesScheduler = /services\/scheduler\.ts|'scheduler\.ts'/.test(src)
    if (readsFile && namesScheduler) out.push(name)
  }
  return out.sort()
}

describe('RFC-287 T1① — scheduler.ts 源码文本锁清单', () => {
  test('清单与实际扫描一致（迁移期动一个就同步一个）', () => {
    expect(scanActual()).toEqual([...SCHEDULER_SOURCE_LOCK_FILES])
  })

  test('必须换成行为夹具的三份仍在清单里（改锚了事即为回归）', () => {
    for (const f of MUST_BECOME_BEHAVIOR_FIXTURE) {
      expect(SCHEDULER_SOURCE_LOCK_FILES).toContain(f)
    }
  })
})
