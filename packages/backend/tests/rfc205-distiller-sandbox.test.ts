// RFC-205 impl-gate P0-4 (Codex 2026-07-22) — the memory distiller feeds UNTRUSTED
// content (source-agent transcripts + reviewed document bodies) into a real
// subprocess, so its spawn MUST be sandboxed like a task node — a prompt injection
// could otherwise run a same-uid shell that reads secret.key / db.sqlite / backups
// off disk. Locks the ctx shape + that wrapSandbox actually wraps under it. Real
// isolation is covered by the gated sandbox integration.
//
// MUTATION CHECK: drop the wrapSandbox call in defaultDistillerSpawn → the source
// guard reds.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ContainmentCoordinator, wrapSandbox } from '../src/services/sandbox'
import { distillerSandboxCtx } from '../src/services/memoryDistiller'

async function containment(mode: 'enforce' | 'off', appHome: string) {
  return new ContainmentCoordinator({
    provider: {
      mode,
      status: { mechanism: 'seatbelt', available: true, detail: null },
      appHome,
    },
    qualifySeatbelt: async () => {},
  }).admit('runner-filesystem-v1')
}

describe('RFC-205 P0-4 — distiller spawn is sandboxed', () => {
  test('ctx allows only the working dir + shadows appHome; no admission → undefined', async () => {
    expect(distillerSandboxCtx('/work/attempt')).toBeUndefined() // no provider set
    const ctx = distillerSandboxCtx('/work/attempt', '/work/attempt', {
      containment: await containment('enforce', '/home/aw'),
    })
    expect(ctx?.taskWorktrees).toEqual(['/work/attempt'])
    expect(ctx?.runDir).toBe('/work/attempt')
    expect(ctx?.appHome).toBe('/home/aw')
    expect(ctx?.mode).toBe('enforce')
  })

  test('verified system store is an explicit RW sandbox subtree under shadowed appHome', async () => {
    const ctx = distillerSandboxCtx('/work/attempt', '/work/run', {
      containment: await containment('enforce', '/home/aw'),
      sessionStore: {
        root: '/home/aw/opencode-stores/system-ephemeral/invocation',
        dbPath: '/home/aw/opencode-stores/system-ephemeral/invocation/opencode.db',
        persistent: false,
      },
    })
    expect(ctx?.taskWorktrees).toEqual([
      '/work/attempt',
      '/home/aw/opencode-stores/system-ephemeral/invocation',
    ])
    expect(ctx?.runDir).toBe('/work/run')
  })

  test('wrapSandbox on the distiller ctx actually wraps the argv (enforce+seatbelt)', async () => {
    const wrapped = wrapSandbox(
      ['/bin/echo', 'hi'],
      distillerSandboxCtx('/tmp', '/tmp', {
        containment: await containment('enforce', '/tmp'),
      }),
    )
    expect(wrapped[0]).toBe('/usr/bin/sandbox-exec') // wrapped, not the raw cmd
    expect(wrapped).toContain('/bin/echo')
  })

  test('off mode → wrapSandbox is a no-op (byte-identical spawn)', async () => {
    expect(
      wrapSandbox(
        ['/bin/echo', 'hi'],
        distillerSandboxCtx('/tmp', '/tmp', {
          containment: await containment('off', '/tmp'),
        }),
      ),
    ).toEqual(['/bin/echo', 'hi'])
  })

  // Source guard: defaultDistillerSpawn must route its argv through wrapSandbox
  // BEFORE spawning (a raw Bun.spawn(plan.cmd) would re-open the injection hole).
  test('defaultDistillerSpawn wraps the spawn before Bun.spawn (source guard)', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'memoryDistiller.ts'),
      'utf-8',
    )
    const wrapIdx = src.indexOf('const cmd = wrapSpawnPlanSandbox(')
    const spawnIdx = src.indexOf('child = Bun.spawn(')
    expect(wrapIdx).toBeGreaterThan(0)
    expect(spawnIdx).toBeGreaterThan(wrapIdx)
  })
})
