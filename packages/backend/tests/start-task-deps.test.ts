// RFC-159 T2 — buildStartTaskDeps reads LIVE config per-call.
//
// The scheduled-task scheduler builds StartTaskDeps via this factory so its fires
// behave identically to manual launches after a config edit (design.md finding 4):
// every call re-reads the config file rather than freezing values at daemon boot.
// Also locks the opencodeCmd/subagentLiveCapture conditional spreads that the JSON
// launch relied on (byte-equivalence).
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { loadConfig } from '../src/config'
import { createInMemoryDb } from '../src/db/client'
import { buildStartTaskDeps } from '../src/services/startTaskDeps'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function configWith(cfgPath: string, subagentLiveCapture: unknown): void {
  const base = loadConfig(cfgPath) // creates the file with defaults if missing
  writeFileSync(cfgPath, JSON.stringify({ ...base, subagentLiveCapture }, null, 2))
}

describe('buildStartTaskDeps (RFC-159 T2)', () => {
  test('passes db + actorUserId through; threads configPath (RFC-282 C1-2: the scheduler resolves)', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const dir = mkdtempSync(join(tmpdir(), 'rfc159-deps-'))
    const cfgPath = join(dir, 'config.json')
    configWith(cfgPath, { pollMs: 999, consecutiveFailureLimit: 7 })

    const withCmd = buildStartTaskDeps(db, cfgPath, 'alice')
    expect(withCmd.db).toBe(db)
    expect(withCmd.actorUserId).toBe('alice')
    expect(withCmd.configPath).toBe(cfgPath)

    const noCmd = buildStartTaskDeps(db, cfgPath, 'bob')
    expect(noCmd.actorUserId).toBe('bob')
    expect('opencodeCmd' in noCmd).toBe(false) // conditional spread: absent when omitted
  })

  test('reads subagentLiveCapture from LIVE config (re-read every call)', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const dir = mkdtempSync(join(tmpdir(), 'rfc159-deps-'))
    const cfgPath = join(dir, 'config.json')

    configWith(cfgPath, { pollMs: 999, consecutiveFailureLimit: 7 })
    expect(buildStartTaskDeps(db, cfgPath, 'alice').subagentLiveCapture).toEqual({
      pollMs: 999,
      consecutiveFailureLimit: 7,
    })

    // Edit the config → the very next build reflects it (no boot-time freeze).
    configWith(cfgPath, { pollMs: 111, consecutiveFailureLimit: 2 })
    expect(buildStartTaskDeps(db, cfgPath, 'alice').subagentLiveCapture).toEqual({
      pollMs: 111,
      consecutiveFailureLimit: 2,
    })
  })
})
