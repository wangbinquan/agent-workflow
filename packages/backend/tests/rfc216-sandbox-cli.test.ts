// RFC-216 — cli/sandbox.ts orchestration: argv fail-closed, the exit-code truth
// table wired end to end, the configReadable axis (decision D), and boundedSpawn's
// whole-lifecycle normalization (launch throw / exited reject / timeout / stderr
// flood — design §2, P1#2/#3/#4 + P2#1). All hermetic via injected deps; no real
// mechanism is probed and no file outside the test tmp is touched.

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeBoundedSpawn, sandboxCommand, type RawSpawn, type SpawnedProbe } from '@/cli/sandbox'
import type { ProbeDiagnostics } from '@/services/sandbox/guidance'

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'rfc216-'))
  tmpDirs.push(d)
  return d
}

/** A boundedSpawn stub: probe sees `code`, renderer sees `diag`. */
function fakeBounded(code: number, diag: ProbeDiagnostics) {
  return { spawn: async () => code, getDiag: () => diag }
}
const exitDiag = (c: number, stderr = ''): ProbeDiagnostics => ({
  kind: 'exit',
  exitCode: c,
  stderrSnippet: stderr,
})

describe('sandboxCommand — argv fail-closed (P2#1)', () => {
  it('unknown flag → exit 2, never silently falls back', async () => {
    expect((await sandboxCommand(['--bogus'])).exitCode).toBe(2)
  })
  it('a typo of --require-available → exit 2 (NOT a silent default-gate pass)', async () => {
    const r = await sandboxCommand(['--require-availble'])
    expect(r.exitCode).toBe(2)
    expect(r.output).toContain('unknown option')
  })
  it('unknown positional → exit 2', async () => {
    expect((await sandboxCommand(['extra'])).exitCode).toBe(2)
  })
  it('--help wins over other flags and exits 0', async () => {
    const r = await sandboxCommand(['--help', '--require-available'])
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain('usage: agent-workflow sandbox')
  })
})

describe('sandboxCommand — exit-code cells (Linux, injected deps)', () => {
  const linux = { platform: 'linux' as const, configPath: join(tmp(), 'nope.json') } // missing → warn

  it('available (probe exit 0) + warn → 0', async () => {
    const r = await sandboxCommand([], {
      ...linux,
      which: () => '/usr/bin/bwrap',
      boundedSpawn: fakeBounded(0, exitDiag(0)),
    })
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain('✅')
  })

  it('unavailable + warn → 1, prints install command when bwrap missing', async () => {
    const r = await sandboxCommand([], {
      ...linux,
      which: (b) => (b === 'apt-get' ? '/usr/bin/apt-get' : null),
      boundedSpawn: fakeBounded(127, { kind: 'error', message: 'ENOENT' }),
    })
    expect(r.exitCode).toBe(1)
    expect(r.output).toContain('apt-get install -y bubblewrap')
  })

  it('off + available → default 0, strict 1', async () => {
    const dir = tmp()
    const cfg = join(dir, 'config.json')
    writeFileSync(cfg, JSON.stringify({ $schema_version: 1, sandboxMode: 'off' }))
    const base = {
      platform: 'linux' as const,
      configPath: cfg,
      which: () => '/usr/bin/bwrap' as string,
    }
    expect(
      (await sandboxCommand([], { ...base, boundedSpawn: fakeBounded(0, exitDiag(0)) })).exitCode,
    ).toBe(0)
    expect(
      (
        await sandboxCommand(['--require-available'], {
          ...base,
          boundedSpawn: fakeBounded(0, exitDiag(0)),
        })
      ).exitCode,
    ).toBe(1)
  })
})

describe('sandboxCommand — configReadable axis (decision D)', () => {
  it('corrupt config → exit 2 even when the mechanism is available; available not faked', async () => {
    const dir = tmp()
    const cfg = join(dir, 'config.json')
    writeFileSync(cfg, '{ this is not json')
    const r = await sandboxCommand([], {
      platform: 'linux',
      configPath: cfg,
      which: () => '/usr/bin/bwrap',
      boundedSpawn: fakeBounded(0, exitDiag(0)), // mechanism IS available
    })
    expect(r.exitCode).toBe(2)
    expect(r.output).toContain('config 不可读')
    expect(r.output).toContain('✅') // mechanism state shown truthfully
    // Reading a corrupt config must not have written anything (readConfig is read-only).
    expect(() => JSON.parse(readFileSync(cfg, 'utf-8'))).toThrow() // still corrupt, untouched
  })

  it('missing config → treated as warn (unavailable → 1)', async () => {
    const r = await sandboxCommand([], {
      platform: 'linux',
      configPath: join(tmp(), 'absent.json'),
      which: () => null,
      boundedSpawn: fakeBounded(127, { kind: 'error', message: 'ENOENT' }),
    })
    expect(r.exitCode).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// makeBoundedSpawn — the whole-lifecycle normalization + bounded reap.
// ---------------------------------------------------------------------------

function fakeProc(over: Partial<SpawnedProbe>): SpawnedProbe {
  return { pid: 4242, stderr: null, exited: Promise.resolve(0), ...over }
}
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}

describe('makeBoundedSpawn — normalizes every failure to unavailable, never throws (P1#2/P2#1)', () => {
  it('launch throw (missing binary) → diag error, returns 127, no throw', async () => {
    const rawSpawn: RawSpawn = () => {
      throw new Error('spawn bwrap ENOENT')
    }
    const b = makeBoundedSpawn(rawSpawn)
    const code = await b.spawn(['bwrap'])
    expect(code).toBe(127)
    expect(b.getDiag()).toEqual({ kind: 'error', message: 'spawn bwrap ENOENT' })
  })

  it('exited rejects → diag error, returns 127 (no crash)', async () => {
    const killed: number[] = []
    const rawSpawn: RawSpawn = () =>
      fakeProc({ pid: 999, exited: Promise.reject(new Error('exited boom')) })
    const b = makeBoundedSpawn(rawSpawn, (pid) => void killed.push(pid))
    const code = await b.spawn(['bwrap'])
    expect(code).toBe(127)
    expect(b.getDiag().kind).toBe('error')
    expect(killed).toContain(999) // finally still reaps the group
  })

  it('normal non-zero exit → diag exit with real code + capped stderr', async () => {
    const rawSpawn: RawSpawn = () =>
      fakeProc({
        exited: Promise.resolve(1),
        stderr: streamOf(new TextEncoder().encode('boom-stderr')),
      })
    const b = makeBoundedSpawn(rawSpawn)
    const code = await b.spawn(['bwrap'])
    expect(code).toBe(1)
    const diag = b.getDiag()
    expect(diag).toMatchObject({ kind: 'exit', exitCode: 1 })
    if (diag.kind === 'exit') expect(diag.stderrSnippet).toContain('boom-stderr')
  })

  it('stderr flood is byte-capped (no buffer-all) — snippet ≤ cap', async () => {
    const flood = new Uint8Array(200_000).fill(65) // 200KB of 'A'
    const rawSpawn: RawSpawn = () =>
      fakeProc({ exited: Promise.resolve(1), stderr: streamOf(flood) })
    const b = makeBoundedSpawn(rawSpawn)
    await b.spawn(['bwrap'])
    const diag = b.getDiag()
    if (diag.kind === 'exit') expect(diag.stderrSnippet.length).toBeLessThanOrEqual(4096)
    else throw new Error('expected exit kind')
  })

  it('timeout → SIGKILL the group, diag timeout, returns non-zero (bounded, no hang)', async () => {
    let resolveExited!: (code: number) => void
    const exited = new Promise<number>((r) => {
      resolveExited = r
    })
    const killed: Array<[number, string]> = []
    // The kill spy resolves `exited` — mirrors a real SIGKILL making the child reap.
    const kill = (pid: number, sig: 'SIGKILL') => {
      killed.push([pid, sig])
      resolveExited(137)
    }
    const rawSpawn: RawSpawn = () => fakeProc({ pid: 555, exited })
    const b = makeBoundedSpawn(rawSpawn, kill, 20) // 20ms deadline
    const code = await b.spawn(['bwrap'])
    expect(code).toBe(127)
    expect(b.getDiag()).toEqual({ kind: 'timeout' })
    expect(killed.some(([pid, sig]) => pid === 555 && sig === 'SIGKILL')).toBe(true)
  })
})
