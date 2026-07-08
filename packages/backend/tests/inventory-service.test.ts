// RFC-029 T5 — services/inventory.ts.readSnapshotFromRunDir total-function
// coverage. Test discipline: assert the *reason code* + the *snapshot
// discriminator*, not exact error messages (those vary by node version).

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSnapshotFromRunDir } from '../src/services/inventory'
import { isAgentNodeKind } from '@agent-workflow/shared'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aw-inventory-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// RFC-146: inventory.isAgentRunKind was replaced by shared isAgentNodeKind.
// Keep the raw-surface tolerance lock here at the consumer boundary: DB rows
// hand this predicate plain strings / undefined, and those must stay false.
describe('isAgentNodeKind (raw-surface tolerance)', () => {
  test('only agent-single returns true (RFC-060 PR-E removed agent-multi)', () => {
    expect(isAgentNodeKind('agent-single')).toBe(true)
    for (const k of [
      'input',
      'output',
      'wrapper-git',
      'wrapper-loop',
      'wrapper-fanout',
      'review',
      'clarify',
      undefined,
      '',
    ]) {
      expect(isAgentNodeKind(k)).toBe(false)
    }
  })
})

describe('readSnapshotFromRunDir — short-circuits', () => {
  test('non-agent kind returns captured:false non-agent-kind without reading disk', async () => {
    const snap = await readSnapshotFromRunDir({
      runDir: dir,
      nodeKind: 'wrapper-git',
      pureMode: false,
    })
    expect(snap.captured).toBe(false)
    if (!snap.captured) expect(snap.reason).toBe('non-agent-kind')
  })

  test('pure mode preempts file read', async () => {
    const snap = await readSnapshotFromRunDir({
      runDir: dir,
      nodeKind: 'agent-single',
      pureMode: true,
    })
    expect(snap.captured).toBe(false)
    if (!snap.captured) expect(snap.reason).toBe('opencode-pure-mode')
  })
})

describe('readSnapshotFromRunDir — file reading', () => {
  test('file missing → captured:false with reason from classifier', async () => {
    const snap = await readSnapshotFromRunDir({
      runDir: dir,
      nodeKind: 'agent-single',
      pureMode: false,
    })
    expect(snap.captured).toBe(false)
    if (!snap.captured) {
      // runDir exists but inventory.json doesn't → ENOENT → file-missing.
      expect(snap.reason).toBe('file-missing')
    }
  })

  test('runDir missing entirely → plugin-load-failed', async () => {
    const ghostDir = join(dir, 'never-created')
    const snap = await readSnapshotFromRunDir({
      runDir: ghostDir,
      nodeKind: 'agent-single',
      pureMode: false,
    })
    expect(snap.captured).toBe(false)
    if (!snap.captured) expect(snap.reason).toBe('plugin-load-failed')
  })

  test('malformed JSON → captured:false parse-failed', async () => {
    writeFileSync(join(dir, 'inventory.json'), '{ this is not json', 'utf-8')
    const snap = await readSnapshotFromRunDir({
      runDir: dir,
      nodeKind: 'agent-single',
      pureMode: false,
    })
    expect(snap.captured).toBe(false)
    if (!snap.captured) expect(snap.reason).toBe('parse-failed')
  })

  test('dump-plugin-written captured:false stub is preserved verbatim', async () => {
    writeFileSync(
      join(dir, 'inventory.json'),
      JSON.stringify({
        captured: false,
        reason: 'dump-plugin-internal-error',
        message: 'SDK threw',
      }),
      'utf-8',
    )
    const snap = await readSnapshotFromRunDir({
      runDir: dir,
      nodeKind: 'agent-single',
      pureMode: false,
    })
    expect(snap.captured).toBe(false)
    if (!snap.captured) {
      expect(snap.reason).toBe('dump-plugin-internal-error')
      expect(snap.message).toBe('SDK threw')
    }
  })

  test('captured:true happy path → normalized & parsed snapshot', async () => {
    writeFileSync(
      join(dir, 'inventory.json'),
      JSON.stringify({
        schemaVersion: 1,
        capturedAt: 1700000000999,
        agents: [{ name: 'reviewer', mode: 'primary', source: 'inline' }],
        skills: [],
        // dump plugin already transcodes to top-level `type`; tests the
        // services/normalize path, not the SDK→inventory mapping (that's
        // covered in inventory-transcode.test.ts).
        mcps: [{ name: 'memcache', type: 'local', status: 'connected', hint: null }],
        plugins: [{ specifier: 'file:///a.mjs', source: 'inline' }],
      }),
      'utf-8',
    )
    const snap = await readSnapshotFromRunDir({
      runDir: dir,
      // RFC-060 PR-E: agent-multi removed; agent-single is the only agent kind.
      nodeKind: 'agent-single',
      pureMode: false,
    })
    expect(snap.captured).toBe(true)
    if (snap.captured) {
      expect(snap.schemaVersion).toBe(1)
      expect(snap.agents).toHaveLength(1)
      expect(snap.agents[0]!.name).toBe('reviewer')
      // mcps key flatten — confirm the Record→Array path went through.
      expect(snap.mcps[0]!.name).toBe('memcache')
      expect(snap.mcps[0]!.type).toBe('local')
    }
  })

  test('alternate fileName option is honored', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'custom.json'),
      JSON.stringify({
        schemaVersion: 1,
        capturedAt: 1,
        agents: [],
        skills: [],
        mcps: [],
        plugins: [],
      }),
      'utf-8',
    )
    const snap = await readSnapshotFromRunDir({
      runDir: dir,
      fileName: 'custom.json',
      nodeKind: 'agent-single',
      pureMode: false,
    })
    expect(snap.captured).toBe(true)
  })
})
