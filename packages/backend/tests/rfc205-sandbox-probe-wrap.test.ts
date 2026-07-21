// RFC-205 T2/T3 — mechanism probe (trial-run, cached) + spawn-boundary wrapper.
// Locks design §4-2/§4-3: existence ≠ usability (probe RUNS the mechanism);
// no ctx / off / unavailable ⇒ argv passes through untouched (the direct lock
// for "every existing test and stub keeps working"); plan.cmd is never mutated.

import { afterEach, describe, expect, test } from 'bun:test'
import {
  getSandboxStatus,
  probeSandboxMechanism,
  resetSandboxStatusForTest,
} from '../src/services/sandbox/probe'
import { sandboxActive, wrapSandbox, type SandboxCtx } from '../src/services/sandbox/index'

afterEach(() => resetSandboxStatusForTest())

describe('probeSandboxMechanism (trial-run semantics)', () => {
  test('darwin: exit 0 → seatbelt available; non-zero → unavailable with detail', async () => {
    expect(await probeSandboxMechanism('darwin', async () => 0)).toEqual({
      mechanism: 'seatbelt',
      available: true,
      detail: null,
    })
    const bad = await probeSandboxMechanism('darwin', async () => 1)
    expect(bad.available).toBe(false)
    expect(bad.detail).toContain('exited 1')
  })

  test('linux: 127 → install hint; other non-zero → userns hint; 0 → available', async () => {
    const missing = await probeSandboxMechanism('linux', async () => 127)
    expect(missing.available).toBe(false)
    expect(missing.detail).toContain('bubblewrap')
    const blocked = await probeSandboxMechanism('linux', async () => 1)
    expect(blocked.detail).toContain('user namespaces')
    expect((await probeSandboxMechanism('linux', async () => 0)).available).toBe(true)
  })

  test('unsupported platform → null mechanism, unavailable', async () => {
    const s = await probeSandboxMechanism('win32' as NodeJS.Platform, async () => 0)
    expect(s.mechanism).toBeNull()
    expect(s.available).toBe(false)
  })

  test('getSandboxStatus caches: second call runs zero probes', async () => {
    let calls = 0
    const spy = async (): Promise<number> => {
      calls += 1
      return 0
    }
    resetSandboxStatusForTest()
    await getSandboxStatus('darwin', spy)
    await getSandboxStatus('darwin', spy)
    expect(calls).toBe(1)
  })
})

const CTX_BASE: Omit<SandboxCtx, 'mode' | 'status'> = {
  appHome: '/h/.agent-workflow',
  taskWorktrees: ['/h/.agent-workflow/worktrees/r/t'],
  runDir: '/h/.agent-workflow/runs/t/n',
}

describe('wrapSandbox (spawn-boundary)', () => {
  const cmd = ['opencode', 'run', '--agent', 'x', '--', 'prompt'] as const

  test('no ctx → pass-through, NEW array, input untouched', () => {
    const input = [...cmd]
    const out = wrapSandbox(input, undefined)
    expect(out).toEqual([...cmd])
    expect(out).not.toBe(input)
    expect(input).toEqual([...cmd])
  })

  test('mode off / mechanism unavailable → pass-through', () => {
    const off: SandboxCtx = {
      ...CTX_BASE,
      mode: 'off',
      status: { mechanism: 'seatbelt', available: true, detail: null },
    }
    expect(wrapSandbox([...cmd], off)).toEqual([...cmd])
    const unavailable: SandboxCtx = {
      ...CTX_BASE,
      mode: 'warn',
      status: { mechanism: 'bwrap', available: false, detail: 'x' },
    }
    expect(wrapSandbox([...cmd], unavailable)).toEqual([...cmd])
    expect(sandboxActive(unavailable)).toBe(false)
  })

  test('seatbelt: argv head is sandbox-exec -p <profile>; original argv intact after it', () => {
    const ctx: SandboxCtx = {
      ...CTX_BASE,
      mode: 'warn',
      status: { mechanism: 'seatbelt', available: true, detail: null },
    }
    const input = [...cmd]
    const out = wrapSandbox(input, ctx)
    expect(out[0]).toBe('/usr/bin/sandbox-exec')
    expect(out[1]).toBe('-p')
    expect(out[2]).toContain('(version 1)')
    expect(out[2]).toContain('secret.key')
    expect(out.slice(3)).toEqual([...cmd])
    expect(input).toEqual([...cmd]) // never mutated (spawnBinaryPath reads it)
  })

  test('bwrap: argv head is bwrap …binds… -- cmd', () => {
    const ctx: SandboxCtx = {
      ...CTX_BASE,
      mode: 'enforce',
      status: { mechanism: 'bwrap', available: true, detail: null },
    }
    const out = wrapSandbox([...cmd], ctx)
    expect(out[0]).toBe('bwrap')
    const sep = out.indexOf('--')
    expect(sep).toBeGreaterThan(0)
    expect(out.slice(sep + 1)).toEqual([...cmd])
    expect(out).toContain('--tmpfs')
    expect(out).toContain(CTX_BASE.appHome)
  })
})
