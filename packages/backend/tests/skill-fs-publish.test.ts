// RFC-170 §6a/§13 — op-scoped atomic publish primitives.
//
// Locks: publish moves any previous live tree to the op-scoped BACKUP before
// swapping the staged tree into `files` (previous content is never lost); the
// swap is idempotent for roll-forward (re-running after a published result is a
// no-op); roll-back restores from backup; cleanup removes all op-scoped siblings.
// The op-scoped naming ({files}.op-{opId}.{kind}) is what makes a probed dir
// unambiguously attributable to its op (G4-2).

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanupOpDirs,
  opBackupDir,
  opCandidateDir,
  opScopedDir,
  opStagedDir,
  restoreFromBackup,
  swapInStaged,
} from '../src/services/skillFsPublish'

describe('skillFsPublish — op-scoped atomic publish', () => {
  let root: string
  let filesDir: string
  const OP = '01OPAAAAAAAAAAAAAAAAAAAAAA'

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aw-fspub-'))
    filesDir = join(root, 'files')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function seedDir(dir: string, marker: string): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), marker, 'utf-8')
  }
  const marker = (dir: string): string => readFileSync(join(dir, 'SKILL.md'), 'utf-8')

  test('op-scoped names are collision-free siblings carrying the op_id', () => {
    expect(opStagedDir(filesDir, OP)).toBe(`${filesDir}.op-${OP}.staged`)
    expect(opBackupDir(filesDir, OP)).toBe(`${filesDir}.op-${OP}.backup`)
    expect(opCandidateDir(filesDir, OP)).toBe(`${filesDir}.op-${OP}.candidate`)
    expect(opScopedDir(filesDir, OP, 'candidate')).toBe(`${filesDir}.op-${OP}.candidate`)
  })

  test('publish into empty slot: staged → files, no previous', () => {
    seedDir(opStagedDir(filesDir, OP), 'NEW')
    const { hadPrevious } = swapInStaged(filesDir, OP)
    expect(hadPrevious).toBe(false)
    expect(marker(filesDir)).toBe('NEW')
    expect(existsSync(opStagedDir(filesDir, OP))).toBe(false) // staged consumed
  })

  test('publish over existing live: previous moved to backup, staged swapped in', () => {
    seedDir(filesDir, 'OLD')
    seedDir(opStagedDir(filesDir, OP), 'NEW')
    const { hadPrevious } = swapInStaged(filesDir, OP)
    expect(hadPrevious).toBe(true)
    expect(marker(filesDir)).toBe('NEW')
    expect(marker(opBackupDir(filesDir, OP))).toBe('OLD') // previous preserved
  })

  test('swapInStaged is idempotent for roll-forward: re-run after publish is a no-op', () => {
    seedDir(filesDir, 'OLD')
    seedDir(opStagedDir(filesDir, OP), 'NEW')
    swapInStaged(filesDir, OP)
    // Re-running (roll-forward replays the fs-published step) must not corrupt.
    const again = swapInStaged(filesDir, OP)
    expect(marker(filesDir)).toBe('NEW')
    expect(again.hadPrevious).toBe(true) // backup still present
  })

  test('restoreFromBackup undoes a swap (roll-back before db-committed)', () => {
    seedDir(filesDir, 'OLD')
    seedDir(opStagedDir(filesDir, OP), 'NEW')
    swapInStaged(filesDir, OP)
    expect(marker(filesDir)).toBe('NEW')
    const restored = restoreFromBackup(filesDir, OP)
    expect(restored).toBe(true)
    expect(marker(filesDir)).toBe('OLD') // original live restored
    expect(existsSync(opBackupDir(filesDir, OP))).toBe(false)
  })

  test('restoreFromBackup is a no-op when there is no backup', () => {
    seedDir(filesDir, 'LIVE')
    expect(restoreFromBackup(filesDir, OP)).toBe(false)
    expect(marker(filesDir)).toBe('LIVE')
  })

  test('cleanupOpDirs removes every op-scoped sibling', () => {
    seedDir(opStagedDir(filesDir, OP), 's')
    seedDir(opBackupDir(filesDir, OP), 'b')
    seedDir(opCandidateDir(filesDir, OP), 'c')
    cleanupOpDirs(filesDir, OP)
    expect(existsSync(opStagedDir(filesDir, OP))).toBe(false)
    expect(existsSync(opBackupDir(filesDir, OP))).toBe(false)
    expect(existsSync(opCandidateDir(filesDir, OP))).toBe(false)
  })

  test('swapInStaged throws when neither staged nor a published files exists', () => {
    expect(() => swapInStaged(filesDir, OP)).toThrow()
  })
})
