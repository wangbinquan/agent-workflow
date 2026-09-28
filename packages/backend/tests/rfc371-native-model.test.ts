// RFC-371: actual model metadata can arrive after the numeric step without creating another charge.
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  reconcileUsage,
  type UsageLedgerRecord,
} from '../src/modules/run-observability/domain/usageLedger'
import { createInvocationUsageCapture } from '../src/services/runtime/usage'
import {
  createOpencodeUsageNormalizer,
  opencodeUsageDatabasePath,
  readOpencodeUsageModel,
} from '../src/services/runtime/opencode/nativeUsage'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const identity = { invocationId: 'call', taskId: 'task', nodeRunId: 'run', agentId: 'agent' }
function path() {
  const root = mkdtempSync(join(tmpdir(), 'aw-native-usage-'))
  roots.push(root)
  return join(root, 'native.db')
}
function seed(file: string, model = 'native-model') {
  const db = new Database(file)
  db.exec(
    'CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT)',
  )
  db.query('INSERT INTO message VALUES(?,?,?)').run(
    'message',
    'session',
    JSON.stringify({ role: 'assistant', providerID: 'native-provider', modelID: model }),
  )
  db.query('INSERT INTO part VALUES(?,?,?,?)').run(
    'step',
    'message',
    'session',
    JSON.stringify({ type: 'step-finish' }),
  )
  db.close()
}
const raw = (input = 10) => ({
  type: 'step_finish',
  sessionID: 'session',
  timestamp: 1000,
  part: {
    id: 'step',
    sessionID: 'session',
    messageID: 'message',
    tokens: { input, output: 3, cache: { read: 2, write: 0 } },
  },
})

test('native DB resolution uses the final child environment and explicit path semantics', () => {
  expect(opencodeUsageDatabasePath({ HOME: '/child' })).toBe(
    '/child/.local/share/opencode/opencode.db',
  )
  expect(
    opencodeUsageDatabasePath({
      HOME: '/child',
      XDG_DATA_HOME: '/private/data',
      OPENCODE_DB: 'custom.db',
    }),
  ).toBe('/private/data/opencode/custom.db')
  expect(opencodeUsageDatabasePath({ OPENCODE_DB: '/exact/native.db' })).toBe('/exact/native.db')
  expect(opencodeUsageDatabasePath({ HOME: '/child', OPENCODE_DB: ':memory:' })).toBeNull()
  expect(opencodeUsageDatabasePath({ OPENCODE_TEST_HOME: '/not-xdg' })).toBeNull()
})

test('an exact native step links only to its assistant message and reported route', () => {
  const file = path()
  seed(file)
  expect(readOpencodeUsageModel(file, raw(), 'session')).toEqual({
    provider: 'native-provider',
    id: 'native-model',
  })
  for (const value of [
    { ...raw(), sessionID: 'different' },
    { ...raw(), part: { ...raw().part, messageID: 'different' } },
    { ...raw(), part: { ...raw().part, sessionID: 'different' } },
    { ...raw(), part: { ...raw().part, id: 'different' } },
  ])
    expect(readOpencodeUsageModel(file, value, 'session')).toBeNull()
  const db = new Database(file)
  for (const info of [
    { role: 'user', model: { providerID: 'configured', modelID: 'configured' } },
    { role: 'assistant', modelID: 'missing-provider' },
    [],
  ]) {
    db.query('UPDATE message SET data=?').run(JSON.stringify(info))
    expect(readOpencodeUsageModel(file, raw(), 'session')).toBeNull()
  }
  db.query('UPDATE message SET data=?').run('malformed')
  expect(readOpencodeUsageModel(file, raw(), 'session')).toBeNull()
  db.close()
})

test('late model evidence keeps one meter, original native scope and counts', () => {
  const file = path(),
    capture = createInvocationUsageCapture({
      ...identity,
      normalize: createOpencodeUsageNormalizer({ OPENCODE_DB: file }),
    })
  const first = capture(JSON.stringify(raw()), 'session', 1000)!
  expect(first.diagnostics).toContain('native-model-unavailable')
  expect(first.measurements[0]!.model).toBeNull()
  expect(capture.retryModels(1100)).toEqual([])
  seed(file)
  const corrections = capture.retryModels(1200),
    next = corrections[0]!.measurements[0]!
  expect(corrections).toHaveLength(1)
  expect(next).toMatchObject({
    recordId: first.measurements[0]!.recordId,
    scope: first.measurements[0]!.scope,
    occurredAt: 1000,
    model: { provider: 'native-provider', id: 'native-model' },
    usage: first.measurements[0]!.usage,
  })
  expect(next.revision).toBeGreaterThan(first.measurements[0]!.revision)
  expect(capture.retryModels(1300)).toEqual([])
  rmSync(file)
  const revised = capture(JSON.stringify(raw(20)), 'session', 1400)!
  expect(revised.measurements[0]).toMatchObject({ model: next.model, usage: { input: '20' } })
  expect(revised.diagnostics).toEqual([])
})

test('bounded retry reports gaps while the original numeric evidence remains usable', () => {
  const capture = createInvocationUsageCapture({
    ...identity,
    normalize: createOpencodeUsageNormalizer({ OPENCODE_DB: path() }),
  })
  let last
  for (let index = 0; index < 201; index++)
    last = capture(
      JSON.stringify({ ...raw(), part: { ...raw().part, id: 'step-' + index } }),
      'session',
      1000,
    )
  expect(last!.diagnostics).toContain('native-model-retry-capacity')
  expect(last!.measurements[0]!.usage.input).toBe('10')
  expect(capture.retryModels(1200, 0)).toEqual([
    { invocationId: 'call', measurements: [], diagnostics: ['native-model-retry-budget'] },
  ])
})

test('a step from another native session never contributes to this invocation', () => {
  const capture = createInvocationUsageCapture({
    ...identity,
    normalize: createOpencodeUsageNormalizer({ OPENCODE_DB: path() }),
  })
  for (const value of [
    { ...raw(), sessionID: 'different' },
    { ...raw(), part: { ...raw().part, sessionID: 'different' } },
  ]) {
    const result = capture(JSON.stringify(value), 'session', 1000)!
    expect(result.measurements).toEqual([])
    expect(result.diagnostics).toContain('step-session-mismatch')
  }
  expect(capture.retryModels(1200)).toEqual([])
})

for (const availableBeforeDecrease of [false, true])
  test(
    'model repair preserves numeric decrease diagnostics, known before decrease=' +
      availableBeforeDecrease,
    () => {
      const file = path(),
        capture = createInvocationUsageCapture({
          ...identity,
          normalize: createOpencodeUsageNormalizer({ OPENCODE_DB: file }),
        })
      const early = capture(JSON.stringify(raw(20)), 'session', 1000)!
      if (availableBeforeDecrease) seed(file)
      const late = capture(JSON.stringify(raw(10)), 'session', 1100)!
      if (!availableBeforeDecrease) seed(file)
      let record: UsageLedgerRecord | undefined
      for (const frame of [early, late])
        for (const measurement of frame.measurements)
          record = reconcileUsage('source', measurement, record).record
      const beforeBudget = record
      for (const frame of capture.retryModels(1150, 0))
        for (const measurement of frame.measurements)
          record = reconcileUsage('source', measurement, record).record
      expect(record).toEqual(beforeBudget)
      for (const frame of capture.retryModels(1200))
        for (const measurement of frame.measurements)
          record = reconcileUsage('source', measurement, record).record
      expect(record).toMatchObject({
        contribution: { input: '20' },
        measurement: { revision: 1, model: { provider: 'native-provider', id: 'native-model' } },
        modelRevision: availableBeforeDecrease ? 2 : 3,
        complete: false,
        issues: ['unexplained-decrease'],
      })
      expect(capture.retryModels(1300)).toEqual([])
    },
  )
