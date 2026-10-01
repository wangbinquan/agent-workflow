// RFC-371: native children are charged once, after drain; an unproven resume never charges old steps.
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeUsageCapture } from '../src/modules/runtime-management/application/nativeUsageCapture'
import { readOpencodeUsageSnapshot } from '../src/modules/runtime-management/infrastructure/opencodeUsageSnapshot'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'aw-child-usage-'))
  roots.push(folder)
  const path = join(folder, 'native.db'),
    db = new Database(path)
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT);
    CREATE INDEX session_parent_idx ON session(parent_id);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);
    CREATE INDEX part_session_idx ON part(session_id, id);`)
  const session = (id: string, parent: string | null = null) =>
    db.query('INSERT INTO session VALUES (?,?)').run(id, parent)
  const step = (
    id: string,
    sessionId: string,
    input: unknown = 10,
    model: string | null = 'actual-model',
    reasoning: unknown = 0,
  ) => {
    db.query('INSERT OR REPLACE INTO message VALUES (?,?,?)').run(
      'message-' + id,
      sessionId,
      JSON.stringify({ role: 'assistant', providerID: 'actual-provider', modelID: model }),
    )
    db.query('INSERT OR REPLACE INTO part VALUES (?,?,?,?,?)').run(
      id,
      sessionId,
      'message-' + id,
      1234,
      JSON.stringify({
        type: 'step-finish',
        tokens: { input, output: 3, reasoning, cache: { read: 2, write: 0 } },
      }),
    )
  }
  const capture = (resumeSessionId?: string) =>
    createNativeUsageCapture({
      invocationId: 'call',
      taskId: 'task',
      nodeRunId: 'run',
      agentId: 'agent',
      nativeSource: 'db',
      ...(resumeSessionId ? { resumeSessionId } : {}),
      read: (root) => readOpencodeUsageSnapshot(path, root),
    })
  session('root')
  return { path, db, session, step, capture }
}

test('nested children retain exact ancestry/model/time, root is reconciled, and the sibling tree is excluded', () => {
  const f = fixture(),
    c = f.capture()
  c.begin()
  f.session('child', 'root')
  f.session('nested', 'child')
  f.session('sibling')
  for (const id of ['root', 'child', 'nested', 'sibling']) f.step('step-' + id, id)
  const frames = c.finish('root', 9000),
    measurements = frames.flatMap((frame) => frame.measurements)
  expect(measurements.map((row) => row.recordId)).toEqual([
    'opencode:step:step-root',
    'opencode:step:step-child',
    'opencode:step:step-nested',
  ])
  expect(measurements[2]).toMatchObject({
    occurredAt: 1234,
    observedAt: 9000,
    model: { provider: 'actual-provider', id: 'actual-model' },
    scope: {
      root: 'root',
      session: 'nested',
      parentSession: 'child',
      ancestors: ['root', 'child'],
      level: 'request',
    },
    usage: { input: '10', output: '3', cacheRead: '2', cacheWrite: '0' },
  })
  expect(frames.at(-1)!.capture).toMatchObject({
    state: 'complete',
    scannedSessions: 3,
    scannedSteps: 3,
    priorRevisions: [],
    issues: [],
  })
  expect(c.finish('root', 9999)).toEqual(frames)
  f.db.close()
})

test('a successful empty tree has a durable completion proof without a zero token measurement', () => {
  const f = fixture(),
    c = f.capture()
  c.begin()
  const frames = c.finish('root', 9000)
  expect(frames).toHaveLength(1)
  expect(frames[0]!.measurements).toEqual([])
  expect(frames[0]!.capture).toMatchObject({
    state: 'complete',
    scannedSessions: 1,
    scannedSteps: 0,
  })
  f.db.close()
})

test('resume baseline excludes existing steps but includes new steps in existing and new children', () => {
  const f = fixture()
  f.session('child', 'root')
  f.step('old', 'child')
  const c = f.capture('root')
  c.begin()
  f.step('new-existing', 'child')
  f.session('new-child', 'root')
  f.step('new-child-step', 'new-child')
  const frames = c.finish('root', 9000)
  expect(
    frames
      .flatMap((frame) => frame.measurements)
      .map((row) => row.recordId)
      .sort(),
  ).toEqual(['opencode:step:new-child-step', 'opencode:step:new-existing'])
  expect(frames.at(-1)!.capture).toMatchObject({
    state: 'complete',
    baseline: { kind: 'resume', fingerprint: expect.any(String) },
  })
  f.db.close()
})

for (const change of ['numbers', 'model', 'removed'] as const)
  test(
    'late prior ' + change + ' stays a named historical gap and is never charged as new usage',
    () => {
      const f = fixture()
      f.session('child', 'root')
      f.step('old', 'child', 10, change === 'model' ? null : 'actual-model')
      const c = f.capture('root')
      c.begin()
      if (change === 'removed') f.db.query('DELETE FROM part WHERE id=?').run('old')
      else f.step('old', 'child', change === 'numbers' ? 20 : 10, 'actual-model')
      f.step('new', 'child', 5)
      const frames = c.finish('root', 9000),
        proof = frames.at(-1)!.capture!
      expect(frames.flatMap((frame) => frame.measurements).map((row) => row.recordId)).toEqual([
        'opencode:step:new',
      ])
      expect(proof.state).toBe('partial')
      expect(proof.issues).toContain('native-prior-revision-gap')
      expect(proof.priorRevisions).toHaveLength(1)
      expect(proof.priorRevisions[0]).toMatchObject({
        sessionId: 'child',
        stepId: 'old',
        before: { usage: { input: '10' } },
      })
      if (change === 'removed') expect(proof.priorRevisions[0]!.after).toBeNull()
      else
        expect(proof.priorRevisions[0]!.after).toMatchObject({
          usage: { input: change === 'numbers' ? '20' : '10' },
        })
      f.db.close()
    },
  )

test('missing resume root or a failed baseline never turns an old tree into new consumption', () => {
  const f = fixture()
  f.session('child', 'root')
  f.step('old', 'child')
  const missing = f.capture('absent')
  missing.begin()
  const frames = missing.finish('root', 9000)
  expect(frames.flatMap((frame) => frame.measurements)).toEqual([])
  expect(frames.at(-1)!.capture!.issues).toEqual(
    expect.arrayContaining(['native-baseline-unavailable', 'native-root-changed']),
  )
  let first = true
  const c = createNativeUsageCapture({
    invocationId: 'call',
    taskId: 'task',
    nodeRunId: 'run',
    agentId: null,
    nativeSource: 'db',
    resumeSessionId: 'root',
    read: (root) => {
      if (first) {
        first = false
        return { steps: [], sessions: 0, fingerprint: null, issues: ['native-store-unavailable'] }
      }
      return readOpencodeUsageSnapshot(f.path, root)
    },
  })
  c.begin()
  expect(c.finish('root', 9000).flatMap((frame) => frame.measurements)).toEqual([])
  f.db.close()
})

test('missing or memory-only native stores are explicit unknown, and readonly capture creates no file', () => {
  const f = fixture(),
    missing = join(roots.at(-1)!, 'missing.db')
  for (const path of [missing, null])
    expect(readOpencodeUsageSnapshot(path, 'root')).toMatchObject({
      steps: [],
      fingerprint: null,
      issues: ['native-store-unavailable'],
    })
  expect(existsSync(missing)).toBe(false)
  f.db.close()
})

test('tree/depth/part/step/time budgets remain partial instead of declaring a small complete subtree', () => {
  const f = fixture()
  f.session('child', 'root')
  f.session('nested', 'child')
  f.step('one', 'child')
  f.step('two', 'child')
  for (const [options, issue] of [
    [{ maxSessions: 1 }, 'native-tree-budget'],
    [{ maxDepth: 0 }, 'native-tree-budget'],
    [{ maxParts: 1 }, 'native-part-budget'],
    [{ maxSteps: 1 }, 'native-step-budget'],
    [{ budgetMs: 0 }, 'native-scan-budget'],
  ] as const) {
    const read = readOpencodeUsageSnapshot(f.path, 'root', options)
    expect(read.issues).toContain(issue)
    expect(read.fingerprint).toBeNull()
  }
  f.db.close()
})

test('model session mismatch, unsafe counts and absent timestamps stay unknown without defaults', () => {
  const f = fixture()
  f.session('child', 'root')
  f.step('one', 'child', Number.MAX_SAFE_INTEGER + 2)
  f.db.query('UPDATE message SET session_id=?').run('different')
  f.db.query('UPDATE part SET time_created=NULL').run()
  const value = readOpencodeUsageSnapshot(f.path, 'root')
  expect(value.steps[0]).toMatchObject({
    model: null,
    occurredAt: null,
    usage: { input: null, cacheWrite: '0' },
  })
  expect(value.issues).toEqual(
    expect.arrayContaining([
      'native-model-unavailable',
      'native-token-bucket-unknown',
      'native-time-unavailable',
    ]),
  )
  expect(value.fingerprint).not.toBeNull() // The identities and unknown values still form a valid resume baseline.
  f.db.close()
})

test('a native part moved between child sessions is a prior revision, never a second charge', () => {
  const f = fixture()
  f.session('child', 'root')
  f.session('other-child', 'root')
  f.step('old', 'child')
  const capture = f.capture('root')
  capture.begin()
  f.step('old', 'other-child')
  const frames = capture.finish('root', 9000)
  expect(frames.flatMap((row) => row.measurements)).toEqual([])
  expect(frames.at(-1)!.capture!.issues).toContain('native-prior-revision-gap')
  expect(frames.at(-1)!.capture!.baselineSteps![0]!.scopeChanged).toBe(true)
  f.db.close()
})

test('final scan restores a root step absent from stdout, with revisions after live numeric evidence', () => {
  const f = fixture()
  f.session('child', 'root')
  f.step('root-step', 'root')
  f.step('child-step', 'child')
  let revision = 20
  const capture = createNativeUsageCapture({
    invocationId: 'call',
    taskId: 'task',
    nodeRunId: 'run',
    agentId: null,
    nativeSource: 'db',
    read: (root) => readOpencodeUsageSnapshot(f.path, root),
    nextRevision: () => ++revision,
  })
  capture.begin()
  const frames = capture.finish('root', 9000, ['native-output-incomplete'])
  const values = frames.flatMap((row) => row.measurements)
  expect(values.map((row) => row.revision)).toEqual([21, 22])
  expect(values.map((row) => row.usage.input)).toEqual(['10', '10'])
  expect(frames.at(-1)!.capture).toMatchObject({
    state: 'partial',
    issues: ['native-output-incomplete'],
  })
  f.db.close()
})

test('resume filters prior root stdout steps as well as prior child steps, and retains the full baseline proof', () => {
  const f = fixture()
  f.step('old-root', 'root')
  f.session('child', 'root')
  f.step('old-child', 'child')
  const capture = f.capture('root')
  capture.begin()
  expect(capture.includesRecord('opencode:step:old-root')).toBe(false)
  expect(capture.includesRecord('opencode:step:new-root')).toBe(true)
  f.step('new-root', 'root')
  const frames = capture.finish('root', 9000)
  expect(frames.flatMap((row) => row.measurements).map((row) => row.recordId)).toEqual([
    'opencode:step:new-root',
  ])
  expect(frames.at(-1)!.capture!.baselineSteps).toHaveLength(2)
  f.db.close()
})

test('an unfinished native request stays partial and cannot be used as a proven resume baseline', () => {
  const f = fixture()
  f.session('child', 'root')
  f.step('completed', 'root')
  f.db
    .query('INSERT INTO part VALUES (?,?,?,?,?)')
    .run('started', 'child', 'unfinished-message', 1234, JSON.stringify({ type: 'step-start' }))
  const capture = f.capture()
  capture.begin()
  const frames = capture.finish('root', 9000)
  expect(frames.flatMap((row) => row.measurements)).toHaveLength(1)
  expect(frames.at(-1)!.capture).toMatchObject({
    state: 'partial',
    snapshotFingerprint: null,
    issues: ['native-step-unfinished'],
  })
  const resumed = f.capture('root')
  resumed.begin()
  expect(resumed.includesRecord('opencode:step:new')).toBe(false)
  expect(resumed.finish('root', 9999).at(-1)!.capture!.issues).toContain(
    'native-baseline-unavailable',
  )
  f.db.close()
})

test('an unvisited baseline step after a failed final scan is not evidence that the step was deleted', () => {
  const row = {
    id: 'old',
    sessionId: 'root',
    parentSessionId: null,
    ancestors: [],
    occurredAt: 1,
    usage: { input: '1', output: '0', cacheRead: '0', cacheWrite: '0' },
    model: null,
  }
  let first = true
  const capture = createNativeUsageCapture({
    invocationId: 'call',
    taskId: 'task',
    nodeRunId: 'run',
    agentId: null,
    nativeSource: 'db',
    resumeSessionId: 'root',
    read: () => {
      if (first) {
        first = false
        return { steps: [row], sessions: 1, fingerprint: 'baseline', issues: [] }
      }
      return { steps: [], sessions: 0, fingerprint: null, issues: ['native-scan-budget'] }
    },
  })
  capture.begin()
  const proof = capture.finish('root', 9000).at(-1)!.capture!
  expect(proof.baselineSteps).toMatchObject([{ stepId: 'old', after: null, afterObserved: false }])
  expect(proof.priorRevisions).toEqual([])
  expect(proof.issues).toEqual(['native-scan-budget'])
})

test('more than 500 steps are chunked before the single durable completion proof', () => {
  const root = {
    id: 'step',
    sessionId: 'root',
    parentSessionId: null,
    ancestors: [],
    occurredAt: 1,
    usage: { input: '1', output: '0', cacheRead: '0', cacheWrite: '0' },
    model: null,
  }
  const capture = createNativeUsageCapture({
    invocationId: 'call',
    taskId: 'task',
    nodeRunId: 'run',
    agentId: null,
    nativeSource: 'db',
    read: () => ({
      steps: Array.from({ length: 501 }, (_, i) => ({ ...root, id: String(i) })),
      sessions: 1,
      fingerprint: 'scan',
      issues: [],
    }),
  })
  capture.begin()
  const frames = capture.finish('root', 9000)
  expect(frames.map((row) => row.measurements.length)).toEqual([500, 1, 0])
  expect(frames.filter((row) => row.capture)).toHaveLength(1)
  expect(frames.at(-1)!.capture!.state).toBe('complete')
})

// RFC-371 real task regression: native final capture must agree with stdout output+reasoning.
test('native roots and children include reasoning exactly and unknown reasoning stays partial', () => {
  const f = fixture()
  f.session('child', 'root')
  f.step('root-step', 'root', 10, 'actual-model', 1)
  f.step('child-step', 'child', 10, 'actual-model', '9007199254740993')
  const value = readOpencodeUsageSnapshot(f.path, 'root')
  expect(value.steps.map((step) => step.usage.output)).toEqual(['4', '9007199254740996'])
  const capture = f.capture()
  capture.begin()
  expect(
    capture
      .finish('root', 9000)
      .flatMap((frame) => frame.measurements)
      .map((row) => row.usage.output),
  ).toEqual(['4', '9007199254740996'])
  f.step('root-step', 'root', 10, 'actual-model', null)
  const partial = readOpencodeUsageSnapshot(f.path, 'root')
  expect(partial.steps[0]?.usage.output).toBeNull()
  expect(partial.issues).toContain('native-token-bucket-unknown')
  f.db.close()
})
