// RFC-354 T18 — the task detail surfaces speak in FRAMES.
//
// A run's frame is `(containerRunId, iteration)`: the wrapper generation row it
// hangs off plus the round inside it (loop-in-loop: outer round 1 / inner round
// 0 and outer round 2 / inner round 0 are two lineages that share the bare
// `iteration` counter). Before T18 every task-detail helper scoped siblings on
// the counter alone, so nested generations counted each other's rows as prior
// clarify rounds / retries and the round column could not tell them apart.
//
// Locks:
//   • `parseScopePath` / `formatFrameBreadcrumb` render the daemon's
//     `scope_path` (`outer:1/inner:0`) as `outer#1 › inner#0`, '' at the top;
//   • `groupHistoryByFrame` groups a node's history per frame, generations in
//     creation order (oldest id), one group for a flat workflow;
//   • `clarifyRoundForRun` / `displayRetryForRun` never cross frames;
//   • `formatIterationLabel` prefers the breadcrumb over `loop#N` once a frame
//     is known and keeps the legacy counter for pre-frame rows;
//   • the task-detail round column and the drawer render through these helpers
//     (source-text anchors — the components are not unit-mounted here).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { NodeRun } from '@agent-workflow/shared'
import {
  clarifyRoundForRun,
  displayRetryForRun,
  formatFrameBreadcrumb,
  formatIterationLabel,
  frameKeyOf,
  groupHistoryByFrame,
  nodeRunHistory,
  parseScopePath,
  sameFrame,
} from '../src/lib/node-history'

function makeRun(partial: Partial<NodeRun> & { id: string }): NodeRun {
  return {
    id: partial.id,
    taskId: 't1',
    nodeId: partial.nodeId ?? 'n1',
    parentNodeRunId: partial.parentNodeRunId ?? null,
    iteration: partial.iteration ?? 0,
    shardKey: partial.shardKey ?? null,
    retryIndex: partial.retryIndex ?? 0,
    wgRound: null,
    rerunCause: null,
    containerRunId: partial.containerRunId ?? null,
    scopePath: partial.scopePath ?? '',
    reviewIteration: partial.reviewIteration ?? 0,
    status: partial.status ?? 'done',
    startedAt: partial.startedAt ?? null,
    finishedAt: partial.finishedAt ?? null,
    pid: null,
    exitCode: null,
    errorMessage: null,
    supersededByReview: null,
    rolledBack: null,
    promptText: null,
    tokInput: null,
    tokOutput: null,
    tokTotal: null,
    tokCacheCreate: null,
    tokCacheRead: null,
    opencodeSessionId: null,
  }
}

const t = (key: string, vars?: Record<string, string | number>): string =>
  vars && 'n' in vars ? `${key}=${vars.n}` : key

describe('parseScopePath / formatFrameBreadcrumb', () => {
  test('the top scope is empty — and so is a payload that omits the field (pre-frame daemon)', () => {
    expect(parseScopePath('')).toEqual([])
    expect(parseScopePath(null)).toEqual([])
    expect(parseScopePath(undefined)).toEqual([])
    expect(formatFrameBreadcrumb({ scopePath: '' })).toBe('')
    expect(formatFrameBreadcrumb({ scopePath: undefined as unknown as string })).toBe('')
  })

  test('nested generations read root → here', () => {
    expect(parseScopePath('outer:1/inner:0')).toEqual([
      { nodeId: 'outer', iteration: 1 },
      { nodeId: 'inner', iteration: 0 },
    ])
    expect(formatFrameBreadcrumb({ scopePath: 'outer:1/inner:0' })).toBe('outer#1 › inner#0')
  })

  // RFC-354 —— 任意深度：三层（`loop ⊃ git ⊃ loop`）是 e2e 与调度器两层都真跑过的
  // 形状（`e2e/workflow-matrix.spec.ts` 的 depth-3 用例、
  // `packages/backend/tests/rfc354-nested-depth3-frames.test.ts`），面包屑必须一路
  // 拼到底：把渲染写成「取最后一段」或「只认两段」在两层嵌套下都看不出来。
  test('three levels read root → here, one segment per wrapper generation', () => {
    expect(parseScopePath('d3_outer:1/d3_git:1/d3_inner:0')).toEqual([
      { nodeId: 'd3_outer', iteration: 1 },
      { nodeId: 'd3_git', iteration: 1 },
      { nodeId: 'd3_inner', iteration: 0 },
    ])
    expect(formatFrameBreadcrumb({ scopePath: 'd3_outer:1/d3_git:1/d3_inner:0' })).toBe(
      'd3_outer#1 › d3_git#1 › d3_inner#0',
    )
  })

  test('a node id may itself contain ":" — the LAST colon is the round separator', () => {
    expect(parseScopePath('ns:loop:2')).toEqual([{ nodeId: 'ns:loop', iteration: 2 }])
  })

  test('a corrupt segment never throws; it keeps the text and reads as round 0', () => {
    expect(parseScopePath('outer:x')).toEqual([{ nodeId: 'outer:x', iteration: 0 }])
    expect(parseScopePath('bare')).toEqual([{ nodeId: 'bare', iteration: 0 }])
  })
})

describe('frames', () => {
  test('sameFrame / frameKeyOf key on the generation row AND the round', () => {
    const top0 = makeRun({ id: 'a' })
    const top0b = makeRun({ id: 'b' })
    const gen1r0 = makeRun({ id: 'c', containerRunId: 'gen1', iteration: 0 })
    const gen2r0 = makeRun({ id: 'd', containerRunId: 'gen2', iteration: 0 })
    const gen1r1 = makeRun({ id: 'e', containerRunId: 'gen1', iteration: 1 })
    expect(sameFrame(top0, top0b)).toBe(true)
    expect(sameFrame(gen1r0, gen2r0)).toBe(false)
    expect(sameFrame(gen1r0, gen1r1)).toBe(false)
    expect(frameKeyOf(top0)).toBe('#0')
    expect(frameKeyOf(gen1r1)).toBe('gen1#1')
  })

  test('groupHistoryByFrame: one group for a flat workflow, generations in creation order', () => {
    const cur = makeRun({ id: '01A' })
    const retry = makeRun({ id: '01B', retryIndex: 1 })
    expect(groupHistoryByFrame(nodeRunHistory(cur, [cur, retry])).map((g) => g.key)).toEqual(['#0'])

    // loop-in-loop: outer round 1 → inner gen X (round 0, then round 1);
    // outer round 2 → inner gen Y (round 0). Same node, same bare counters.
    const x0 = makeRun({
      id: '01C',
      containerRunId: 'X',
      iteration: 0,
      scopePath: 'outer:1/inner:0',
    })
    const x1 = makeRun({
      id: '01D',
      containerRunId: 'X',
      iteration: 1,
      scopePath: 'outer:1/inner:1',
    })
    const y0 = makeRun({
      id: '01E',
      containerRunId: 'Y',
      iteration: 0,
      scopePath: 'outer:2/inner:0',
    })
    const history = nodeRunHistory(y0, [y0, x1, x0])
    const groups = groupHistoryByFrame(history)
    expect(groups.map((g) => g.key)).toEqual(['X#0', 'X#1', 'Y#0'])
    expect(groups.map((g) => formatFrameBreadcrumb(g))).toEqual([
      'outer#1 › inner#0',
      'outer#1 › inner#1',
      'outer#2 › inner#0',
    ])
    expect(groups[2]!.runs.map((r) => r.id)).toEqual(['01E'])
  })

  // RFC-354 —— 深度 3 的分组：`loop ⊃ git ⊃ loop ⊃ agent` 跑外 2 × 内 2 之后，
  // 同一个 agent 有四次运行、四个帧，而它们的裸 `iteration` 只有 0 / 1 两个值
  // （各出现两次）。这正是「按 iteration 分组」会把四组压成两组的地方。
  test('groupHistoryByFrame: depth 3 keeps all four generations apart', () => {
    const rows = [
      ['01A', 'GEN-R0', 0, 'd3_outer:0/d3_git:0/d3_inner:0'],
      ['01B', 'GEN-R0', 1, 'd3_outer:0/d3_git:0/d3_inner:1'],
      ['01C', 'GEN-R1', 0, 'd3_outer:1/d3_git:1/d3_inner:0'],
      ['01D', 'GEN-R1', 1, 'd3_outer:1/d3_git:1/d3_inner:1'],
    ] as const
    const runs = rows.map(([id, containerRunId, iteration, scopePath]) =>
      makeRun({ id, containerRunId, iteration, scopePath }),
    )
    const groups = groupHistoryByFrame(nodeRunHistory(runs[3]!, [...runs].reverse()))
    expect(groups.map((group) => group.key)).toEqual([
      'GEN-R0#0',
      'GEN-R0#1',
      'GEN-R1#0',
      'GEN-R1#1',
    ])
    expect(groups.map((group) => formatFrameBreadcrumb(group))).toEqual([
      'd3_outer#0 › d3_git#0 › d3_inner#0',
      'd3_outer#0 › d3_git#0 › d3_inner#1',
      'd3_outer#1 › d3_git#1 › d3_inner#0',
      'd3_outer#1 › d3_git#1 › d3_inner#1',
    ])
    expect(groups.every((group) => group.runs.length === 1)).toBe(true)
    // 反证：如果按裸计数分组，四组会塌成两组。
    expect(new Set(runs.map((run) => run.iteration)).size).toBe(2)
  })
})

describe('lineage helpers never cross a frame', () => {
  test('clarifyRoundForRun: a done row of another generation at the same round is not a prior round', () => {
    const otherGen = makeRun({ id: '01A', containerRunId: 'X', iteration: 0, status: 'done' })
    const priorSame = makeRun({ id: '01B', containerRunId: 'Y', iteration: 0, status: 'done' })
    const cur = makeRun({ id: '01C', containerRunId: 'Y', iteration: 0, status: 'awaiting_human' })
    expect(clarifyRoundForRun(cur, [otherGen, priorSame, cur])).toBe(1)
  })

  test('displayRetryForRun (workgroup host): failures of another generation do not count', () => {
    const foreignFail = makeRun({
      id: '01A',
      nodeId: '__wg_leader__',
      containerRunId: 'X',
      status: 'failed',
    })
    const ownFail = makeRun({
      id: '01B',
      nodeId: '__wg_leader__',
      containerRunId: 'Y',
      status: 'failed',
    })
    const cur = makeRun({ id: '01C', nodeId: '__wg_leader__', containerRunId: 'Y', status: 'done' })
    expect(displayRetryForRun(cur, [foreignFail, ownFail, cur])).toBe(1)
  })
})

describe('formatIterationLabel', () => {
  test('a framed run reads its breadcrumb instead of loop#N', () => {
    const run = makeRun({ id: 'r', containerRunId: 'X', iteration: 1, scopePath: 'outer:1' })
    expect(formatIterationLabel(run, { t })).toBe('outer#1')
  })

  test('a framed run keeps its review / clarify / retry suffixes', () => {
    const run = makeRun({
      id: 'r',
      containerRunId: 'X',
      iteration: 0,
      scopePath: 'outer:2/inner:0',
      reviewIteration: 1,
      retryIndex: 2,
    })
    expect(formatIterationLabel(run, { t }, 1)).toBe(
      'outer#2 › inner#0 · nodeDrawer.iterReview=1 · nodeDrawer.iterClarify=1 · nodeDrawer.iterRetry=2',
    )
  })

  test('a pre-frame row (no scopePath) keeps the legacy loop counter', () => {
    const run = makeRun({ id: 'r', iteration: 3 })
    expect(formatIterationLabel(run, { t })).toBe('nodeDrawer.iterLoop=3')
  })
})

describe('the task-detail surfaces render through the frame helpers (source anchors)', () => {
  const read = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf8')

  test('the node-runs round column shows the breadcrumb for a framed row', () => {
    const src = read('src/routes/tasks.detail.tsx')
    // Gate P3: the condition goes through the helper (tolerates a payload from
    // a pre-frame daemon that omits `scopePath` entirely), never `!== ''`.
    expect(src).toContain("formatFrameBreadcrumb(r) !== '' ? (")
    expect(src).not.toContain("r.scopePath !== ''")
    expect(src).toContain('node-run-frame-${r.id}')
  })

  test('the drawer shows the frame stat and groups the run history per frame', () => {
    const src = read('src/components/NodeDetailDrawer.tsx')
    expect(src).toContain("t('nodeDrawer.statFrame')")
    expect(src).toContain("formatFrameBreadcrumb(run) !== '' && (")
    expect(src).not.toContain("run.scopePath !== ''")
    expect(src).toContain('data-testid="stats-frame"')
    expect(src).toContain('groupHistoryByFrame(history)')
    expect(src).toContain('data-testid="stats-history-frame"')
  })
})
