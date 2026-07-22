// RFC-205 impl-gate P0-4 (Codex 2026-07-22) — the memory distiller feeds UNTRUSTED
// content (source-agent transcripts + reviewed document bodies) into a real
// subprocess, so its spawn MUST be sandboxed like a task node — a prompt injection
// could otherwise run a same-uid shell that reads secret.key / db.sqlite / backups
// off disk. Locks the ctx shape + that wrapSandbox actually wraps under it. Real
// isolation is covered by the gated sandbox integration.
//
// MUTATION CHECK: drop the wrapSandbox call in defaultDistillerSpawn → the source
// guard reds.

import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setSandboxProvider, wrapSandbox } from '../src/services/sandbox'
import { distillerSandboxCtx } from '../src/services/memoryDistiller'

afterEach(() => setSandboxProvider(null))

describe('RFC-205 P0-4 — distiller spawn is sandboxed', () => {
  test('ctx allows only the working dir + shadows appHome; no provider → undefined', () => {
    expect(distillerSandboxCtx('/work/attempt')).toBeUndefined() // no provider set
    setSandboxProvider({
      mode: 'enforce',
      status: { mechanism: 'seatbelt', available: true, detail: null },
      appHome: '/home/aw',
    })
    const ctx = distillerSandboxCtx('/work/attempt')
    expect(ctx?.taskWorktrees).toEqual(['/work/attempt'])
    expect(ctx?.runDir).toBe('/work/attempt')
    expect(ctx?.appHome).toBe('/home/aw')
    expect(ctx?.mode).toBe('enforce')
  })

  test('wrapSandbox on the distiller ctx actually wraps the argv (enforce+seatbelt)', () => {
    setSandboxProvider({
      mode: 'enforce',
      status: { mechanism: 'seatbelt', available: true, detail: null },
      appHome: '/tmp',
    })
    const wrapped = wrapSandbox(['/bin/echo', 'hi'], distillerSandboxCtx('/tmp'))
    expect(wrapped[0]).toBe('/usr/bin/sandbox-exec') // wrapped, not the raw cmd
    expect(wrapped).toContain('/bin/echo')
  })

  test('off mode → wrapSandbox is a no-op (byte-identical spawn)', () => {
    setSandboxProvider({
      mode: 'off',
      status: { mechanism: 'seatbelt', available: true, detail: null },
      appHome: '/tmp',
    })
    expect(wrapSandbox(['/bin/echo', 'hi'], distillerSandboxCtx('/tmp'))).toEqual([
      '/bin/echo',
      'hi',
    ])
  })

  // Source guard: defaultDistillerSpawn must route its argv through wrapSandbox
  // BEFORE spawning (a raw Bun.spawn(plan.cmd) would re-open the injection hole).
  test('defaultDistillerSpawn wraps the spawn before Bun.spawn (source guard)', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'memoryDistiller.ts'),
      'utf-8',
    )
    const wrapIdx = src.indexOf('wrapSandbox(plan.cmd, distillerSandboxCtx(input.cwd))')
    const spawnIdx = src.indexOf('const child = Bun.spawn(')
    expect(wrapIdx).toBeGreaterThan(0)
    expect(spawnIdx).toBeGreaterThan(wrapIdx)
  })
})
