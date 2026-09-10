// RFC-359 hosted macOS regression: existsSync may see the final marker before
// a direct write finishes. Exercise the actual E2E-only writer with controlled
// filesystem ports; no daemon, real files or decision workflow is started.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const source = readFileSync(
  resolve(import.meta.dir, '../src/services/humanGateDecisionE2eBarrier.ts'),
  'utf8',
)
const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  source.replace(/^import .*$/gm, '').replace(/^export /gm, ''),
)

function fixture(enabled: boolean, fail: 'write' | 'rename' | null = null) {
  const marker = '/controlled/questions.committed.json'
  const files = new Map<string, string>()
  const calls: string[] = []
  const visibleDuringWrite: boolean[] = []
  const failure = new Error(`controlled ${fail} failure`)
  const run = new Function(
    'AW_E2E_BUILD',
    'process',
    'mkdirSync',
    'writeFileSync',
    'renameSync',
    'join',
    `${body}; return waitAtHumanGateDecisionCommitBarrier`,
  )(
    enabled,
    {
      pid: 123,
      env: {
        AW_E2E_HUMAN_GATE_DECISION_BARRIER_DIR: '/controlled',
        AW_E2E_HUMAN_GATE_DECISION_BARRIER_KIND: 'questions',
      },
    },
    () => {
      calls.push('mkdir')
    },
    (path: string, value: string, encoding: string) => {
      calls.push('write')
      expect(encoding).toBe('utf8')
      files.set(path, '')
      visibleDuringWrite.push(files.has(marker))
      if (fail === 'write') throw failure
      files.set(path, value)
    },
    (from: string, to: string) => {
      calls.push('rename')
      expect(to).toBe(marker)
      expect(files.has(to)).toBe(false)
      expect(files.has(from)).toBe(true)
      if (fail === 'rename') throw failure
      files.set(to, files.get(from)!)
      files.delete(from)
    },
    join,
  ) as (input: { kind: 'questions'; taskId: string; operationId: string }) => Promise<void>
  return { run, marker, files, calls, visibleDuringWrite, failure }
}

const input = { kind: 'questions' as const, taskId: 'task', operationId: 'operation' }

test('the commit barrier publishes complete JSON before waiting for the external crash', async () => {
  const f = fixture(true)
  let settled = false
  const pending = f.run(input)
  void pending.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await Promise.resolve()
  expect(f.visibleDuringWrite).toEqual([false])
  expect(f.calls).toEqual(['mkdir', 'write', 'rename'])
  expect(f.files.size).toBe(1)
  const marker = JSON.parse(f.files.get(f.marker)!) as Record<string, unknown>
  expect(marker).toEqual({ ...input, committedAt: expect.any(Number) })
  expect(settled).toBe(false)
})

test('marker publication errors preserve the failure and never expose a ready marker', async () => {
  for (const phase of ['write', 'rename'] as const) {
    const f = fixture(true, phase)
    let caught: unknown
    try {
      await f.run(input)
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(f.failure)
    expect(f.files.has(f.marker)).toBe(false)
    expect(f.calls).toEqual(phase === 'write' ? ['mkdir', 'write'] : ['mkdir', 'write', 'rename'])
  }
})

test('ordinary builds do not publish a crash barrier marker', async () => {
  const f = fixture(false)
  await f.run(input)
  expect(f.calls).toEqual([])
  expect(f.files.size).toBe(0)
})
