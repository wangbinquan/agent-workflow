// RFC-216 T1 — readConfig is the NO-WRITE variant of loadConfig. The whole
// "sandbox preflight touches no files" contract rests on it: loadConfig writes
// DEFAULT_CONFIG to disk on a missing file (config/index.ts), which on a fresh
// box would create ~/.agent-workflow/config.json out of a pure diagnostic.
//
// Locks: readConfig must (a) return null on missing WITHOUT creating the dir,
// (b) parse an existing (even partial) file WITHOUT rewriting a single byte,
// (c) throw on corrupt WITHOUT writing — while loadConfig keeps its historical
// write-on-missing behavior (regression lock).

import { describe, expect, it, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, readConfig } from '@/config'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'rfc216-cfg-'))
  dirs.push(d)
  return d
}

describe('readConfig — missing file: null + ZERO write (P1-1)', () => {
  it('returns null and does not create the parent dir', () => {
    const root = tmp()
    const path = join(root, 'never-created', 'config.json')
    expect(readConfig(path)).toBeNull()
    expect(existsSync(join(root, 'never-created'))).toBe(false) // no mkdir side effect
    expect(existsSync(path)).toBe(false)
  })
})

describe('readConfig — existing file: read-only, byte-identical, parity with loadConfig (P2#2)', () => {
  it('parses a partial config, backfills defaults, and leaves the file untouched', () => {
    const path = join(tmp(), 'config.json')
    const original = JSON.stringify({ $schema_version: 1, sandboxMode: 'enforce' }, null, 2) + '\n'
    writeFileSync(path, original)

    const before = readFileSync(path)
    const cfg = readConfig(path)
    const after = readFileSync(path)

    expect(cfg).not.toBeNull()
    expect(cfg?.sandboxMode).toBe('enforce')
    // Nested defaults are backfilled (config forward-compat) so the parse never fails:
    expect(cfg).toEqual(loadConfig(path)) // parity with the write-on-missing loader (existing file → no write)
    // Not one byte rewritten:
    expect(after.equals(before)).toBe(true)
  })
})

describe('readConfig — corrupt file: throws WITHOUT writing', () => {
  it('throws on bad JSON and leaves the corrupt bytes exactly as they were', () => {
    const path = join(tmp(), 'config.json')
    writeFileSync(path, '{ not valid json ]')
    const before = readFileSync(path)

    expect(() => readConfig(path)).toThrow()
    expect(readFileSync(path).equals(before)).toBe(true)
  })
})

describe('loadConfig — write-on-missing behavior is preserved (regression lock)', () => {
  it('materializes DEFAULT_CONFIG to disk on a missing file', () => {
    const path = join(tmp(), 'config.json')
    expect(existsSync(path)).toBe(false)
    const cfg = loadConfig(path)
    expect(existsSync(path)).toBe(true) // <- loadConfig DID write; readConfig would NOT have
    const onDisk = JSON.parse(readFileSync(path, 'utf-8'))
    expect(onDisk.sandboxMode).toBe(cfg.sandboxMode)
  })
})
