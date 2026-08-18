// RFC-311 — readConfig mtime+size cache behavior.
//
// Half a dozen daemon loops call loadConfig every tick; each call used to pay
// readFileSync + JSON.parse + full zod validation. The cache must be
// invisible: identical results, immediate invalidation on both in-process
// saves and external file edits, and no shared mutable object between calls.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { applyConfigPatch, loadConfig, readConfig } from '../src/config'

describe('RFC-311 — readConfig cache', () => {
  test('repeat reads hit the cache but stay value-identical and un-aliased', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rfc311-cfg-'))
    try {
      const path = join(dir, 'config.json')
      const first = loadConfig(path) // writes defaults
      const second = readConfig(path)
      const third = readConfig(path)
      expect(second).toEqual(first)
      expect(third).toEqual(second)
      // Mutating one returned object must never leak into later reads.
      ;(second as { language?: string }).language = 'mutated'
      expect(readConfig(path)?.language).toBe(DEFAULT_CONFIG.language)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an in-process patch is visible immediately (save busts the cache)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rfc311-cfg-patch-'))
    try {
      const path = join(dir, 'config.json')
      loadConfig(path)
      readConfig(path) // warm the cache
      applyConfigPatch(path, { language: 'en-US' })
      expect(readConfig(path)?.language).toBe('en-US')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an external edit (new mtime) is picked up without any invalidate call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rfc311-cfg-ext-'))
    try {
      const path = join(dir, 'config.json')
      const cfg = loadConfig(path)
      readConfig(path) // warm the cache
      writeFileSync(path, JSON.stringify({ ...cfg, language: 'en-US' }, null, 2) + '\n')
      // Force a distinct mtime even on coarse-timestamp filesystems.
      const future = new Date(Date.now() + 5_000)
      utimesSync(path, future, future)
      expect(readConfig(path)?.language).toBe('en-US')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
