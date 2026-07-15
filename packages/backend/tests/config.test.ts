import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyConfigPatch, loadConfig, saveConfigRaw } from '../src/config'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { ValidationError } from '../src/util/errors'

describe('config load/save', () => {
  let tmp: string
  let path: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-config-'))
    path = join(tmp, 'config.json')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('first load writes defaults to disk and returns them', () => {
    expect(existsSync(path)).toBe(false)
    const cfg = loadConfig(path)
    expect(cfg).toEqual(DEFAULT_CONFIG)
    expect(existsSync(path)).toBe(true)
    const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    expect(onDisk.$schema_version).toBe(1)
    expect(onDisk.maxConcurrentNodes).toBe(4)
  })

  test('subsequent load reads same file', () => {
    const first = loadConfig(path)
    const second = loadConfig(path)
    expect(second).toEqual(first)
  })

  test('missing fields are backfilled with defaults', () => {
    // Write a partial config that omits everything except $schema_version
    // and one field. loadConfig should round-trip with defaults filled in.
    writeFileSync(
      path,
      JSON.stringify({ $schema_version: 1, opencodePath: '/opt/homebrew/bin/opencode' }),
    )
    const cfg = loadConfig(path)
    expect(cfg.opencodePath).toBe('/opt/homebrew/bin/opencode')
    expect(cfg.maxConcurrentNodes).toBe(DEFAULT_CONFIG.maxConcurrentNodes)
    expect(cfg.bindHost).toBe('127.0.0.1')
    expect(cfg.worktreeAutoGc.enabled).toBe(false)
  })

  test('nested objects deep-merge with defaults', () => {
    writeFileSync(
      path,
      JSON.stringify({
        $schema_version: 1,
        worktreeAutoGc: { enabled: true }, // olderThanDays omitted -> stays undefined
        eventsArchiveThresholds: { perNodeRunRows: 999 }, // globalRows backfilled
      }),
    )
    const cfg = loadConfig(path)
    expect(cfg.worktreeAutoGc.enabled).toBe(true)
    expect(cfg.eventsArchiveThresholds.perNodeRunRows).toBe(999)
    expect(cfg.eventsArchiveThresholds.globalRows).toBe(
      DEFAULT_CONFIG.eventsArchiveThresholds.globalRows,
    )
  })

  test('invalid JSON throws with file path in message', () => {
    writeFileSync(path, '{ not json')
    expect(() => loadConfig(path)).toThrow(/failed to parse/)
  })

  test('applyConfigPatch merges and writes', () => {
    loadConfig(path) // create defaults
    const updated = applyConfigPatch(path, {
      maxConcurrentNodes: 8,
      opencodePath: '/opt/homebrew/bin/opencode',
    })
    expect(updated.maxConcurrentNodes).toBe(8)
    expect(updated.opencodePath).toBe('/opt/homebrew/bin/opencode')

    const reread = loadConfig(path)
    expect(reread.maxConcurrentNodes).toBe(8)
    expect(reread.opencodePath).toBe('/opt/homebrew/bin/opencode')
  })

  // RFC-117 (impl-gate P2): the settings runtime "Inherit" option sends null to
  // clear a saved per-feature runtime override — mergePatch deletes the key so the
  // internal agent goes back to inheriting the global default. undefined alone
  // can't do it (JSON.stringify drops it; the merge then leaves the old value).
  test('applyConfigPatch clears a field patched with null (back to unset)', () => {
    loadConfig(path)
    applyConfigPatch(path, { memoryDistillRuntime: 'oc-haiku', commitPushRuntime: 'oc-fast' })
    expect(loadConfig(path).memoryDistillRuntime).toBe('oc-haiku')

    const updated = applyConfigPatch(path, { memoryDistillRuntime: null })
    expect(updated.memoryDistillRuntime).toBeUndefined()
    expect(loadConfig(path).memoryDistillRuntime).toBeUndefined()
    // the null clear is scoped — the other override is untouched.
    expect(loadConfig(path).commitPushRuntime).toBe('oc-fast')
  })

  test('applyConfigPatch rejects invalid field type', () => {
    loadConfig(path)
    expect(() => applyConfigPatch(path, { maxConcurrentNodes: -1 })).toThrow(ValidationError)
    expect(() => applyConfigPatch(path, { bindPort: 99999 })).toThrow(ValidationError)
  })

  test('applyConfigPatch preserves other fields on partial patch', () => {
    const before = loadConfig(path)
    const updated = applyConfigPatch(path, { theme: 'dark' })
    expect(updated.theme).toBe('dark')
    expect(updated.maxConcurrentNodes).toBe(before.maxConcurrentNodes)
    expect(updated.language).toBe(before.language)
  })

  test('applyConfigPatch cannot override $schema_version', () => {
    loadConfig(path)
    // ConfigPatchSchema omits $schema_version so it's just ignored.
    const updated = applyConfigPatch(path, { $schema_version: 999 })
    expect(updated.$schema_version).toBe(1)
  })

  // RFC-115: the per-node `retries` override was removed from the workflow node
  // and replaced by this global config (default 3, matching RFC-042's former
  // hard-coded `?? 3`). Unlike the optional RFC-002 fields it is required-with-
  // default, so a legacy config backfills to 3 rather than undefined.
  test('RFC-115 defaultNodeRetries round-trips and defaults to 3', () => {
    const cfg = loadConfig(path)
    expect(cfg.defaultNodeRetries).toBe(3)
    const updated = applyConfigPatch(path, { defaultNodeRetries: 5 })
    expect(updated.defaultNodeRetries).toBe(5)
    expect(loadConfig(path).defaultNodeRetries).toBe(5)
  })

  test('RFC-115 defaultNodeRetries accepts 0 (nonnegative) but rejects negatives / floats', () => {
    loadConfig(path)
    // 0 = explicit "no retries" — must be valid (nonnegative, NOT positive).
    expect(applyConfigPatch(path, { defaultNodeRetries: 0 }).defaultNodeRetries).toBe(0)
    expect(() => applyConfigPatch(path, { defaultNodeRetries: -1 })).toThrow(ValidationError)
    expect(() => applyConfigPatch(path, { defaultNodeRetries: 2.5 })).toThrow(ValidationError)
  })

  test('RFC-115 legacy config (missing defaultNodeRetries) backfills to 3', () => {
    writeFileSync(path, JSON.stringify({ $schema_version: 1, maxConcurrentNodes: 6 }))
    expect(loadConfig(path).defaultNodeRetries).toBe(3)
  })
})

// 2026-07-15 repo-root tempfile leak regression. Many route tests pass
// `configPath: ''` into server deps; loadConfig('') used to take the
// "write defaults" branch, drop `.config.json.tmp-<pid>-<ts>` into
// dirname('') === '.' (the repo root under `bun test`), then fail
// renameSync(tmp, '') with ENOENT — orphaning the tempfile. ~11,500 files
// (45MB) accumulated in the repo root between 2026-05-23 and 2026-07-15.
// Locks two invariants: (a) an empty/blank path fails fast before any
// filesystem write; (b) a failed rename never leaves its tempfile behind.
describe('config atomic write hygiene (repo-root tmp leak regression)', () => {
  const cwdTmpLeaks = () =>
    readdirSync(process.cwd()).filter((f) => f.startsWith('.config.json.tmp-'))

  test("loadConfig('') fails fast and writes nothing into cwd", () => {
    const before = cwdTmpLeaks()
    expect(() => loadConfig('')).toThrow(/empty config path/)
    expect(cwdTmpLeaks()).toEqual(before)
  })

  test("applyConfigPatch('') fails fast and writes nothing into cwd", () => {
    const before = cwdTmpLeaks()
    expect(() => applyConfigPatch('', { theme: 'dark' })).toThrow(/empty config path/)
    expect(cwdTmpLeaks()).toEqual(before)
  })

  test('whitespace-only path is rejected too', () => {
    expect(() => loadConfig('   ')).toThrow(/empty config path/)
  })

  test('failed rename cleans up its tempfile (target is a directory)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-config-rename-fail-'))
    try {
      const target = join(dir, 'config.json')
      // rename(regular file -> existing directory) throws EISDIR on both
      // macOS and Linux, exercising the cleanup path deterministically.
      mkdirSync(target)
      expect(() => saveConfigRaw(target, DEFAULT_CONFIG)).toThrow()
      expect(readdirSync(dir).filter((f) => f.startsWith('.config.json.tmp-'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('successful save leaves no tempfile behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-config-clean-'))
    try {
      const p = join(dir, 'config.json')
      loadConfig(p)
      applyConfigPatch(p, { theme: 'dark' })
      expect(existsSync(p)).toBe(true)
      expect(readdirSync(dir).filter((f) => f.startsWith('.config.json.tmp-'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
