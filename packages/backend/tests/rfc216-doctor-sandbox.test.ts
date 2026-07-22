// RFC-216 T5 / decision B — doctor's sandbox check. `ok = !(enforce && !available)`:
// only enforce+unavailable is a genuine failure (it 409s every task launch), so a
// warn-mode box without bwrap never reds the `doctor` smoke. A corrupt config must
// be caught HERE (assume warn) — if it propagated it would truncate the whole
// doctor report (P1#4-r3); the corruption itself is reported by checkConfig.

import { describe, expect, it, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSandbox } from '@/cli/doctor'
import type { ProbeDiagnostics, SandboxMode } from '@/services/sandbox/guidance'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function cfgWith(contents: string): string {
  const d = mkdtempSync(join(tmpdir(), 'rfc216-doc-'))
  dirs.push(d)
  const p = join(d, 'config.json')
  writeFileSync(p, contents)
  return p
}
function cfgMode(mode: SandboxMode): string {
  return cfgWith(JSON.stringify({ $schema_version: 1, sandboxMode: mode }))
}

const diag: ProbeDiagnostics = { kind: 'exit', exitCode: 1, stderrSnippet: '' }
/** probe sees `code` (0 → available). */
const bounded = (code: number) => ({ spawn: async () => code, getDiag: () => diag })

describe('checkSandbox — the mode × available truth table (decision B)', () => {
  it('available → ok, whatever the mode', async () => {
    for (const mode of ['off', 'warn', 'enforce'] as SandboxMode[]) {
      const r = await checkSandbox({
        platform: 'linux',
        configPath: cfgMode(mode),
        boundedSpawn: bounded(0),
      })
      expect(r).toMatchObject({ name: 'sandbox', ok: true })
    }
  })

  it('warn + unavailable → ok (informational — does NOT red the doctor smoke)', async () => {
    const r = await checkSandbox({
      platform: 'linux',
      configPath: cfgMode('warn'),
      boundedSpawn: bounded(127),
    })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('agent-workflow sandbox')
  })

  it('off + unavailable → ok (sandbox disabled by config)', async () => {
    const r = await checkSandbox({
      platform: 'linux',
      configPath: cfgMode('off'),
      boundedSpawn: bounded(127),
    })
    expect(r.ok).toBe(true)
  })

  it('enforce + unavailable → FAIL (this is the only cell that reds doctor)', async () => {
    const r = await checkSandbox({
      platform: 'linux',
      configPath: cfgMode('enforce'),
      boundedSpawn: bounded(127),
    })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('409')
  })
})

describe('checkSandbox — corrupt config must NOT reject (would truncate doctor, P1#4-r3)', () => {
  it('catches readConfig throw, assumes warn, resolves a CheckResult', async () => {
    const path = cfgWith('{ not json')
    // enforce vs warn is unknowable here → assumes warn → ok even though unavailable.
    const r = await checkSandbox({
      platform: 'linux',
      configPath: path,
      boundedSpawn: bounded(127),
    })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('config 不可读')
  })
})
