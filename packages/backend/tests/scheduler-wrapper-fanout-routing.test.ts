// RFC-060 PR-D — wrapper-fanout runtime routing locks.
//
// Source-text guards for the WrapperRuntime dispatch contract:
//
//   D.T2 — wrapper-fanout passes the node-kind whitelist, the dispatch
//          switch in runOneNode has a `wrapper-fanout` case, and
//          buildContainerMap walks wrapper-fanout's nodeIds.
//   D.T3 — the aggregator-dispatch helper exists and collects per-shard
//          outputs into raw lists (via parentNodeRunId + shardKey lookup).
//   D.T6 — estimateShardTotal is called from runFanoutWrapperNode and
//          short-circuits to `wrapper-fanout-cartesian-exceeds-max`.
//   D.T7 — the runner consumes inputPortKinds and the scheduler builds
//          one for boundary-input edges (signal kind passthrough).
//   D.T8 — WrapperRuntime owns the common lifecycle; concrete mechanics only
//          return settlements through the ledger/publisher ports.
//
// All assertions are file-text patterns. Pure-function helpers
// (computeShardScope / applyAutoPromote / estimateShardTotal) are
// independently exercised in fanout-shard-scope.test.ts (D.T1).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'

const wrapperMechanicsSrc = readFileSync(
  resolve(
    import.meta.dirname,
    '..',
    'src',
    'modules',
    'task-execution',
    'composition',
    'wrapperMechanics.ts',
  ),
  'utf8',
)
const runnerSrc = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'services', 'runner.ts'),
  'utf8',
)
const taskEngineApplicationSrc = readFileSync(
  resolve(
    import.meta.dirname,
    '..',
    'src',
    'modules',
    'task-execution',
    'composition',
    'taskEngineApplication.ts',
  ),
  'utf8',
)
const taskEngineRuntimeOptionsSrc = readFileSync(
  resolve(
    import.meta.dirname,
    '..',
    'src',
    'modules',
    'task-execution',
    'composition',
    'taskEngineRuntimeOptions.ts',
  ),
  'utf8',
)
const nodeExecutionCompositionSrc = readFileSync(
  resolve(
    import.meta.dirname,
    '..',
    'src',
    'modules',
    'task-execution',
    'composition',
    'nodeExecution.ts',
  ),
  'utf8',
)
const wrapperRuntimeCompositionSrc = readFileSync(
  resolve(
    import.meta.dirname,
    '..',
    'src',
    'modules',
    'task-execution',
    'composition',
    'wrapperRuntime.ts',
  ),
  'utf8',
)
const wrapperLifecycleSrc = readFileSync(
  resolve(
    import.meta.dirname,
    '..',
    'src',
    'modules',
    'task-execution',
    'composition',
    'wrapperRunLifecycle.ts',
  ),
  'utf8',
)
const fanoutStrategySrc = readFileSync(
  resolve(
    import.meta.dirname,
    '..',
    'src',
    'modules',
    'task-execution',
    'engine',
    'wrapper',
    'fanoutStrategy.ts',
  ),
  'utf8',
)
const nodeExecutorRegistrySrc = readFileSync(
  resolve(
    import.meta.dirname,
    '..',
    'src',
    'modules',
    'task-execution',
    'engine',
    'node',
    'nodeExecutorRegistry.ts',
  ),
  'utf8',
)
const scopeIndexSrc = readFileSync(
  resolve(
    import.meta.dirname,
    '..',
    'src',
    'modules',
    'task-execution',
    'domain',
    'executionScope.ts',
  ),
  'utf8',
)

describe('D.T2 — scheduler accepts wrapper-fanout kind', () => {
  test("validate-node-kinds whitelist includes 'wrapper-fanout'", () => {
    // flag-audit W0-4 replaced the hand-written `node.kind !== 'wrapper-*'`
    // triple with !isWrapperKind; RFC-146 then replaced the whole negative
    // enum with positive behavior-table membership. The contract (fanout
    // passes the whitelist) now rests on the table lock: wrapper-fanout is a
    // NODE_KIND_BEHAVIORS key (packages/backend/tests/
    // node-kind-behavior-table.test.ts asserts key-set === NODE_KIND).
    expect(taskEngineApplicationSrc).toMatch(/!Object\.hasOwn\(NODE_KIND_BEHAVIORS, node\.kind\)/)
  })

  test("closed registry dispatches 'wrapper-fanout' through the W2-D delegation port", () => {
    expect(nodeExecutorRegistrySrc).toContain("'wrapper-fanout': Object.freeze")
    expect(nodeExecutionCompositionSrc).toContain('wrapperRuntimeFactory(state)')
    expect(nodeExecutionCompositionSrc).not.toContain('composeWrapperRuntime')
    expect(wrapperRuntimeCompositionSrc).toContain("'wrapper-fanout': new FanoutStrategy")
    expect(wrapperRuntimeCompositionSrc).toContain(
      'new FanoutStrategy(ports.data, ports.fanoutAttempts)',
    )
    expect(nodeExecutionCompositionSrc).toContain('createWrapperDelegatingNodeExecutors')
  })

  test('FanoutStrategy owns the outer fanout orchestration', () => {
    expect(fanoutStrategySrc).toContain('export class FanoutStrategy')
    expect(fanoutStrategySrc).toContain('private async executePrepared(')
  })

  test('ExecutionScopeIndex walks wrapper-fanout (so inner nodeIds get containment)', () => {
    // Scope containment is now owned by the shared workflow-scope oracle, so
    // scheduler readiness, source promotion, and frontend layout cannot drift
    // into three different wrapper-membership implementations.
    expect(scopeIndexSrc).toContain('analyzeWorkflowScopeTree(definition)')
    expect(scopeIndexSrc).toContain('directNodeIds: Object.freeze([')
    expect(scopeIndexSrc).toContain('...directNodeIdsOf(')
    expect(wrapperMechanicsSrc).not.toContain("pickStringArray(node, 'nodeIds')")
  })

  test('opts.fanoutMaxShardTotal field exists on the provider-neutral task-engine options', () => {
    expect(taskEngineRuntimeOptionsSrc).toContain('fanoutMaxShardTotal?:')
  })
})

describe('D.T3 — aggregator dispatch helper exists + collects per-shard raw lists', () => {
  test('dispatchFanoutAggregator function defined', () => {
    expect(wrapperMechanicsSrc).toContain('async function dispatchFanoutAggregator(')
  })

  test('aggregator collects inner runs anchored on non-null parent + iteration (RFC-098 B3 relaxed anchor)', () => {
    // RFC-098 B3 (audit S-19/S-21) widened the read anchor from
    // `eq(nodeRuns.parentNodeRunId, wrapperRunId)` to `parentNodeRunId IS NOT
    // NULL` + `iteration` so a retried wrapper generation can see the previous
    // generation's replayed done children; per-row picking moved to the shared
    // done-only picker (pickReusableShardRun). The child rows stay
    // frontier-invisible because parent is still non-null.
    expect(wrapperMechanicsSrc).toContain('iteration,')
    expect(wrapperMechanicsSrc).toContain('childOnly: true')
    expect(wrapperMechanicsSrc).toMatch(/pickReusableShardRun\(innerRows, \{/)
  })

  test('aggregator iterates shards in shardKey dictionary order', () => {
    expect(wrapperMechanicsSrc).toMatch(/sortedShards = \[\.\.\.shards\]\.sort/)
    expect(wrapperMechanicsSrc).toMatch(/\.localeCompare\(/)
  })

  test('aggregator emits raw lists as `### <shardKey>` delimited blocks', () => {
    // The PR-D minimum format documented in dispatchFanoutAggregator's
    // doc-comment: each per-shard output is prefixed with `### shardKey`.
    expect(wrapperMechanicsSrc).toMatch(/### \$\{s\.shardKey\}/)
  })

  test('aggregator renames outputs via outputWrapperPortNames into wrapper outlets', () => {
    expect(fanoutStrategySrc).toContain('outputWrapperPortNames')
    expect(fanoutStrategySrc).toMatch(/renames\[port\] \?\? port/)
  })

  test('no-aggregator case emits FANOUT_DONE_PORT_NAME signal outlet', () => {
    expect(fanoutStrategySrc).toContain('FANOUT_DONE_PORT_NAME')
  })
})

describe('D.T6 — runtime cartesian guard', () => {
  test('estimateShardTotal is imported and called for the projected total', () => {
    expect(fanoutStrategySrc).toMatch(/import\s*\{[^}]*estimateShardTotal/s)
    expect(fanoutStrategySrc).toContain(
      'estimateShardTotal(definition, request.scope, items.length)',
    )
  })

  test('guard short-circuits with wrapper-fanout-cartesian-exceeds-max error message', () => {
    expect(fanoutStrategySrc).toContain('wrapper-fanout-cartesian-exceeds-max')
  })

  test('default fanoutMaxShardTotal = 256 when opts unset', () => {
    expect(wrapperMechanicsSrc).toContain(
      'fanoutMaxShardTotal: state.opts.fanoutMaxShardTotal ?? 256',
    )
    expect(fanoutStrategySrc).toContain('this.data.fanoutMaxShardTotal')
  })
})

describe('D.T7 — signal port in prompt runtime check', () => {
  test('runner imports assertNoPromptSignalRefs + SignalPortInPromptError', () => {
    expect(runnerSrc).toContain('assertNoPromptSignalRefs')
    expect(runnerSrc).toContain('SignalPortInPromptError')
  })

  test('runner has inputPortKinds field on RunNodeOptions', () => {
    expect(runnerSrc).toContain('inputPortKinds?: Record<string, string>')
  })

  test('runner runs the assert check before render and returns signal-port-in-prompt errMsg on violation', () => {
    expect(runnerSrc).toMatch(
      /assertNoPromptSignalRefs\(opts\.promptTemplate, opts\.inputPortKinds\)/,
    )
    expect(runnerSrc).toMatch(/signal-port-in-prompt/)
  })

  test('wrapper dispatchFanoutShard builds inputPortKinds from boundaryEdges', () => {
    expect(wrapperMechanicsSrc).toContain('const inputPortKinds: Record<string, string> = {}')
    expect(wrapperMechanicsSrc).toMatch(/inputPortKinds\[e\.target\.portName\]/)
  })
})

describe('D.T8 — RFC-053 wrapper lifecycle compatibility', () => {
  test('fanout mechanics returns settlements to the common runtime lifecycle', () => {
    expect(fanoutStrategySrc).toContain("return wrapperSettlement('done'")
    expect(fanoutStrategySrc).toMatch(/wrapperSettlement\(\s*'failed'/)
    expect(wrapperLifecycleSrc).toContain("reason: 'wrapper-finalize'")
    expect(wrapperRuntimeCompositionSrc).toContain('createWrapperRunLedger(state)')
  })

  test('wrapper lifecycle handles resumable fanout generations', () => {
    expect(wrapperLifecycleSrc).toContain('state.opts.persistence.wrapperRuns.findResumable({')
    expect(wrapperLifecycleSrc).toContain('nodeId: request.node.id')
    expect(wrapperLifecycleSrc).toContain('iteration: request.iteration')
    expect(wrapperLifecycleSrc).toContain("'wrapper-fanout-resume'")
  })

  // RFC-317 T43 —— 这里原有一条 `wrapper-fanout joins isProcessNodeKind` 的测试，
  // 已删除。它的标题说自己在验证一个共享谓词，正文却只断言 scheduler.ts 里出现过
  // 一行 `from '@agent-workflow/shared'`——那条断言对任何改动都恒为真，唯一的内容
  // 是标题里那个名字。而该谓词本身（零生产调用者）也在 T43 一并删除了。
})
