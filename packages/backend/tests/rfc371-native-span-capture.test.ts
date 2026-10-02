import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AcceptedObservationInvocationSchema,
  type ObservationSpanOwnerProof,
  type ObservationCapturedUsage,
  type ObservationSpanSourceRecord,
} from '@agent-workflow/shared'
import { createNativeSpanCapture } from '../src/modules/runtime-management/application/nativeSpanCapture'
import { readOpencodeSpanSnapshot } from '../src/modules/runtime-management/infrastructure/opencodeSpanSnapshot'
import { readOpencodeUsageSnapshot } from '../src/modules/runtime-management/infrastructure/opencodeUsageSnapshot'
import { projectObservationSpans } from '../src/modules/run-observability/domain/spanProjection'

const folders: string[] = [],
  connections: Database[] = []
afterEach(() => {
  for (const db of connections.splice(0)) db.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})
const accepted = (id: string) =>
  AcceptedObservationInvocationSchema.parse({
    invocationId: id,
    taskId: 'task',
    nodeRunId: 'run-' + id,
    agentId: 'agent',
    agentRevision: 1,
    purpose: 'task',
    authority: { kind: 'local', runtime: null },
    acceptedAt: 1,
    priceBookRevision: null,
    spanCaptureContract: 'runtime-span-facts-v1',
    spanCaptureSource: 'source',
  })
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'aw-native-spans-'))
  folders.push(folder)
  const path = join(folder, 'native.db'),
    db = new Database(path)
  connections.push(db)
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, time_created INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`)
  db.query('INSERT INTO session VALUES (?,?,?)').run('root', null, 1000)
  const part = (
    id: string,
    data: unknown,
    message = 'message',
    created = 1100,
    session = 'root',
  ) => {
    db.query('INSERT OR REPLACE INTO message VALUES (?,?,?)').run(
      message,
      session,
      JSON.stringify({ role: 'assistant', providerID: 'actual-provider', modelID: 'actual-model' }),
    )
    db.query('INSERT OR REPLACE INTO part VALUES (?,?,?,?,?,?)').run(
      id,
      session,
      message,
      created,
      created,
      JSON.stringify(data),
    )
  }
  const tool = (end?: number) =>
    part('tool-part', {
      type: 'tool',
      callID: 'tool',
      tool: 'Read',
      state: {
        status: end === undefined ? 'running' : 'completed',
        time: { start: 1100, ...(end === undefined ? {} : { end }) },
      },
    })
  return { db, path, part, tool, read: (root: string) => readOpencodeSpanSnapshot(path, root) }
}
test('independent metadata scan leaves numeric fingerprints unchanged and never invents a multi-finish model start', () => {
  const f = fixture()
  f.tool(1500)
  f.part('start', { type: 'step-start' }, 'same-message', 1200)
  const finish = {
    type: 'step-finish',
    tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 3, write: 0 } },
  }
  f.part('finish-one', finish, 'same-message', 1400)
  f.part('finish-two', finish, 'same-message', 1450)
  const before = readOpencodeUsageSnapshot(f.path, 'root'),
    metadata = f.read('root'),
    after = readOpencodeUsageSnapshot(f.path, 'root')
  expect(after).toEqual(before)
  expect(metadata.fingerprint).not.toBeNull()
  expect(metadata.spans.filter((span) => span.kind === 'model')).toHaveLength(2)
  expect(
    metadata.spans
      .filter((span) => span.kind === 'model')
      .every((span) => span.state.startedAt === null),
  ).toBe(true)
  expect(metadata.spans.find((span) => span.kind === 'tool')!.state).toMatchObject({
    startedAt: 1100,
    endedAt: 1500,
  })
  expect(
    metadata.spans.filter((span) => span.kind === 'model').map((span) => span.measurementRecordId),
  ).toEqual(['opencode:step:finish-one', 'opencode:step:finish-two'])
  expect(readOpencodeSpanSnapshot(f.path, 'root', { maxParts: 1 }).issues).toContain(
    'native-span-part-budget',
  )
})
test('A native tool creation survives as its sole owner when B resumes and completes it', async () => {
  const f = fixture()
  f.tool()
  const a = accepted('A'),
    first = createNativeSpanCapture({
      accepted: a,
      sourceNamespace: 'source',
      read: f.read,
      requireNativeCreationTime: true,
      lookupOwners: async () => ({ owners: [], complete: true, issues: [] }),
    })
  await first.begin()
  first.bindRoot({
    rootSessionId: 'root',
    epoch: 0,
    mode: 'fresh',
    sourceNamespace: 'source',
    originalRootAccepted: true,
    spawnedAt: 900,
  })
  const initial = await first.finish([], 1600),
    fact = initial.flatMap((frame) => frame.spanFacts ?? [])[0]!
  expect(fact.invocationId).toBe('A')
  const proof: ObservationSpanOwnerProof = {
    sourceRowId: 1,
    sourceNodeRunId: 'run-A',
    itemIndex: 0,
    accepted: a,
    spanKey: fact.spanKey,
    scope: fact.scope,
    creation: fact,
  }
  const second = createNativeSpanCapture({
    accepted: accepted('B'),
    sourceNamespace: 'source',
    resumeSessionId: 'root',
    read: f.read,
    requireNativeCreationTime: true,
    lookupOwners: async () => ({ owners: [proof], complete: true, issues: [] }),
  })
  await second.begin()
  f.tool(1800)
  const binding = {
    rootSessionId: 'root',
    epoch: 0,
    mode: 'resume' as const,
    sourceNamespace: 'source',
    originalRootAccepted: true,
    spawnedAt: 1700,
  }
  second.bindRoot(binding)
  const final = await second.finish([binding], 1900)
  expect(final.flatMap((frame) => frame.spanFacts ?? [])).toEqual([])
  expect(final.flatMap((frame) => frame.measurements)).toEqual([])
  expect(final.flatMap((frame) => frame.priorSpanRevisions ?? [])).toMatchObject([
    {
      carrierInvocationId: 'B',
      targetOwnerInvocationId: 'A',
      originalOwnerProof: { sourceRowId: 1 },
      after: { startedAt: 1100, endedAt: 1800, status: 'success' },
    },
  ])
  expect(await second.finish([binding], 9999)).toEqual(final)
})
test('a fresh root needs an actual spawn-relative native creation proof; owner timeout cannot write after final', async () => {
  const f = fixture()
  f.tool()
  const older = createNativeSpanCapture({
    accepted: accepted('old'),
    sourceNamespace: 'source',
    read: f.read,
    requireNativeCreationTime: true,
    lookupOwners: async () => ({ owners: [], complete: true, issues: [] }),
  })
  await older.begin()
  older.bindRoot({
    rootSessionId: 'root',
    epoch: 0,
    mode: 'fresh',
    sourceNamespace: 'source',
    originalRootAccepted: true,
    spawnedAt: 1200,
  })
  const rejected = await older.finish([], 2000)
  expect(rejected.flatMap((frame) => frame.spanFacts ?? [])).toEqual([])
  expect(rejected.at(-1)?.spanCapture?.issues).toContain('native-span-fresh-root-unproven')
  let resolve!: (value: {
    owners: ObservationSpanOwnerProof[]
    complete: boolean
    issues: string[]
  }) => void
  const delayed = createNativeSpanCapture({
    accepted: accepted('delayed'),
    sourceNamespace: 'source',
    read: f.read,
    requireNativeCreationTime: true,
    budgetMs: 5,
    lookupOwners: () =>
      new Promise((done) => {
        resolve = done
      }),
  })
  await delayed.begin()
  delayed.bindRoot({
    rootSessionId: 'root',
    epoch: 0,
    mode: 'fresh',
    sourceNamespace: 'source',
    originalRootAccepted: true,
    spawnedAt: 900,
  })
  const frames = await delayed.finish([], 2000)
  expect(frames.flatMap((frame) => frame.spanFacts ?? [])).toEqual([])
  resolve({ owners: [], complete: true, issues: [] })
  await Promise.resolve()
  expect(delayed.flush(3000)).toEqual([])
  expect(await delayed.finish([], 3000)).toEqual(frames)
})
function records(
  frames: readonly ObservationCapturedUsage[],
  nodeRunId: string,
  offset = 0,
): ObservationSpanSourceRecord[] {
  return frames.flatMap((frame, index) => [
    ...(frame.spanFacts ?? []).map((fact, itemIndex) => ({
      type: 'fact' as const,
      sourceRowId: offset + index + 1,
      itemIndex,
      fact,
      nodeRunId,
    })),
    ...(frame.priorSpanRevisions ?? []).map((revision, itemIndex) => ({
      type: 'revision' as const,
      sourceRowId: offset + index + 1,
      itemIndex: (frame.spanFacts?.length ?? 0) + itemIndex,
      revision,
      nodeRunId,
    })),
  ])
}
function delayedOwners() {
  let release!: (value: {
    owners: ObservationSpanOwnerProof[]
    complete: boolean
    issues: string[]
  }) => void
  const result = new Promise<{
    owners: ObservationSpanOwnerProof[]
    complete: boolean
    issues: string[]
  }>((resolve) => {
    release = resolve
  })
  return {
    lookup: () => result,
    release: () => release({ owners: [], complete: true, issues: [] }),
  }
}
for (const ends of [
  [1500, 1700],
  [1700, 1500],
] as const) {
  test(
    'delayed ownership preserves contradictory native completions ' + ends.join(' then '),
    async () => {
      const f = fixture(),
        owner = delayedOwners(),
        a = accepted('A'),
        capture = createNativeSpanCapture({
          accepted: a,
          sourceNamespace: 'source',
          read: f.read,
          requireNativeCreationTime: true,
          lookupOwners: owner.lookup,
        })
      await capture.begin()
      capture.bindRoot({
        rootSessionId: 'root',
        epoch: 0,
        mode: 'fresh',
        sourceNamespace: 'source',
        originalRootAccepted: true,
        spawnedAt: 900,
      })
      for (const end of ends) {
        f.tool(end)
        capture.observe(f.read('root').spans.find((span) => span.kind === 'tool')!, 'root', 0)
      }
      const pending = capture.flush(1800),
        numericBefore = readOpencodeUsageSnapshot(f.path, 'root')
      owner.release()
      const final = await capture.finish([], 2000),
        projected = projectObservationSpans({
          taskId: 'task',
          accepted: [a],
          records: records(final, 'run-A'),
        })
      expect(pending).toEqual([])
      expect(f.read('root').spans.find((span) => span.kind === 'tool')!.state.endedAt).toBe(ends[1])
      expect(projected.spans).toHaveLength(1)
      expect(projected.spans[0]!.fact.state).toMatchObject({
        startedAt: null,
        endedAt: null,
        status: 'unknown',
      })
      expect([...projected.spans[0]!.issues]).toContain('native-span-state-conflict')
      expect(final.at(-1)?.spanCapture?.state).toBe('partial')
      expect(final.flatMap((frame) => frame.measurements)).toEqual([])
      expect(final.flatMap((frame) => frame.priorSpanRevisions ?? [])).toEqual([])
      expect(readOpencodeUsageSnapshot(f.path, 'root')).toEqual(numericBefore)
    },
  )
}
test('delayed ownership retains actual start and completion while duplicate delivery stays within the event budget', async () => {
  const f = fixture(),
    owner = delayedOwners(),
    a = accepted('A'),
    capture = createNativeSpanCapture({
      accepted: a,
      sourceNamespace: 'source',
      read: f.read,
      requireNativeCreationTime: true,
      lookupOwners: owner.lookup,
    })
  await capture.begin()
  capture.bindRoot({
    rootSessionId: 'root',
    epoch: 0,
    mode: 'fresh',
    sourceNamespace: 'source',
    originalRootAccepted: true,
    spawnedAt: 900,
  })
  f.tool()
  const opened = f.read('root').spans.find((span) => span.kind === 'tool')!
  for (let index = 0; index < 205; index++) capture.observe(opened, 'root', 0)
  f.tool(1500)
  capture.observe(f.read('root').spans.find((span) => span.kind === 'tool')!, 'root', 0)
  owner.release()
  const final = await capture.finish([], 2000),
    projected = projectObservationSpans({
      taskId: 'task',
      accepted: [a],
      records: records(final, 'run-A'),
    })
  expect(projected.spans).toHaveLength(1)
  expect(projected.spans[0]!.fact.state).toMatchObject({
    startedAt: 1100,
    endedAt: 1500,
    status: 'success',
  })
  expect([...projected.spans[0]!.issues]).toEqual([])
  expect(final.at(-1)?.spanCapture?.state).toBe('complete')
  expect(final.at(-1)?.spanCapture?.issues).not.toContain('native-span-pending-budget')
  expect(final.flatMap((frame) => frame.measurements)).toEqual([])
})
test('conflicting actual ordinary native boundaries remain unknown through later identical final delivery', async () => {
  const f = fixture()
  f.tool(1500)
  const a = accepted('A'),
    capture = createNativeSpanCapture({
      accepted: a,
      sourceNamespace: 'source',
      read: f.read,
      requireNativeCreationTime: true,
      lookupOwners: async () => ({ owners: [], complete: true, issues: [] }),
    })
  await capture.begin()
  capture.bindRoot({
    rootSessionId: 'root',
    epoch: 0,
    mode: 'fresh',
    sourceNamespace: 'source',
    originalRootAccepted: true,
    spawnedAt: 900,
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  capture.observe(f.read('root').spans.find((span) => span.kind === 'tool')!, 'root', 0)
  const first = capture.flush(1600)
  expect(first.flatMap((frame) => frame.spanFacts ?? [])).toHaveLength(1)
  f.tool(1700)
  capture.observe(f.read('root').spans.find((span) => span.kind === 'tool')!, 'root', 0)
  f.tool(1500)
  const final = await capture.finish([], 2000)
  const projected = projectObservationSpans({
    taskId: 'task',
    accepted: [a],
    records: [...records(first, 'run-A'), ...records(final, 'run-A', first.length)],
  })
  expect(projected.spans).toHaveLength(1)
  expect(projected.spans[0]!.fact.state).toMatchObject({
    startedAt: null,
    endedAt: null,
    status: 'unknown',
  })
  expect([...projected.spans[0]!.issues]).toContain('native-span-state-conflict')
  expect(final.flatMap((frame) => frame.measurements)).toEqual([])
})
test('a contradictory resume completion keeps its actual prior-owner evidence and never creates B usage', async () => {
  const f = fixture()
  f.tool(1500)
  const a = accepted('A'),
    b = accepted('B')
  const original = createNativeSpanCapture({
    accepted: a,
    sourceNamespace: 'source',
    read: f.read,
    requireNativeCreationTime: true,
    lookupOwners: async () => ({ owners: [], complete: true, issues: [] }),
  })
  await original.begin()
  original.bindRoot({
    rootSessionId: 'root',
    epoch: 0,
    mode: 'fresh',
    sourceNamespace: 'source',
    originalRootAccepted: true,
    spawnedAt: 900,
  })
  const created = await original.finish([], 1600),
    fact = created.flatMap((frame) => frame.spanFacts ?? [])[0]!
  const proof: ObservationSpanOwnerProof = {
    sourceRowId: 1,
    sourceNodeRunId: 'run-A',
    itemIndex: 0,
    accepted: a,
    spanKey: fact.spanKey,
    scope: fact.scope,
    creation: fact,
  }
  const resume = createNativeSpanCapture({
    accepted: b,
    sourceNamespace: 'source',
    resumeSessionId: 'root',
    read: f.read,
    requireNativeCreationTime: true,
    lookupOwners: async () => ({ owners: [proof], complete: true, issues: [] }),
  })
  await resume.begin()
  f.tool(1800)
  resume.bindRoot({
    rootSessionId: 'root',
    epoch: 0,
    mode: 'resume',
    sourceNamespace: 'source',
    originalRootAccepted: true,
    spawnedAt: 1700,
  })
  const completed = await resume.finish([], 1900)
  expect(completed.flatMap((frame) => frame.spanFacts ?? [])).toEqual([])
  expect(completed.flatMap((frame) => frame.measurements)).toEqual([])
  expect(completed.flatMap((frame) => frame.priorSpanRevisions ?? [])[0]!.after.endedAt).toBe(1800)
  const projected = projectObservationSpans({
    taskId: 'task',
    accepted: [a, b],
    records: [...records(created, 'run-A'), ...records(completed, 'run-B', created.length)],
  })
  expect(projected.spans).toHaveLength(1)
  expect(projected.spans[0]!.fact.invocationId).toBe('A')
  expect(projected.spans[0]!.fact.state.status).toBe('unknown')
})
