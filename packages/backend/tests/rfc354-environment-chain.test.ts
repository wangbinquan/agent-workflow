// RFC-354 — locks the lexical-environment frame arithmetic
// (modules/task-execution/domain/environmentChain.ts) and the frame-level
// source picker (services/freshness.ts pickFrameSourceRun).
//
// Why these tests exist: the numeric "iteration ≤ window, highest wins" read
// (pickUpstreamSourceRun) only coincides with lexical scoping for ONE loop
// level — nested loops made the inner body read the wrong generation (audit
// S-6). The frame walk below must never fall back to a neighbouring frame:
// a source that is not in the environment is `closure-binding-unresolved`.

import { describe, expect, test } from 'bun:test'
import {
  frameKey,
  parentFrameOf,
  resolveSourceFrame,
  resolveSourceFrameInScope,
  sameFrame,
  TOP_FRAME,
  type ContainerRunRow,
} from '../src/modules/task-execution/domain/environmentChain'
import {
  pickFrameSourceRun,
  pickLatestRunInFrame,
  pickLatestSettledRun,
} from '../src/services/freshness'

// Containment: outer ⊃ git ⊃ inner ⊃ worker; `top` and `sibling_loop` at root.
const parents = new Map<string, string>([
  ['git', 'outer'],
  ['inner', 'git'],
  ['worker', 'inner'],
  ['helper', 'inner'],
  ['other', 'sibling_loop'],
])

// Generation rows: outer#0 → git@outer:1 → inner@git:0.
const rows: ContainerRunRow[] = [
  { id: 'R_outer', nodeId: 'outer', containerRunId: null, iteration: 0 },
  { id: 'R_git', nodeId: 'git', containerRunId: 'R_outer', iteration: 1 },
  { id: 'R_inner', nodeId: 'inner', containerRunId: 'R_git', iteration: 0 },
]
const byId = (id: string) => rows.find((r) => r.id === id)
const workerFrame = { containerRunId: 'R_inner', iteration: 2 }

describe('resolveSourceFrame — lexical environment walk', () => {
  test('local variable: same scope resolves to the consumer frame itself', () => {
    const res = resolveSourceFrame({
      sourceNodeId: 'helper',
      targetNodeId: 'worker',
      parents,
      frame: workerFrame,
      containerRowById: byId,
    })
    expect(res).toEqual({ ok: true, frame: workerFrame, hops: 0 })
  })

  test('free variable two levels up resolves to the frame that contains the source', () => {
    // `top` lives at the root; worker is three wrappers deep. Walk
    // inner → git → outer → root, landing on the top frame.
    const res = resolveSourceFrame({
      sourceNodeId: 'top',
      targetNodeId: 'worker',
      parents,
      frame: workerFrame,
      containerRowById: byId,
    })
    expect(res).toEqual({ ok: true, frame: TOP_FRAME, hops: 3 })
  })

  test('a wrapper parameter resolves at the wrapper frame (one hop out of its body)', () => {
    // Source = the inner wrapper itself (a `wrapper-input` edge). Its scope is
    // `git`, so the walk stops at the frame the git body is running in —
    // R_git round 0 — which is exactly where inner's own generation row lives.
    const res = resolveSourceFrame({
      sourceNodeId: 'inner',
      targetNodeId: 'worker',
      parents,
      frame: workerFrame,
      containerRowById: byId,
    })
    expect(res).toEqual({ ok: true, frame: { containerRunId: 'R_git', iteration: 0 }, hops: 1 })
  })

  test('a node in a sibling wrapper is not lexically visible → scope-not-enclosing', () => {
    const res = resolveSourceFrame({
      sourceNodeId: 'other',
      targetNodeId: 'worker',
      parents,
      frame: workerFrame,
      containerRowById: byId,
    })
    expect(res).toEqual({ ok: false, reason: 'scope-not-enclosing', scopeId: 'sibling_loop' })
  })

  test('a missing generation row fails closed instead of guessing a frame', () => {
    const res = resolveSourceFrame({
      sourceNodeId: 'top',
      targetNodeId: 'worker',
      parents,
      frame: { containerRunId: 'R_gone', iteration: 0 },
      containerRowById: byId,
    })
    expect(res).toEqual({ ok: false, reason: 'container-row-missing', scopeId: 'inner' })
  })

  test('a generation row that belongs to a different wrapper than the scope fails closed', () => {
    // The consumer claims to run inside `inner` but its frame points at git's row.
    const res = resolveSourceFrame({
      sourceNodeId: 'top',
      targetNodeId: 'worker',
      parents,
      frame: { containerRunId: 'R_git', iteration: 0 },
      containerRowById: byId,
    })
    expect(res).toEqual({ ok: false, reason: 'container-row-missing', scopeId: 'inner' })
  })

  test('a containment cycle terminates', () => {
    const cyclic = new Map<string, string>([
      ['a', 'b'],
      ['b', 'a'],
      ['leaf', 'a'],
    ])
    const cycRows: ContainerRunRow[] = [
      { id: 'R_a', nodeId: 'a', containerRunId: 'R_b', iteration: 0 },
      { id: 'R_b', nodeId: 'b', containerRunId: 'R_a', iteration: 0 },
    ]
    const res = resolveSourceFrame({
      sourceNodeId: 'elsewhere',
      targetNodeId: 'leaf',
      parents: cyclic,
      frame: { containerRunId: 'R_a', iteration: 0 },
      containerRowById: (id) => cycRows.find((r) => r.id === id),
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('containment-cycle')
  })
})

describe('parentFrameOf / frameKey / sameFrame', () => {
  test('parentFrameOf reads the enclosing coordinate off the generation row', () => {
    expect(parentFrameOf(workerFrame, byId)).toEqual({ containerRunId: 'R_git', iteration: 0 })
    expect(parentFrameOf({ containerRunId: 'R_git', iteration: 0 }, byId)).toEqual({
      containerRunId: 'R_outer',
      iteration: 1,
    })
    expect(parentFrameOf(TOP_FRAME, byId)).toBeNull()
    expect(parentFrameOf({ containerRunId: 'R_gone', iteration: 0 }, byId)).toBeNull()
  })

  test('frameKey distinguishes rounds and containers; top frame has an empty container', () => {
    expect(frameKey(TOP_FRAME)).toBe('#0')
    expect(frameKey(workerFrame)).toBe('R_inner#2')
    expect(sameFrame(workerFrame, { containerRunId: 'R_inner', iteration: 2 })).toBe(true)
    expect(sameFrame(workerFrame, { containerRunId: 'R_inner', iteration: 1 })).toBe(false)
  })
})

describe('pickFrameSourceRun — settled row of a node inside ONE frame, latest by id', () => {
  const frame = { containerRunId: 'R_inner', iteration: 1 }
  const settledRows = [
    // same node, previous round of the same container — never visible
    { id: '01A', iteration: 0, parentNodeRunId: null, containerRunId: 'R_inner', status: 'done' },
    // same frame, older done row
    { id: '01B', iteration: 1, parentNodeRunId: null, containerRunId: 'R_inner', status: 'done' },
    // same frame, fresher skipped row (RFC-306: skipped IS the current answer)
    {
      id: '01C',
      iteration: 1,
      parentNodeRunId: null,
      containerRunId: 'R_inner',
      status: 'skipped',
    },
    // same frame but a born-running child (fan-out shard) — excluded
    { id: '01D', iteration: 1, parentNodeRunId: 'X', containerRunId: 'R_inner', status: 'done' },
    // same frame, not settled
    {
      id: '01E',
      iteration: 1,
      parentNodeRunId: null,
      containerRunId: 'R_inner',
      status: 'running',
    },
    // another container at the same round — a different frame
    { id: '01F', iteration: 1, parentNodeRunId: null, containerRunId: 'R_other', status: 'done' },
  ]

  test('picks the freshest settled top-level row of exactly that frame', () => {
    expect(pickFrameSourceRun(settledRows, frame)?.id).toBe('01C')
  })

  test('never falls back to an earlier round or a neighbouring container', () => {
    expect(
      pickFrameSourceRun(settledRows, { containerRunId: 'R_inner', iteration: 2 }),
    ).toBeUndefined()
    expect(
      pickFrameSourceRun(settledRows, { containerRunId: 'R_none', iteration: 1 }),
    ).toBeUndefined()
  })

  test('top frame is (null, 0)', () => {
    const top = [
      { id: '02A', iteration: 0, parentNodeRunId: null, containerRunId: null, status: 'done' },
      { id: '02B', iteration: 0, parentNodeRunId: null, containerRunId: 'R_x', status: 'done' },
    ]
    expect(pickFrameSourceRun(top, TOP_FRAME)?.id).toBe('02A')
  })
})

describe('pickLatestRunInFrame / pickLatestSettledRun — the two non-window pickers', () => {
  const rows = [
    { id: '01A', iteration: 0, parentNodeRunId: null, containerRunId: 'R', status: 'done' },
    { id: '01B', iteration: 0, parentNodeRunId: null, containerRunId: 'R', status: 'pending' },
    { id: '01C', iteration: 0, parentNodeRunId: 'X', containerRunId: 'R', status: 'done' },
    { id: '01D', iteration: 1, parentNodeRunId: null, containerRunId: 'R', status: 'done' },
    { id: '01E', iteration: 0, parentNodeRunId: null, containerRunId: null, status: 'skipped' },
  ]

  test('pickLatestRunInFrame keeps any status so a review can fail loudly on a newer pending row', () => {
    expect(pickLatestRunInFrame(rows, { containerRunId: 'R', iteration: 0 })?.id).toBe('01B')
    expect(pickLatestRunInFrame(rows, { containerRunId: 'R', iteration: 1 })?.id).toBe('01D')
    expect(pickLatestRunInFrame(rows, { containerRunId: 'Q', iteration: 0 })).toBeUndefined()
  })

  test('pickLatestSettledRun crosses frames (task-boundary projection) and skips non-settled / child rows', () => {
    expect(pickLatestSettledRun(rows)?.id).toBe('01E')
    expect(pickLatestSettledRun(rows.filter((r) => r.id !== '01E'))?.id).toBe('01D')
    expect(pickLatestSettledRun([rows[1]!, rows[2]!])).toBeUndefined()
  })
})

describe('resolveSourceFrameInScope — a wrapper reading on behalf of its body', () => {
  // oloop ∋ iloop ∋ worker ; sib ∋ other ; lister at the top scope.
  const parents: ReadonlyMap<string, string> = new Map([
    ['iloop', 'oloop'],
    ['worker', 'iloop'],
    ['other', 'sib'],
  ])
  const rows = new Map([
    ['O1', { id: 'O1', nodeId: 'oloop', containerRunId: null, iteration: 0 }],
    ['I2', { id: 'I2', nodeId: 'iloop', containerRunId: 'O1', iteration: 1 }],
  ])
  const lookup = (id: string) => rows.get(id)
  // The inner loop's body frame on outer round 1, inner round 0.
  const bodyFrame = { containerRunId: 'I2', iteration: 0 }

  test('a body node is a local: read in the body frame itself', () => {
    expect(
      resolveSourceFrameInScope({
        sourceNodeId: 'worker',
        scope: 'iloop',
        parents,
        frame: bodyFrame,
        containerRowById: lookup,
      }),
    ).toEqual({ ok: true, frame: bodyFrame, hops: 0 })
  })

  test('a top-scope node (gap4: exit condition on an out-of-loop port) is a captured free variable — two generations outward', () => {
    expect(
      resolveSourceFrameInScope({
        sourceNodeId: 'lister',
        scope: 'iloop',
        parents,
        frame: bodyFrame,
        containerRowById: lookup,
      }),
    ).toEqual({ ok: true, frame: { containerRunId: null, iteration: 0 }, hops: 2 })
  })

  test('a node inside a sibling wrapper is not lexically visible — fails closed', () => {
    expect(
      resolveSourceFrameInScope({
        sourceNodeId: 'other',
        scope: 'iloop',
        parents,
        frame: bodyFrame,
        containerRowById: lookup,
      }),
    ).toEqual({ ok: false, reason: 'scope-not-enclosing', scopeId: 'sib' })
  })

  test('resolveSourceFrame is the node-addressed form of the same walk', () => {
    expect(
      resolveSourceFrame({
        sourceNodeId: 'lister',
        targetNodeId: 'worker',
        parents,
        frame: bodyFrame,
        containerRowById: lookup,
      }),
    ).toEqual({ ok: true, frame: { containerRunId: null, iteration: 0 }, hops: 2 })
  })
})
