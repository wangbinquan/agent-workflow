// Regression guard for the optimized local gate.
//
// A previous direct `bun test --parallel` attempt deadlocked because workers
// shared the daemon flock/home. The local runner instead launches complete,
// serial Bun shards and gives every process a distinct home/temp namespace.
//
// 墙钟预算不得赛进程启动（2026-08-23，RFC-317 B1 期间 CI 实红后订正）
// ------------------------------------------------------------------
// 本文件里的杀链用例都要「在子进程还活着的时候让分片超时」，所以每条都有一组
// 耦合的时间常数：分片 timeout / grace、以及孙进程写 survivor marker 的时刻。
// 原先 `timeout still kills the process group when its TERM-compliant leader
// exits first` 用的是 `timeoutMs: 100`，而它断言 `result.output` 里有子进程打的
// 就绪行——这等于要求 `bun -e <script>` 在 100ms 内完成启动并 flush 一行。
// 本机实测：空载 ~20ms，八个 CPU 忙循环下**实测到 100ms**。CI 的 macOS runner 上
// 四个分片并行，于是这条在 run 32619463902 上红了，而杀链本身（TERM→KILL 到进程
// 组）执行得完全正确——红的是就绪竞态，不是被测语义。
//
// 订正两件事，别再退回去：
//   ① 所有墙钟预算按「实测最坏启动延迟的数倍」给，不要贴着走；相对间距（kill 时刻
//      与 marker 时刻之间的余量）保持不变，预言力一字不改。
//   ② 就绪行断言一律带**前提复核措辞**——前提破裂时要一眼看出是「没等到就绪」，
//      而不是让人以为组杀语义回归了（`docs/dev-gotchas.md` 关于前提破裂的定式）。

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  acquireLocalGateLock,
  LOCAL_GATE_LANES,
  OPTIONAL_E2E_LANE,
  localGateLanes,
  resolveLocalGateLockPath,
} from '../../../scripts/local-gate'
import {
  backendShardInterruptExitCode,
  buildBackendShardPlans,
  createBackendShardInterruptController,
  DEFAULT_LOCAL_BACKEND_SHARD_IDLE_TIMEOUT_MS,
  DEFAULT_LOCAL_BACKEND_SHARD_KILL_GRACE_MS,
  DEFAULT_LOCAL_BACKEND_SHARD_TIMEOUT_MS,
  DEFAULT_LOCAL_BACKEND_SHARDS,
  type BackendShardPlan,
  type KillableProcess,
  resolveLocalBackendShardIdleTimeoutMs,
  resolveLocalBackendShardKillGraceMs,
  resolveLocalBackendShardCount,
  resolveLocalBackendShardTimeoutMs,
  resolveLocalTestSeed,
  runBackendShard,
  signalBackendShardProcessTree,
} from '../../../scripts/test-backend-sharded'

describe('local backend shard plan', () => {
  test('defaults to four complete serial-isolate shards', () => {
    const plans = buildBackendShardPlans({
      runRoot: '/tmp/aw-local-gate',
      shardCount: DEFAULT_LOCAL_BACKEND_SHARDS,
      baseSeed: 100,
      bunExecutable: '/opt/bun',
    })

    expect(plans).toHaveLength(4)
    expect(plans.map((plan) => `${plan.index}/${plan.count}`)).toEqual(['1/4', '2/4', '3/4', '4/4'])
    expect(plans.map((plan) => plan.seed)).toEqual([100, 101, 102, 103])
    for (const plan of plans) {
      expect(plan.command).toEqual([
        '/opt/bun',
        'test',
        '--isolate',
        '--randomize',
        `--seed=${plan.seed}`,
        `--shard=${plan.index}/4`,
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
    expect(resolveLocalBackendShardCount(undefined)).toBe(4)
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

    expect(resolveLocalBackendShardIdleTimeoutMs(undefined)).toBe(
      DEFAULT_LOCAL_BACKEND_SHARD_IDLE_TIMEOUT_MS,
    )
    expect(resolveLocalBackendShardIdleTimeoutMs('750')).toBe(750)
    for (const bad of ['0', '-1', '1.5', ' 10', '10 ', '+10', '1e3', '86400001']) {
      expect(() => resolveLocalBackendShardIdleTimeoutMs(bad)).toThrow(
        'AW_LOCAL_BACKEND_SHARD_IDLE_TIMEOUT_MS',
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
      }, 1_600)
      setTimeout(() => process.exit(0), 2_400)
    `
    const parentScript = `
      Bun.spawn([${JSON.stringify(process.execPath)}, '-e', ${JSON.stringify(grandchildScript)}], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      process.on('SIGTERM', () => {})
      console.log('hung-parent-ready')
      setTimeout(() => process.exit(0), 2_400)
    `
    try {
      const result = await runBackendShard(
        repoRoot,
        runRoot,
        runtimePlan(runRoot, [process.execPath, '-e', parentScript]),
        { timeoutMs: 800, killGraceMs: 50 },
      )

      expect(result.exitCode).toBe(124)
      expect(result.timedOut).toBe(true)
      expect(result.durationMs).toBeLessThan(3_000)
      expect(
        result.output,
        '前提不成立：子进程还没来得及打印就绪行，本用例此刻测不到组杀语义（见文件头「墙钟预算不得赛进程启动」）',
      ).toContain('hung-parent-ready')
      expect(result.output).toContain('TIMEOUT after 800ms')
      const logPath = join(runRoot, 'shard-1.log')
      expect(existsSync(logPath)).toBe(true)
      expect(readFileSync(logPath, 'utf8')).toContain('SIGKILL to process group')

      // Give the deliberately stubborn grandchild enough time to leave its
      // marker if only the direct parent was killed. POSIX detached shards must
      // remove the whole process group; Windows exercises the direct timeout
      // path because negative-pid process groups do not exist there.
      await Bun.sleep(1_200)
      if (process.platform !== 'win32') expect(existsSync(survivorMarker)).toBe(false)
    } finally {
      rmSync(runRoot, { recursive: true, force: true })
    }
  })

  test('a silent shard is stopped by the activity deadline before its hard timeout', async () => {
    if (process.platform === 'win32') return
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-local-shard-idle-'))
    const survivorMarker = join(runRoot, 'idle-process-survived')
    const script = `
      process.on('SIGTERM', () => {})
      console.log('idle-process-ready')
      setTimeout(async () => {
        await Bun.write(${JSON.stringify(survivorMarker)}, 'survived')
        process.exit(0)
      }, 1_800)
      setInterval(() => {}, 1000)
    `
    try {
      const result = await runBackendShard(
        repoRoot,
        runRoot,
        runtimePlan(runRoot, [process.execPath, '-e', script]),
        { timeoutMs: 10_000, idleTimeoutMs: 150, killGraceMs: 50 },
      )

      expect(result.exitCode).toBe(124)
      expect(result.timedOut).toBe(true)
      expect(result.durationMs).toBeLessThan(2_500)
      expect(result.output, '前提不成立：子进程还没打印就绪行，空闲计时根本没开始计').toContain(
        'idle-process-ready',
      )
      expect(result.output).toContain('IDLE TIMEOUT after 150ms without output')
      await Bun.sleep(1_400)
      expect(existsSync(survivorMarker)).toBe(false)
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
      }, 1_600)
      setTimeout(() => process.exit(0), 2_400)
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
        { timeoutMs: 800, killGraceMs: 50 },
      )

      expect(result.exitCode).toBe(124)
      expect(result.timedOut).toBe(true)
      expect(
        result.output,
        '前提不成立：TERM 顺从的父进程还没打印就绪行就被超时杀了，此刻断言不到「领头先退、组杀仍生效」',
      ).toContain('term-compliant-parent-ready')
      expect(result.output).toContain('SIGKILL to process group')
      await Bun.sleep(1_200)
      expect(existsSync(survivorMarker)).toBe(false)
    } finally {
      rmSync(runRoot, { recursive: true, force: true })
    }
  })

  test('a successful leader cannot leave inherited output pipes hanging until the shard timeout', async () => {
    if (process.platform === 'win32') return
    const runRoot = mkdtempSync(join(tmpdir(), 'aw-local-shard-post-exit-pipe-'))
    const survivorMarker = join(runRoot, 'pipe-holder-survived')
    const grandchildScript = `
      process.on('SIGTERM', () => {})
      setTimeout(async () => {
        await Bun.write(${JSON.stringify(survivorMarker)}, 'survived')
        process.exit(0)
      }, 1600)
      setInterval(() => {}, 1000)
    `
    const parentScript = `
      Bun.spawn([${JSON.stringify(process.execPath)}, '-e', ${JSON.stringify(grandchildScript)}], {
        stdout: 'inherit',
        stderr: 'inherit',
      })
      console.log('successful-leader-exited')
      process.exit(0)
    `
    try {
      const startedAt = performance.now()
      const result = await runBackendShard(
        repoRoot,
        runRoot,
        runtimePlan(runRoot, [process.execPath, '-e', parentScript]),
        { timeoutMs: 10_000, killGraceMs: 50 },
      )

      expect(result.exitCode).toBe(0)
      expect(result.timedOut).toBe(false)
      expect(result.durationMs).toBeLessThan(2_000)
      expect(performance.now() - startedAt).toBeLessThan(2_000)
      expect(result.output).toContain('successful-leader-exited')
      expect(result.output).toContain('output pipes remained open for 1000ms')
      await Bun.sleep(650)
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
    // RFC-319 T15 —— 默认车道**不含** Playwright：跑它要先建二进制（本机数分钟）
    // 再跑 340+ 条浏览器用例（4.1 分钟）。门禁一旦慢到让人想跳过，它保护的东西全失效。
    expect(localGateLanes({} as NodeJS.ProcessEnv).map((lane) => lane.name)).toEqual([
      'backend',
      'quality',
    ])
    // 但它必须**开得起来**：docs/dev-gotchas.md 里「e2e 不在任何本地门禁覆盖面内」
    // 这条已经复发三次，一条命令能开的车道比「记住要手动跑」有效。
    expect(
      localGateLanes({ AW_GATE_E2E: '1' } as NodeJS.ProcessEnv).map((lane) => lane.name),
    ).toEqual(['backend', 'quality', 'e2e'])
    // 可选车道只跑 PR 档——与 CI 的 PR 腿同一个过滤，否则本地绿 / CI 红的差集又回来了。
    expect(OPTIONAL_E2E_LANE.commands.map((command) => command.args.join(' '))).toEqual([
      'run e2e -- --grep-invert @nightly',
    ])
    expect(LOCAL_GATE_LANES[0]?.commands).toEqual([
      { label: 'backend tests', args: ['run', 'test:backend'] },
    ])
    expect(LOCAL_GATE_LANES[1]?.commands.map((command) => command.args.join(' '))).toEqual([
      'run typecheck',
      'run lint',
      'run format:check',
      'run depcheck',
      'run test:shared',
      // RFC-310 PR-11/12/13 收口补齐：CI 的 lint job 一直跑 system mock 用例，本地
      // 门禁没有，于是一条红的 mock 用例可以全绿地推上主干（实撞一次）。
      'run test:system-mocks',
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

describe('local full-gate concurrency guard', () => {
  test('uses one lock identity across the main checkout and linked worktrees', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'aw-local-gate-lock-path-'))
    const mainRoot = join(fixture, 'main')
    const worktreeRoot = join(fixture, 'linked')
    const commonGitDir = join(mainRoot, '.git')
    const worktreeGitDir = join(commonGitDir, 'worktrees', 'linked')
    const lockRoot = join(fixture, 'locks')
    try {
      mkdirSync(worktreeGitDir, { recursive: true })
      mkdirSync(worktreeRoot, { recursive: true })
      mkdirSync(lockRoot)
      writeFileSync(join(worktreeGitDir, 'commondir'), '../..\n')
      writeFileSync(join(worktreeRoot, '.git'), `gitdir: ${worktreeGitDir}\n`)

      expect(resolveLocalGateLockPath(mainRoot, lockRoot)).toBe(
        resolveLocalGateLockPath(worktreeRoot, lockRoot),
      )
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  test('rejects an overlapping gate and releases the lock for the next run', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'aw-local-gate-lock-live-'))
    const repoRoot = join(fixture, 'repo')
    const lockRoot = join(fixture, 'locks')
    try {
      mkdirSync(join(repoRoot, '.git'), { recursive: true })
      const first = acquireLocalGateLock(repoRoot, {
        lockRoot,
        pid: 101,
        token: 'first',
        now: () => new Date('2026-08-15T12:00:00.000Z'),
        isProcessAlive: (pid) => pid === 101,
      })

      expect(() =>
        acquireLocalGateLock(repoRoot, {
          lockRoot,
          pid: 202,
          token: 'second',
          isProcessAlive: (pid) => pid === 101,
        }),
      ).toThrow('pid 101')

      first.release()
      const second = acquireLocalGateLock(repoRoot, {
        lockRoot,
        pid: 202,
        token: 'second',
        isProcessAlive: () => true,
      })
      expect(existsSync(second.path)).toBe(true)
      second.release()
      expect(existsSync(second.path)).toBe(false)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  test('recovers a dead-owner lock without letting the old owner remove the replacement', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'aw-local-gate-lock-stale-'))
    const repoRoot = join(fixture, 'repo')
    const lockRoot = join(fixture, 'locks')
    try {
      mkdirSync(join(repoRoot, '.git'), { recursive: true })
      const stale = acquireLocalGateLock(repoRoot, {
        lockRoot,
        pid: 303,
        token: 'stale',
        isProcessAlive: () => true,
      })
      const replacement = acquireLocalGateLock(repoRoot, {
        lockRoot,
        pid: 404,
        token: 'replacement',
        isProcessAlive: () => false,
      })

      stale.release()
      expect(existsSync(replacement.path)).toBe(true)
      replacement.release()
      expect(existsSync(replacement.path)).toBe(false)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
