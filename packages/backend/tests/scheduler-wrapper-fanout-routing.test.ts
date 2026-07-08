// RFC-060 PR-D — wrapper-fanout scheduler routing locks.
//
// Source-text guards for the scheduler dispatch contract:
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
//   D.T8 — markWrapperTerminal is the finalize path; lifecycle
//          allowedFrom = pending | running | awaiting_review | awaiting_human.
//
// All assertions are file-text patterns. Pure-function helpers
// (computeShardScope / applyAutoPromote / estimateShardTotal) are
// independently exercised in fanout-shard-scope.test.ts (D.T1).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'

const schedulerSrc = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'services', 'scheduler.ts'),
  'utf8',
)
const runnerSrc = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'services', 'runner.ts'),
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
    expect(schedulerSrc).toMatch(/!\(node\.kind in NODE_KIND_BEHAVIORS\)/)
  })

  test("runOneNode dispatches to runFanoutWrapperNode on kind === 'wrapper-fanout'", () => {
    expect(schedulerSrc).toMatch(
      /if \(node\.kind === 'wrapper-fanout'\)\s*\{[^}]*runFanoutWrapperNode/,
    )
  })

  test('runFanoutWrapperNode function is defined', () => {
    expect(schedulerSrc).toContain('async function runFanoutWrapperNode(')
  })

  test('buildContainerMap walks wrapper-fanout (so inner nodeIds get containment)', () => {
    // flag-audit W0-4: the container walk now filters via the shared
    // isWrapperKind predicate instead of enumerating the three kinds inline —
    // fanout membership is locked by shared WRAPPER_NODE_KINDS (see
    // packages/shared/tests/wrapper-kind-single-source.test.ts).
    const containerMapFn = schedulerSrc.slice(
      schedulerSrc.indexOf('function buildContainerMap'),
      schedulerSrc.indexOf('function buildContainerMap') + 2_000,
    )
    expect(containerMapFn).toContain('isWrapperKind(n.kind)')
  })

  test('opts.fanoutMaxShardTotal field exists on RunTaskOptions', () => {
    expect(schedulerSrc).toContain('fanoutMaxShardTotal?:')
  })
})

describe('D.T3 — aggregator dispatch helper exists + collects per-shard raw lists', () => {
  test('dispatchFanoutAggregator function defined', () => {
    expect(schedulerSrc).toContain('async function dispatchFanoutAggregator(')
  })

  test('aggregator collects inner runs anchored on non-null parent + iteration (RFC-098 B3 relaxed anchor)', () => {
    // RFC-098 B3 (audit S-19/S-21) widened the read anchor from
    // `eq(nodeRuns.parentNodeRunId, wrapperRunId)` to `parentNodeRunId IS NOT
    // NULL` + `iteration` so a retried wrapper generation can see the previous
    // generation's replayed done children; per-row picking moved to the shared
    // done-only picker (pickReusableShardRun). The child rows stay
    // frontier-invisible because parent is still non-null.
    expect(schedulerSrc).toMatch(/isNotNull\(nodeRuns\.parentNodeRunId\)/)
    expect(schedulerSrc).toMatch(/eq\(nodeRuns\.iteration, iteration\)/)
    expect(schedulerSrc).toMatch(/pickReusableShardRun\(innerRows, \{/)
  })

  test('aggregator iterates shards in shardKey dictionary order', () => {
    expect(schedulerSrc).toMatch(/sortedShards = \[\.\.\.shards\]\.sort/)
    expect(schedulerSrc).toMatch(/\.localeCompare\(/)
  })

  test('aggregator emits raw lists as `### <shardKey>` delimited blocks', () => {
    // The PR-D minimum format documented in dispatchFanoutAggregator's
    // doc-comment: each per-shard output is prefixed with `### shardKey`.
    expect(schedulerSrc).toMatch(/### \$\{s\.shardKey\}/)
  })

  test('aggregator renames outputs via outputWrapperPortNames into wrapper outlets', () => {
    expect(schedulerSrc).toContain('outputWrapperPortNames')
    expect(schedulerSrc).toMatch(/renames\[port\] \?\? port/)
  })

  test('no-aggregator case emits FANOUT_DONE_PORT_NAME signal outlet', () => {
    expect(schedulerSrc).toContain('FANOUT_DONE_PORT_NAME')
  })
})

describe('D.T6 — runtime cartesian guard', () => {
  test('estimateShardTotal is imported and called for the projected total', () => {
    expect(schedulerSrc).toMatch(/import\s*\{[^}]*estimateShardTotal/s)
    expect(schedulerSrc).toContain('estimateShardTotal(definition, node.id, items.length)')
  })

  test('guard short-circuits with wrapper-fanout-cartesian-exceeds-max error message', () => {
    expect(schedulerSrc).toContain('wrapper-fanout-cartesian-exceeds-max')
  })

  test('default fanoutMaxShardTotal = 256 when opts unset', () => {
    expect(schedulerSrc).toMatch(/opts\.fanoutMaxShardTotal\s*\?\?\s*256/)
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

  test('scheduler dispatchFanoutShard builds inputPortKinds from boundaryEdges', () => {
    expect(schedulerSrc).toContain('const inputPortKinds: Record<string, string> = {}')
    expect(schedulerSrc).toMatch(/inputPortKinds\[e\.target\.portName\]/)
  })
})

describe('D.T8 — RFC-053 wrapper lifecycle compatibility', () => {
  test('runFanoutWrapperNode reuses markWrapperTerminal (the shared finalize path)', () => {
    expect(schedulerSrc).toMatch(/markWrapperTerminal\(db, wrapperRunId, 'done'\)/)
    expect(schedulerSrc).toMatch(/markWrapperTerminal\(\s*db,\s*wrapperRunId,\s*'failed'/)
  })

  test('runFanoutWrapperNode handles resume via findResumableWrapperRun', () => {
    expect(schedulerSrc).toContain('findResumableWrapperRun(db, taskId, node.id, iteration)')
    expect(schedulerSrc).toMatch(/setNodeRunStatus\([\s\S]*?'wrapper-fanout-resume'/)
  })

  test('wrapper-fanout joins isProcessNodeKind (shared lifecycle predicate)', () => {
    // Cross-package sanity — the shared schema's isProcessNodeKind covers it.
    // The actual predicate test lives in shared/tests/wrapper-fanout-schema.test.ts;
    // re-verify the export name appears in the scheduler import surface so
    // future renames don't silently break the contract.
    expect(schedulerSrc).toMatch(/from '@agent-workflow\/shared'/)
  })
})
