// RFC-359 hosted macOS regression: existsSync may see the final marker before
// a direct write finishes. Exercise the actual E2E-only writer with controlled
// filesystem ports; no daemon, real files or decision workflow is started.
//
// The barrier must also freeze the whole daemon, not just park the request: with
// a parked request the daemon's own continuation worker woke the task before the
// harness SIGKILL landed, and the e2e "clarify and review continuations recover when
// SIGKILL lands after commit but before wake" (e2e/rfc294-human-gate-restart.spec.ts)
// then saw a crash during a running node instead of the commit -> wake window
// (Windows CI 40950592110, shard 2/4, both attempts). The last case runs the real
// barrier in a child process and checks that its timers stop.
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  const frozen = new Error('controlled freeze')
  const run = new Function(
    'AW_E2E_BUILD',
    'process',
    'mkdirSync',
    'writeFileSync',
    'renameSync',
    'join',
    'Atomics',
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
    {
      // The real wait never returns; this one records the freeze and leaves.
      wait: (array: Int32Array, index: number, value: number) => {
        calls.push('freeze')
        expect([array.length, index, value]).toEqual([1, 0, 0])
        throw frozen
      },
    },
  ) as (input: { kind: 'questions'; taskId: string; operationId: string }) => Promise<void>
  return { run, marker, files, calls, visibleDuringWrite, failure, frozen }
}

const input = { kind: 'questions' as const, taskId: 'task', operationId: 'operation' }

test('the commit barrier publishes complete JSON, then freezes the thread', async () => {
  const f = fixture(true)
  let caught: unknown
  try {
    await f.run(input)
  } catch (error) {
    caught = error
  }
  expect(caught).toBe(f.frozen)
  expect(f.visibleDuringWrite).toEqual([false])
  expect(f.calls).toEqual(['mkdir', 'write', 'rename', 'freeze'])
  expect(f.files.size).toBe(1)
  const marker = JSON.parse(f.files.get(f.marker)!) as Record<string, unknown>
  expect(marker).toEqual({ ...input, committedAt: expect.any(Number) })
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

test('the real barrier stops every timer of the process until it is killed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-human-gate-barrier-freeze-'))
  const ticks = join(dir, 'ticks')
  const fixturePath = join(dir, 'fixture.ts')
  writeFileSync(
    fixturePath,
    [
      "import { writeFileSync } from 'node:fs'",
      `import { waitAtHumanGateDecisionCommitBarrier } from ${JSON.stringify(
        resolve(import.meta.dir, '../src/services/humanGateDecisionE2eBarrier.ts'),
      )}`,
      'let count = 0',
      `setInterval(() => writeFileSync(${JSON.stringify(ticks)}, String(++count)), 5)`,
      'setTimeout(() => {',
      "  void waitAtHumanGateDecisionCommitBarrier({ kind: 'questions', taskId: 'task', operationId: 'operation' })",
      '}, 50)',
    ].join('\n'),
  )
  const child = Bun.spawn([process.execPath, 'run', '--define', 'AW_E2E_BUILD:true', fixturePath], {
    env: {
      ...process.env,
      AW_E2E_HUMAN_GATE_DECISION_BARRIER_DIR: dir,
      AW_E2E_HUMAN_GATE_DECISION_BARRIER_KIND: 'questions',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  try {
    const marker = join(dir, 'questions.committed.json')
    const deadline = Date.now() + 15_000
    while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10)
    expect(existsSync(marker)).toBe(true)
    await Bun.sleep(50)
    const atFreeze = readFileSync(ticks, 'utf8')
    await Bun.sleep(400)
    // A parked request would keep this 5 ms interval writing; the frozen thread runs nothing.
    expect(readFileSync(ticks, 'utf8')).toBe(atFreeze)
    expect(child.exitCode).toBeNull()
  } finally {
    child.kill('SIGKILL')
    await child.exited
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
