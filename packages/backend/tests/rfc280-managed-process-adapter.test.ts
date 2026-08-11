// RFC-280 T4 — managedProcess 的 agent-adapter 扩展面（design §2.2 / 设计门
// P1-2 + P2-1）：stdin 一次性投递（claude prompt 传输）与 beforeSpawn 准入
// seam（MCP 测试台 turn 取消后的「不再 spawn」路径）。managedProcess 是全仓唯一
// 的 process-reliability authority——agent 执行器只做 adapter，不复制计时器。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runManagedProcess } from '@/services/execution/managedProcess'
import { runAgentProcess } from '@/services/execution/agentProcess'

const BUN = process.execPath

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'rfc280-mp-'))
}

describe('runManagedProcess stdin delivery (RFC-280 T4)', () => {
  test("stdin:{mode:'pipe'} writes once, closes, and the child reads to EOF", async () => {
    const dir = scratch()
    const script = join(dir, 'echo-stdin.ts')
    writeFileSync(
      script,
      `const text = await new Response(Bun.stdin.stream()).text()\nconsole.log('GOT:' + text)`,
    )
    const result = await runManagedProcess({
      argv: [BUN, script],
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 20_000,
      stdin: { mode: 'pipe', data: 'hello-prompt\nline2' },
      captureRawStdout: true,
    })
    expect(result.outcome).toBe('exited')
    expect(result.exitCode).toBe(0)
    expect(result.rawStdout).toContain('GOT:hello-prompt\nline2')
  })

  test('omitted stdin keeps the historical closed-stdin behavior (immediate EOF)', async () => {
    const dir = scratch()
    const script = join(dir, 'eof.ts')
    writeFileSync(
      script,
      `const text = await new Response(Bun.stdin.stream()).text()\nconsole.log('LEN:' + text.length)`,
    )
    const result = await runManagedProcess({
      argv: [BUN, script],
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 20_000,
      captureRawStdout: true,
    })
    expect(result.outcome).toBe('exited')
    expect(result.rawStdout).toContain('LEN:0')
  })
})

describe('runManagedProcess beforeSpawn admission seam (RFC-280 T4)', () => {
  test('a throwing beforeSpawn yields spawn-failed with the message, and NO child', async () => {
    const dir = scratch()
    const marker = join(dir, 'never-created.txt')
    const script = join(dir, 'touch.ts')
    writeFileSync(script, `await Bun.write('${marker.replaceAll('\\', '\\\\')}', 'x')`)
    const result = await runManagedProcess({
      argv: [BUN, script],
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 20_000,
      beforeSpawn: () => {
        throw new Error('mcp-test-spawn-no-longer-admitted')
      },
    })
    expect(result.outcome).toBe('spawn-failed')
    expect(result.pid).toBeNull()
    expect(result.spawnError).toContain('mcp-test-spawn-no-longer-admitted')
    expect(await Bun.file(marker).exists()).toBe(false)
  })

  test('a passing beforeSpawn runs the child normally', async () => {
    const dir = scratch()
    const script = join(dir, 'ok.ts')
    writeFileSync(script, `console.log('ran')`)
    let called = 0
    const result = await runManagedProcess({
      argv: [BUN, script],
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 20_000,
      captureRawStdout: true,
      beforeSpawn: () => {
        called += 1
      },
    })
    expect(called).toBe(1)
    expect(result.outcome).toBe('exited')
    expect(result.rawStdout).toContain('ran')
  })
})

describe('runAgentProcess impl-gate regression locks', () => {
  test('P2-C: onSpawned throw fences the child → aborted (playground admission seam)', async () => {
    const dir = scratch()
    const script = join(dir, 'sleep.ts')
    writeFileSync(script, `await Bun.sleep(30_000)\nconsole.log('should-not-finish')`)
    const result = await runAgentProcess({
      cmd: [BUN, script],
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 30_000,
      termGraceMs: 500,
      onSpawned: () => {
        throw new Error('turn-no-longer-admitted')
      },
      capture: { rawStdout: true },
    })
    // The receipt fence aborts the healthy child; outcome is 'aborted', not ok.
    expect(result.outcome).toBe('aborted')
    expect(result.rawStdout).not.toContain('should-not-finish')
  })

  test('P2-B/P2-C: a caller that swallows its own onSpawned error keeps the child alive', async () => {
    const dir = scratch()
    const script = join(dir, 'ok.ts')
    writeFileSync(script, `console.log('ran-fine')`)
    let called = 0
    const result = await runAgentProcess({
      cmd: [BUN, script],
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 20_000,
      capture: { rawStdout: true },
      onSpawned: () => {
        called += 1
        // best-effort persist "failed" but the caller chose NOT to rethrow.
      },
    })
    expect(called).toBe(1)
    expect(result.outcome).toBe('ok')
    expect(result.rawStdout).toContain('ran-fine')
  })

  test('P2-B: a throwing onStdoutLine surfaces pumpError and escalates the child', async () => {
    const dir = scratch()
    const script = join(dir, 'spew.ts')
    writeFileSync(
      script,
      `for (let i = 0; i < 5; i++) console.log('line' + i)\nawait Bun.sleep(30_000)`,
    )
    const result = await runAgentProcess({
      cmd: [BUN, script],
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 30_000,
      termGraceMs: 500,
      capture: {
        onStdoutLine: () => {
          throw new Error('persist-failed')
        },
      },
    })
    expect(result.pumpError).toContain('persist-failed')
    // The child was escalated (killed), not left running to timeout.
    expect(['aborted', 'nonzero-exit', 'ok']).toContain(result.outcome)
  })
})

describe('P1-A reap-deadline path source-locks (impl-gate 2nd round)', () => {
  // The pure reap-deadline trigger needs `child.exited` to never resolve — not
  // reproducible with a real killable child (SIGKILL always reaps). The repo's
  // convention for a real-but-hard-to-behaviorally-reproduce process invariant
  // is a source-level lock (cf. scheduler-audit-s15 / rfc108 / rfc098-source).
  const src = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'execution', 'managedProcess.ts'),
    'utf8',
  )

  test("P1-1: the abandoned unkillable child is unref'd before early-return", () => {
    // Without child.unref() the still-alive child pins the event loop forever
    // (the daemon / bun test cannot idle out). The pre-RFC-280 runner did this;
    // the T7 collapse dropped it; the 2nd-round impl-gate restored it.
    const childUnreapedIdx = src.indexOf('if (childUnreaped) {')
    expect(childUnreapedIdx).toBeGreaterThan(-1)
    const nextReturnIdx = src.indexOf('return {', childUnreapedIdx)
    const block = src.slice(childUnreapedIdx, nextReturnIdx)
    expect(block).toContain('child.unref()')
    expect(block).toContain('stdoutPump.cancel()')
    expect(block).toContain('stderrPump.cancel()')
  })

  test("P2-1: the reap deadline that settles the exit race is NOT unref'd (RFC-254)", () => {
    // The reap-deadline timer resolves the exit race (via reapDeadlineFire); an
    // unref\'d timer would never fire on Windows Bun once the loop is idle,
    // resurrecting the very hang the deadline exists to bound. Mirrors the
    // deliberately-ref\'d drainTimer.
    const armIdx = src.indexOf('reapDeadlineTimer = setTimeout(')
    expect(armIdx).toBeGreaterThan(-1)
    // The two statements after arming must NOT unref this timer (contrast the
    // killTimer/timeoutTimer whose callbacks do not settle the race).
    const after = src.slice(armIdx, armIdx + 200)
    expect(after).not.toContain('reapDeadlineTimer.unref()')
    // And it must be cleared in the finally (no leak once the race settles).
    expect(src).toContain('if (reapDeadlineTimer !== undefined) clearTimeout(reapDeadlineTimer)')
  })
})
