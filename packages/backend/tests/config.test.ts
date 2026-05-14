import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyConfigPatch, loadConfig } from '../src/config'
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
      JSON.stringify({ $schema_version: 1, defaultModel: 'anthropic/claude-opus-4-7' }),
    )
    const cfg = loadConfig(path)
    expect(cfg.defaultModel).toBe('anthropic/claude-opus-4-7')
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
      defaultModel: 'anthropic/claude-opus-4-7',
    })
    expect(updated.maxConcurrentNodes).toBe(8)
    expect(updated.defaultModel).toBe('anthropic/claude-opus-4-7')

    const reread = loadConfig(path)
    expect(reread.maxConcurrentNodes).toBe(8)
    expect(reread.defaultModel).toBe('anthropic/claude-opus-4-7')
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
})
