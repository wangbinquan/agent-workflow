// RFC-280 T4 — managedProcess 的 agent-adapter 扩展面（design §2.2 / 设计门
// P1-2 + P2-1）：stdin 一次性投递（claude prompt 传输）与 beforeSpawn 准入
// seam（MCP 测试台 turn 取消后的「不再 spawn」路径）。managedProcess 是全仓唯一
// 的 process-reliability authority——agent 执行器只做 adapter，不复制计时器。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runManagedProcess } from '@/services/execution/managedProcess'

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
