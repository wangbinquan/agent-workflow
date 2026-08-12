// Regression guard for the optimized local gate.
//
// A previous direct `bun test --parallel` attempt deadlocked because workers
// shared the daemon flock/home. The local runner instead launches complete,
// serial Bun shards and gives every process a distinct home/temp namespace.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LOCAL_GATE_LANES } from '../../../scripts/local-gate'
import {
  backendShardInterruptExitCode,
  buildBackendShardPlans,
  createBackendShardInterruptController,
  DEFAULT_LOCAL_BACKEND_SHARD_KILL_GRACE_MS,
  DEFAULT_LOCAL_BACKEND_SHARD_TIMEOUT_MS,
  DEFAULT_LOCAL_BACKEND_SHARDS,
  type BackendShardPlan,
  type KillableProcess,
  resolveLocalBackendShardKillGraceMs,
  resolveLocalBackendShardCount,
  resolveLocalBackendShardTimeoutMs,
  resolveLocalTestSeed,
  runBackendShard,
  signalBackendShardProcessTree,
} from '../../../scripts/test-backend-sharded'

describe('local backend shard plan', () => {
  test('defaults to six complete serial-isolate shards', () => {
    const plans = buildBackendShardPlans({
      runRoot: '/tmp/aw-local-gate',
      shardCount: DEFAULT_LOCAL_BACKEND_SHARDS,
      baseSeed: 100,
      bunExecutable: '/opt/bun',
    })

    expect(plans).toHaveLength(6)
    expect(plans.map((plan) => `${plan.index}/${plan.count}`)).toEqual([
      '1/6',
      '2/6',
      '3/6',
      '4/6',
      '5/6',
      '6/6',
    ])
    expect(plans.map((plan) => plan.seed)).toEqual([100, 101, 102, 103, 104, 105])
    for (const plan of plans) {
      expect(plan.command).toEqual([
        '/opt/bun',
        'test',
        '--isolate',
        '--randomize',
        `--seed=${plan.seed}`,
        `--shard=${plan.index}/6`,
        '--dots',
      ])
    }
  })

  test('assigns every shard a unique persistent home and temp baseline', () => {
    const plans = buildBackendShardPlans({
      runRoot: '/tmp/aw-local-gate',
      shardCount: 4,
      baseSeed: 200,
    })

    expect(new Set(plans.map((plan) => plan.homeDir)).size).toBe(4)
    expect(new Set(plans.map((plan) => plan.tempDir)).size).toBe(4)
    for (const plan of plans) {
      expect(plan.env.AGENT_WORKFLOW_HOME).toBe(plan.homeDir)
      expect(plan.env.AGENT_WORKFLOW_TEST_SHARD_HOME).toBe(plan.homeDir)
      expect(plan.env.AGENT_WORKFLOW_TEST_SHARD_TMP).toBe(plan.tempDir)
      expect(plan.env.TMPDIR).toBe(plan.tempDir)
      expect(plan.env.TMP).toBe(plan.tempDir)
      expect(plan.env.TEMP).toBe(plan.tempDir)
    }
  })

  test('rejects malformed shard and seed overrides', () => {
    expect(resolveLocalBackendShardCount(undefined)).toBe(6)
    expect(resolveLocalBackendShardCount('6')).toBe(6)
    expect(() => resolveLocalBackendShardCount('0')).toThrow('AW_LOCAL_BACKEND_SHARDS')
    expect(() => resolveLocalBackendShardCount('2.5')).toThrow('AW_LOCAL_BACKEND_SHARDS')
    expect(resolveLocalTestSeed('2147483647')).toBe(2_147_483_647)
    expect(() => resolveLocalTestSeed('-1')).toThrow('AW_LOCAL_TEST_SEED')
  })

  test('strictly parses timeout and TERM→KILL grace overrides', () => {
    expect(resolveLocalBackendShardTimeoutMs(undefined)).toBe(
      DEFAULT_LOCAL_BACKEND_SHARD_TIMEOUT_MS,
    )
    expect(resolveLocalBackendShardTimeoutMs('250')).toBe(250)
    for (const bad of ['0', '-1', '1.5', ' 10', '10 ', '+10', '1e3', '86400001']) {
      expect(() => resolveLocalBackendShardTimeoutMs(bad)).toThrow(
        'AW_LOCAL_BACKEND_SHARD_TIMEOUT_MS',
      )
    }

    expect(resolveLocalBackendShardKillGraceMs(undefined)).toBe(
      DEFAULT_LOCAL_BACKEND_SHARD_KILL_GRACE_MS,
    )
    expect(resolveLocalBackendShardKillGraceMs('0')).toBe(0)
    expect(resolveLocalBackendShardKillGraceMs('50')).toBe(50)
    for (const bad of ['-1', '1.5', ' 10', '10 ', '+10', '1e3', '60001']) {
      expect(() => resolveLocalBackendShardKillGraceMs(bad)).toThrow(
        'AW_LOCAL_BACKEND_SHARD_KILL_GRACE_MS',
      )
    }
  })

  test('preserves shell interrupt exit-code semantics', () => {
    expect(backendShardInterruptExitCode('SIGINT')).toBe(130)
    expect(backendShardInterruptExitCode('SIGTERM')).toBe(143)
  })

  test('interrupt escalation is deterministic: grace expiry kills, second signal kills immediately', () => {
    const child: KillableProcess = { pid: 41, kill: () => {} }
    const active = new Set<KillableProcess>([child])
    const signals: NodeJS.Signals[] = []
    const escalations: string[] = []
    let scheduled: (() => void) | undefined
    let clearCalls = 0
    const controller = createBackendShardInterruptController(active, 75, {
      signalProcessTree: (_child, signal) => signals.push(signal),
      setTimer: (callback, delayMs) => {
        expect(delayMs).toBe(75)
        scheduled = callback
        return 'timer-1'
      },
      clearTimer: (handle) => {
        expect(handle).toBe('timer-1')
        clearCalls++
      },
      onEscalate: (reason) => escalations.push(reason),
    })

    controller.interrupt('SIGINT')
    expect(controller.interruptedSignal).toBe('SIGINT')
    expect(signals).toEqual(['SIGINT'])
    scheduled?.()
    expect(signals).toEqual(['SIGINT', 'SIGKILL'])
    expect(escalations).toEqual(['grace-expired'])

    // A later signal keeps the FIRST exit-code owner but skips any grace.
    controller.interrupt('SIGTERM')
    expect(controller.interruptedSignal).toBe('SIGINT')
    expect(signals).toEqual(['SIGINT', 'SIGKILL', 'SIGKILL'])
    expect(escalations).toEqual(['grace-expired', 'second-signal'])
    expect(clearCalls).toBe(0)
    controller.dispose()

    const secondSignals: NodeJS.Signals[] = []
    let secondClearCalls = 0
    const second = createBackendShardInterruptController(active, 75, {
      signalProcessTree: (_child, signal) => secondSignals.push(signal),
      setTimer: () => 'timer-2',
      clearTimer: (handle) => {
        expect(handle).toBe('timer-2')
        secondClearCalls++
      },
    })
    second.interrupt('SIGTERM')
    second.interrupt('SIGTERM')
    expect(secondSignals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(second.interruptedSignal).toBe('SIGTERM')
    expect(secondClearCalls).toBe(1)
    second.dispose()
  })
})

function runtimePlan(runRoot: string, command: string[]): BackendShardPlan {
  const homeDir = join(runRoot, 'home-1')
  const tempDir = join(runRoot, 'tmp-1')
  return {
    index: 1,
    count: 1,
    seed: 1,
    command,
    homeDir,
    tempDir,
    env: {
      AGENT_WORKFLOW_HOME: homeDir,
      AGENT_WORKFLOW_TEST_SHARD_HOME: homeDir,
      AGENT_WORKFLOW_TEST_SHARD_TMP: tempDir,
      TMPDIR: tempDir,
      TMP: tempDir,
      TEMP: tempDir,
    },
  }
}

describe('local backend shard wall-clock timeout', () => {
  const repoRoot = resolve(import.meta.dir, '../../..')

  test('a short-lived real subprocess completes normally before its deadline', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-local-shard-short-'))
    try {
      const result = await runBackendShard(
        repoRoot,
        runRoot,
        runtimePlan(runRoot, [process.execPath, '-e', "console.log('short-lived-ok')"]),
        { timeoutMs: 2_000, killGraceMs: 50 },
      )

      expect(result.exitCode).toBe(0)
      expect(result.timedOut).toBe(false)
      expect(result.output).toContain('short-lived-ok')
      expect(existsSync(join(runRoot, 'shard-1.log'))).toBe(false)
    } finally {
      rmSync(runRoot, { recursive: true, force: true })
    }
  })

  test('a hung real process tree times out, is killed as a group, and keeps diagnostics', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-local-shard-hang-'))
    const survivorMarker = join(runRoot, 'grandchild-survived')
    const grandchildScript = `
      process.on('SIGTERM', () => {})
      setTimeout(async () => {
        await Bun.write(${JSON.stringify(survivorMarker)}, 'survived')
        process.exit(0)
      }, 450)
      setTimeout(() => process.exit(0), 700)
    `
    const parentScript = `
      Bun.spawn([${JSON.stringify(process.execPath)}, '-e', ${JSON.stringify(grandchildScript)}], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      process.on('SIGTERM', () => {})
      console.log('hung-parent-ready')
      setTimeout(() => process.exit(0), 700)
    `
    try {
      const result = await runBackendShard(
        repoRoot,
        runRoot,
        runtimePlan(runRoot, [process.execPath, '-e', parentScript]),
        { timeoutMs: 150, killGraceMs: 50 },
      )

      expect(result.exitCode).toBe(124)
      expect(result.timedOut).toBe(true)
      expect(result.durationMs).toBeLessThan(1_500)
      expect(result.output).toContain('hung-parent-ready')
      expect(result.output).toContain('TIMEOUT after 150ms')
      const logPath = join(runRoot, 'shard-1.log')
      expect(existsSync(logPath)).toBe(true)
      expect(readFileSync(logPath, 'utf8')).toContain('SIGKILL to process group')

      // Give the deliberately stubborn grandchild enough time to leave its
      // marker if only the direct parent was killed. POSIX detached shards must
      // remove the whole process group; Windows exercises the direct timeout
      // path because negative-pid process groups do not exist there.
      await Bun.sleep(500)
      if (process.platform !== 'win32') expect(existsSync(survivorMarker)).toBe(false)
    } finally {
      rmSync(runRoot, { recursive: true, force: true })
    }
  })

  test('timeout still kills the process group when its TERM-compliant leader exits first', async () => {
    if (process.platform === 'win32') return
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-local-shard-leader-exits-'))
    const survivorMarker = join(runRoot, 'term-ignoring-grandchild-survived')
    const grandchildScript = `
      process.on('SIGTERM', () => {})
      setTimeout(async () => {
        await Bun.write(${JSON.stringify(survivorMarker)}, 'survived')
        process.exit(0)
      }, 350)
      setTimeout(() => process.exit(0), 600)
    `
    const parentScript = `
      Bun.spawn([${JSON.stringify(process.execPath)}, '-e', ${JSON.stringify(grandchildScript)}], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      console.log('term-compliant-parent-ready')
      process.on('SIGTERM', () => process.exit(0))
      setInterval(() => {}, 1000)
    `
    try {
      const result = await runBackendShard(
        repoRoot,
        runRoot,
        runtimePlan(runRoot, [process.execPath, '-e', parentScript]),
        { timeoutMs: 100, killGraceMs: 50 },
      )

      expect(result.exitCode).toBe(124)
      expect(result.timedOut).toBe(true)
      expect(result.output).toContain('term-compliant-parent-ready')
      expect(result.output).toContain('SIGKILL to process group')
      await Bun.sleep(350)
      expect(existsSync(survivorMarker)).toBe(false)
    } finally {
      rmSync(runRoot, { recursive: true, force: true })
    }
  })

  test('interrupt grace kills a stubborn real detached child without waiting for shard timeout', async () => {
    if (process.platform === 'win32') return
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        "process.on('SIGTERM', () => {}); console.log('interrupt-ready'); setInterval(() => {}, 1000)",
      ],
      { stdout: 'pipe', stderr: 'ignore', detached: true },
    )
    const reader = child.stdout.getReader()
    const active = new Set<KillableProcess>([child])
    const controller = createBackendShardInterruptController(active, 50)
    try {
      const ready = await reader.read()
      expect(new TextDecoder().decode(ready.value)).toContain('interrupt-ready')
      const startedAt = performance.now()
      controller.interrupt('SIGTERM')
      const settled = await Promise.race([
        child.exited.then((exitCode) => ({ settled: true as const, exitCode })),
        Bun.sleep(1_000).then(() => ({ settled: false as const })),
      ])
      expect(settled.settled).toBe(true)
      if (settled.settled) expect(settled.exitCode).not.toBe(0)
      expect(performance.now() - startedAt).toBeLessThan(1_000)
    } finally {
      controller.dispose()
      active.delete(child)
      signalBackendShardProcessTree(child, 'SIGKILL')
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
      child.unref?.()
    }
  })

  test('interrupt retains process-group ownership after the compliant leader exits', async () => {
    if (process.platform === 'win32') return
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-local-interrupt-leader-exits-'))
    const survivorMarker = join(runRoot, 'interrupt-grandchild-survived')
    const grandchildScript = `
      process.on('SIGINT', () => {})
      process.on('SIGTERM', () => {})
      setTimeout(async () => {
        await Bun.write(${JSON.stringify(survivorMarker)}, 'survived')
        process.exit(0)
      }, 350)
      setTimeout(() => process.exit(0), 600)
    `
    const parentScript = `
      Bun.spawn([${JSON.stringify(process.execPath)}, '-e', ${JSON.stringify(grandchildScript)}], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      console.log('interrupt-parent-ready')
      process.on('SIGINT', () => process.exit(0))
      setInterval(() => {}, 1000)
    `
    const child = Bun.spawn([process.execPath, '-e', parentScript], {
      stdout: 'pipe',
      stderr: 'ignore',
      detached: true,
    })
    const reader = child.stdout.getReader()
    const active = new Set<KillableProcess>([child])
    const controller = createBackendShardInterruptController(active, 50)
    try {
      const ready = await reader.read()
      expect(new TextDecoder().decode(ready.value)).toContain('interrupt-parent-ready')
      controller.interrupt('SIGINT')
      await child.exited
      // Mirror runBackendShard's finally + runBackendShards' finally: the
      // direct leader is no longer live and the controller is disposed before
      // grace expiry. Its snapshotted group must still receive SIGKILL.
      active.delete(child)
      controller.dispose()
      await Bun.sleep(350)
      expect(existsSync(survivorMarker)).toBe(false)
    } finally {
      active.delete(child)
      signalBackendShardProcessTree(child, 'SIGKILL')
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
      child.unref?.()
      rmSync(runRoot, { recursive: true, force: true })
    }
  })
})

describe('local full-gate plan', () => {
  test('runs the backend concurrently with every canonical quality and non-backend gate', () => {
    expect(LOCAL_GATE_LANES.map((lane) => lane.name)).toEqual(['backend', 'quality'])
    expect(LOCAL_GATE_LANES[0]?.commands).toEqual([
      { label: 'backend tests', args: ['run', 'test:backend'] },
    ])
    expect(LOCAL_GATE_LANES[1]?.commands.map((command) => command.args.join(' '))).toEqual([
      'run typecheck',
      'run lint',
      'run format:check',
      'run depcheck',
      'run test:shared',
      'run test:frontend:gate',
    ])
  })

  test('collects every lane result instead of short-circuiting on the first red command', () => {
    const source = readFileSync(resolve(import.meta.dir, '../../../scripts/local-gate.ts'), 'utf8')
    expect(source).toContain('failures.push(error)')
    expect(source).toContain('continuing to collect remaining results')
    expect(source).toContain('await Promise.allSettled(lanes)')
    expect(source).not.toContain('await Promise.all(lanes)')
  })
})
