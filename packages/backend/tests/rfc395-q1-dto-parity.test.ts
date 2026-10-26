import { expect, test } from 'bun:test'
import {
  assertQ1ResponseParity,
  Q1_SURFACES,
  assertQ1CaptureContent,
} from './helpers/rfc395Q1Parity/compare'
import { q1ReadyUrl, runQ1BinaryParity } from './helpers/rfc395Q1Parity/run'
import { q1ResponseDifferences } from './helpers/rfc395Q1Parity/differences'

// T18 PAR: report every field/order difference without weakening the byte oracle.
test('parity diagnostics retain missing, null, array order and object key order', () => {
  expect(
    q1ResponseDifferences(
      'task',
      '{"nullable":null,"items":["b","a"],"nested":{"first":1,"second":2}}',
      '{"items":["a","b"],"nested":{"second":2,"first":1},"added":false}',
    ),
  ).toEqual([
    {
      path: '$.nullable',
      kind: 'missing',
      old: { present: true, value: null },
      new: { present: false },
    },
    {
      path: '$.items[0]',
      kind: 'value',
      old: { present: true, value: 'b' },
      new: { present: true, value: 'a' },
    },
    {
      path: '$.items[1]',
      kind: 'value',
      old: { present: true, value: 'a' },
      new: { present: true, value: 'b' },
    },
    {
      path: '$.nested',
      kind: 'key-order',
      old: { present: true, value: ['first', 'second'] },
      new: { present: true, value: ['second', 'first'] },
    },
    {
      path: '$.added',
      kind: 'missing',
      old: { present: false },
      new: { present: true, value: false },
    },
  ])
  expect(q1ResponseDifferences('task', '{"a":1}', '{ "a":1}')).toEqual([
    {
      path: '$',
      kind: 'serialization',
      old: { present: true, value: '{"a":1}' },
      new: { present: true, value: '{ "a":1}' },
    },
  ])
})

test('parity diagnostics label only the accepted seq and request-clock changes', () => {
  const differences = q1ResponseDifferences(
    'node-runs',
    '{"runs":[{"id":"a","seq":null},{"id":"b"},{"id":"c","seq":3}]}',
    '{"runs":[{"id":"a","seq":1},{"id":"b","seq":2},{"id":"c","seq":4}]}',
  )
  expect(differences.map(({ path, allowance }) => [path, allowance])).toEqual([
    ['$.runs[0].seq', 'node-run-seq'],
    ['$.runs[1].seq', 'node-run-seq'],
    ['$.runs[2].seq', undefined],
  ])
  const windows = {
    before: { startedAt: 1, finishedAt: 3 },
    after: { startedAt: 4, finishedAt: 6 },
  }
  expect(
    q1ResponseDifferences('observation', '{"asOf":2}', '{"asOf":5}', windows)[0]?.allowance,
  ).toBe('observation-request-clock')
  expect(
    q1ResponseDifferences('observation', '{"asOf":2}', '{"asOf":7}', windows)[0]?.allowance,
  ).toBeUndefined()
  expect(q1ResponseDifferences('task', '{"seq":null}', '{"seq":1}')[0]?.allowance).toBeUndefined()
})

test('readiness waits for the daemon announcement with or without a bootstrap token', () => {
  const announcement = 'agent-workflow ready — open this URL in your browser:\n  '
  expect(q1ReadyUrl(`${announcement}http://127.0.0.1:4321/\n\n`)).toBe('http://127.0.0.1:4321/')
  expect(q1ReadyUrl(`${announcement}http://127.0.0.1:4321/?token=abc123\n\n`)).toBe(
    'http://127.0.0.1:4321/',
  )
  expect(q1ReadyUrl('listening http://127.0.0.1:4321/')).toBeNull()
  expect(q1ReadyUrl(`${announcement}http://127.0.0.1:4321/`)).toBeNull()
})
const document = (runs: unknown[]) => JSON.stringify({ taskId: 't', runs })
test('BF-D25 captures both task-list contracts, agent relations, session and observation', () => {
  expect(
    Q1_SURFACES.filter((surface) =>
      ['task-list', 'task-list-items', 'agent', 'session', 'observation'].includes(surface.name),
    ).map((surface) => [surface.name, surface.path]),
  ).toEqual([
    ['task-list', '/api/tasks?workflow_id=q1-workflow&limit=100'],
    ['task-list-items', '/api/tasks?workflow_id=q1-workflow&limit=100&include_owner=true'],
    ['agent', '/api/agents/q1-agent'],
    ['session', '/api/tasks/q1-parity-task/node-runs/q1-unknown-run/session'],
    ['observation', '/api/observability/tasks/q1-parity-task'],
  ])
  for (const surface of ['task-list', 'task-list-items'] as const)
    expect(() => assertQ1CaptureContent(surface, [])).toThrow('q1-empty-')
  for (const [surface, before, after] of [
    ['task-list', [{ repoCount: 2 }], [{ repoCount: 1 }]],
    ['task-list-items', [{ repos: ['b', 'a'] }], [{ repos: ['a', 'b'] }]],
    ['agent', { skills: ['b', 'a', 'b'] }, { skills: ['b', 'a'] }],
    ['agent', { dependsOn: ['b', 'a'] }, { dependsOn: ['a', 'b'] }],
    ['agent', { mcp: ['b', 'a'] }, { mcp: ['a', 'b'] }],
    ['agent', { plugins: ['b', 'a'] }, { plugins: ['a', 'b'] }],
    ['session', { tree: { prompt: 'Original' } }, { tree: { prompt: 'changed' } }],
  ] as const)
    expect(() =>
      assertQ1ResponseParity(surface, JSON.stringify(before), JSON.stringify(after)),
    ).toThrow('q1-dto-byte-mismatch')
})

test('BF-D25 observation validates its request clock and compares every persisted byte', () => {
  const windows = {
    before: { startedAt: 100, finishedAt: 110 },
    after: { startedAt: 200, finishedAt: 210 },
  }
  const before = JSON.stringify({
    asOf: 105,
    calls: [{ attempt: 4, startedAt: 7, nodeId: 'removed-node' }],
  })
  const after = JSON.stringify({
    asOf: 205,
    calls: [{ attempt: 4, startedAt: 7, nodeId: 'removed-node' }],
  })
  expect(() => assertQ1ResponseParity('observation', before, after, windows)).not.toThrow()
  expect(() => assertQ1ResponseParity('observation', before, after)).toThrow(
    'q1-observation-capture-window-required',
  )
  expect(() =>
    assertQ1ResponseParity('observation', before, after.replace('205', '211'), windows),
  ).toThrow('q1-observation-clock-outside-capture')
  for (const changed of [
    after.replace('"attempt":4', '"attempt":1'),
    after.replace('"startedAt":7', '"startedAt":8'),
    after.replace('removed-node', 'other-node'),
  ])
    expect(() => assertQ1ResponseParity('observation', before, changed, windows)).toThrow(
      'q1-dto-byte-mismatch:observation',
    )
})
test('the byte oracle permits only null/absent seq becoming an integer', () => {
  expect(() =>
    assertQ1ResponseParity(
      'node-runs',
      document([{ id: 'n', seq: null, retryIndex: 7 }]),
      document([{ id: 'n', seq: 12, retryIndex: 7 }]),
    ),
  ).not.toThrow()
  expect(() =>
    assertQ1ResponseParity(
      'node-runs',
      document([{ id: 'n', retryIndex: 7 }]),
      document([{ id: 'n', retryIndex: 7, seq: 12 }]),
    ),
  ).not.toThrow()
  for (const row of [
    { id: 'n', seq: 12, retryIndex: 0 },
    { id: 'n', seq: 12, retryIndex: 7, identity: 'unknown' },
  ])
    expect(() =>
      assertQ1ResponseParity(
        'node-runs',
        document([{ id: 'n', seq: null, retryIndex: 7 }]),
        document([row]),
      ),
    ).toThrow('q1-dto-byte-mismatch')
  expect(() =>
    assertQ1ResponseParity('task', '{"failureCode":null}', '{"failureCode":"original"}'),
  ).toThrow()
  expect(() => assertQ1ResponseParity('reviews', '[1,2]', '[2,1]')).toThrow()
})
// Normal unit lanes do not launch binaries or mutate a separate PostgreSQL database.
// T18 sets this switch explicitly; missing artifacts then fail, never silently skip.
test.skipIf(process.env.RFC395_Q1_T18 !== '1')(
  'T18 frozen source -> converted target: ten HTTP surfaces match',
  async () => {
    const required = (key: string) => {
      const value = process.env[key]
      if (!value) throw new Error(`Missing ${key}`)
      return value
    }
    const target = process.env.RFC395_Q1_TARGET === 'postgresql' ? 'postgresql' : 'sqlite'
    expect(
      await runQ1BinaryParity({
        repository: required('RFC395_Q1_REPOSITORY'),
        oldBinary: required('RFC395_Q1_OLD_BINARY'),
        newBinary: required('RFC395_Q1_NEW_BINARY'),
        oldArtifact: required('RFC395_Q1_OLD_ARTIFACT'),
        target,
        targetUrlEnv: process.env.RFC395_Q1_TARGET_URL_ENV,
      }),
    ).toContain('rfc395-q1-parity-')
  },
  900000,
)
