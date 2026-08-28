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
// 本文件只锁清单：迁移期每次改动与新增 scheduler.ts 源码锁都须登记，是 T1① / T3-T7 的检查表。
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
const MUST_HAVE_BEHAVIOR_FIXTURE = [
  'rfc208-unbounded-git-and-permits.test.ts',
  'rfc210-publish-failure-hard-fails.test.ts',
  'process-node-concurrency.test.ts',
] as const

/**
 * 读 `src/services/scheduler.ts` 源码文本的测试文件全集（RFC-332 迁移后的精确基线）。
 * 改动本清单 = 迁移动作，必须同批说明处置分类。
 */
const SCHEDULER_SOURCE_LOCK_FILES: readonly string[] = [
  'agent-output-kinds-scheduler-load.test.ts',
  'clarify-prompt-wire-up.test.ts',
  'depcheck-gate.test.ts',
  'envelope-followup-source-grep.test.ts',
  'freshness.test.ts',
  'retry-budget-single-source.test.ts',
  'review-dispatch-prefers-clarify-rerun.test.ts',
  'rfc098-commitpush-nonblocking.test.ts',
  'rfc098-git-wrapper-diff-fail.test.ts',
  'rfc103-fanout-kind-aware-split.test.ts',
  'rfc120-deferred-dispatch.test.ts',
  'rfc130-shard-rerun-undo.test.ts',
  'rfc143-runtime-driver-capability.test.ts',
  'rfc144-stale-replay-regression.test.ts',
  'rfc188-isolated-agent-run.test.ts',
  'rfc193-wrapper-review.test.ts',
  'rfc200-source-lock.test.ts',
  'rfc202-source-locks.test.ts',
  'rfc208-unbounded-git-and-permits.test.ts',
  'rfc210-publish-failure-hard-fails.test.ts',
  'rfc223-pr2-refs.test.ts',
  'rfc230-wrapper-finalize-superseded.test.ts',
  'rfc271-ref-contract.test.ts',
  'rfc282-b2-resolve-injection.test.ts',
  'rfc285-b3-inherited-actor.test.ts',
  'rfc287-t1-broadcast-sequence.test.ts',
  'rfc287-t1-discard-failure-paths.test.ts',
  'rfc287-t1-line-throw-disposition.test.ts',
  'rfc287-t1-merge-disposition-matrix.test.ts',
  'rfc287-t1-release-before-discard.test.ts',
  // T14 新增（字符串序里 `t14` 在 `t5` 之前：第 9 位 '1' < '5'）：
  // fanout 两条线撞冲突落 abandon（既存缺陷，用户拍板本 RFC 内补）。
  'rfc287-t14-fanout-merge-conflict-abandon.test.ts',
  'rfc287-t5-script-merge-throw.test.ts',
  // T8 新增：取行前奏收编后的「单一实现 + 四线×五项差异矩阵」锁。
  'rfc287-t8-run-row-prelude-single-source.test.ts',
  // T9 新增：G3 四条豁免的理由锁 + 装配散写的终局灭绝锁（三处显式挖洞）。
  'rfc287-t9-exemptions-and-extinction.test.ts',
  'rfc292-trigger-source-locks.test.ts',
  // RFC-313：锁住「升级预算只有一处推进、形状判定只有一个定义点」。
  'rfc313-source-locks.test.ts',
  // RFC-331：拓扑切割的 source guard 锁住 task↔scheduler 与 call-graph 三条断边。
  'rfc331-task-execution-topology.test.ts',
  // RFC-332：旧 body 灭绝断言仍显式读取 scheduler facade。
  'rfc332-task-engine-contracts.test.ts',
  // RFC-308: locks task-execution → source-control participant wiring and the
  // absence of a second add/commit/push implementation in code-capability.
  'runner-injected-memories.test.ts',
  'runner-resume-session-flag.test.ts',
  'scheduler-audit-s02-multirepo-retry-rollback-noop.test.ts',
  'scheduler-audit-s05-fanout-inner-chain.test.ts',
  'scheduler-audit-s13-freshest-fork-source-guards.test.ts',
  'scheduler-audit-s17-readonly-starved-by-writer-queue.test.ts',
  'scheduler-audit-s21-fanout-aggregator-idempotency.test.ts',
  'scheduler-boundary-resume-retryindex-vs-id.test.ts',
  'scheduler-node-overrides.test.ts',
  'scheduler-shard-item-kind-stringify.test.ts',
  'scheduler-subagent-live-capture-passthrough.test.ts',
  'scheduler-wrapper-fanout-routing.test.ts',
  'source-text-rfc066-guards.test.ts',
  'source-text-rfc066-pr-b-guards.test.ts',
  'source-text-rfc067-guards.test.ts',
  'wrapper-git-list-path.test.ts',
]

/**
 * 一份测试源码算不算「scheduler.ts 源码文本锁」。**纯函数**——扫描与 RFC-317 T14
 * 的「matcher 自证」共用它。判据只要有一支失配，清单就会安静地缩短，而
 * `expect(scanActual()).toEqual(清单)` 会被同批「顺手更新清单」的动作抹平。
 */
function isSchedulerSourceLock(source: string): boolean {
  const readsFile = /(readFileSync|readFile)\(/.test(source)
  const namesScheduler = /services\/scheduler\.ts|'scheduler\.ts'/.test(source)
  return readsFile && namesScheduler
}

function scanActual(): string[] {
  const out: string[] = []
  for (const name of readdirSync(TESTS_DIR)) {
    if (!name.endsWith('.test.ts')) continue
    if (name === 'rfc287-t1-scheduler-source-lock-inventory.test.ts') continue // 本清单自身
    if (isSchedulerSourceLock(readFileSync(resolve(TESTS_DIR, name), 'utf8'))) out.push(name)
  }
  return out.sort()
}

describe('RFC-287 T1① — scheduler.ts 源码文本锁清单', () => {
  test('清单与实际扫描一致（迁移期动一个就同步一个）', () => {
    expect(scanActual()).toEqual([...SCHEDULER_SOURCE_LOCK_FILES])
  })

  test('必须换成行为夹具的三份仍有独立处置（RFC-334 已完成 process 迁址）', () => {
    for (const f of MUST_HAVE_BEHAVIOR_FIXTURE) {
      const source = readFileSync(resolve(TESTS_DIR, f), 'utf8')
      expect(source.length).toBeGreaterThan(0)
    }
    expect(SCHEDULER_SOURCE_LOCK_FILES).toContain('rfc208-unbounded-git-and-permits.test.ts')
    expect(SCHEDULER_SOURCE_LOCK_FILES).toContain('rfc210-publish-failure-hard-fails.test.ts')
    expect(SCHEDULER_SOURCE_LOCK_FILES).not.toContain('process-node-concurrency.test.ts')
    const processFixture = readFileSync(
      resolve(TESTS_DIR, 'process-node-concurrency.test.ts'),
      'utf8',
    )
    expect(processFixture).toContain('same daemon scope shares one limiter')
    expect(processFixture).toContain('a full agent pool never blocks a script acquire')
  })
})

// RFC-317 T13 —— 语料非空（守卫的守卫：architecture/rfc317-guard-corpus-floor.test.ts）。
//
// 上面每条断言的绿都可能来自两处：真的没有违规，或者**扫描根失效、语料被筛成空**。
// 两者在断言层面同形，后者是永久静默的假绿。这一条把「扫描器还活着」变成可断言事实；
// 下限同时两向钉进 architecture/guard-manifest.json，静默调低会红。
describe('RFC-317 T13 —— 语料非空', () => {
  test('扫描确实覆盖到源码语料（扫空即假绿）', () => {
    expect(
      readdirSync(TESTS_DIR).filter((name) => name.endsWith('.test.ts')).length,
    ).toBeGreaterThanOrEqual(800)
  })
})

// RFC-317 T14 —— 负 fixture：把伪造的测试源码喂给**扫描用的同一份判据**。
//
// 本清单的断言是 `expect(scanActual()).toEqual(SCHEDULER_SOURCE_LOCK_FILES)`——两边
// 一起动就永远相等。真正的静默失效在判据：`isSchedulerSourceLock` 少认一种写法
// （比如只认 `services/scheduler.ts` 不认裸 `'scheduler.ts'`），清单会安静地缩短，
// 而下一次「顺手更新清单」把差额抹平，从此没人知道少锁了哪几个文件。
describe('RFC-317 T14 —— matcher 自证：清单判据的两支都必须还在', () => {
  test('读文件 + 点名 scheduler，两支都命中才算源码文本锁', () => {
    const readsAndNames =
      "const src = readFileSync(resolve(SRC, 'services/scheduler.ts'), 'utf8')\n"
    expect(isSchedulerSourceLock(readsAndNames)).toBe(true)
    const bareName = "const src = readFileSync(join(dir, 'scheduler.ts'), 'utf8')\n"
    expect(isSchedulerSourceLock(bareName)).toBe(true)
  })

  test('只占一支不算：光读文件、或光提到 scheduler，都不是源码文本锁', () => {
    expect(isSchedulerSourceLock("const src = readFileSync(p, 'utf8')\n")).toBe(false)
    expect(isSchedulerSourceLock("import { dispatch } from '@/services/scheduler.ts'\n")).toBe(
      false,
    )
  })

  test('异步读法也算（判据刻意同时认 readFileSync 与 readFile）', () => {
    expect(isSchedulerSourceLock("await readFile('services/scheduler.ts', 'utf8')\n")).toBe(true)
  })
})
