// RFC-101 PR-A — general skill content versioning + history + restore.
//
// Locks: every managed-skill write funnels through commitSkillVersion (a v1 on
// create, v+1 on each real edit, empty-write short-circuit), full history is
// browsable + diffable, restore is forward-only, legacy skills lazily backfill
// to v1, and the live-files reconciler self-heals a stale files/. The pure
// oracles (memoriesToUnfuseOnRestore, gitStyleDirDiff, hashDir) are unit-tested
// directly so PR-B can build the fusion flow on a trusted base.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { skills } from '../src/db/schema'
import {
  createManagedSkill,
  deleteSkillFile,
  getSkill,
  readSkillContent,
  writeSkillContent,
  writeSkillFile,
  type SkillFsOptions,
} from '../src/services/skill'
import {
  commitSkillVersion,
  diffSkillVersions,
  getSkillVersionContent,
  gitStyleDirDiff,
  hashDir,
  listSkillVersions,
  memoriesToUnfuseOnRestore,
  reconcileSkillLiveFiles,
  restoreSkillVersion,
  skillVersionRelPath,
  type TreeEntry,
} from '../src/services/skillVersion'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface H {
  db: DbClient
  fsOpts: SkillFsOptions
  cleanup: () => void
}

function build(): H {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-skill-ver-'))
  return {
    db: createInMemoryDb(MIGRATIONS),
    fsOpts: { appHome },
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

const liveSkillMd = (h: H, skillId: string) =>
  readFileSync(join(h.fsOpts.appHome, 'skills', skillId, 'files', 'SKILL.md'), 'utf-8')

// --- pure oracles ----------------------------------------------------------

describe('memoriesToUnfuseOnRestore', () => {
  const fused = [
    { id: 'a', fusedIntoSkillVersion: 2 },
    { id: 'b', fusedIntoSkillVersion: 3 },
    { id: 'c', fusedIntoSkillVersion: 5 },
    { id: 'd', fusedIntoSkillVersion: null },
  ]
  test('restoring to N un-fuses only memories fused at version > N', () => {
    expect(memoriesToUnfuseOnRestore(fused, 3).sort()).toEqual(['c'])
    expect(memoriesToUnfuseOnRestore(fused, 1).sort()).toEqual(['a', 'b', 'c'])
    expect(memoriesToUnfuseOnRestore(fused, 5)).toEqual([])
  })
  test('null fusedIntoSkillVersion is never un-fused', () => {
    expect(memoriesToUnfuseOnRestore([{ id: 'd', fusedIntoSkillVersion: null }], 0)).toEqual([])
  })
})

describe('gitStyleDirDiff', () => {
  const text = (content: string): TreeEntry => ({ kind: 'text', content })
  test('emits diff --git headers per changed file; skips identical', () => {
    const a = new Map<string, TreeEntry>([
      ['SKILL.md', text('one\ntwo\n')],
      ['keep.md', text('same\n')],
      ['gone.md', text('bye\n')],
    ])
    const b = new Map<string, TreeEntry>([
      ['SKILL.md', text('one\ntwo\nthree\n')],
      ['keep.md', text('same\n')],
      ['new.md', text('hi\n')],
    ])
    const diff = gitStyleDirDiff(a, b)
    expect(diff).toContain('diff --git a/SKILL.md b/SKILL.md')
    expect(diff).toContain('+three')
    expect(diff).toContain('diff --git a/new.md b/new.md')
    expect(diff).toContain('--- /dev/null') // added file
    expect(diff).toContain('diff --git a/gone.md b/gone.md')
    expect(diff).toContain('+++ /dev/null') // removed file
    expect(diff).not.toContain('keep.md') // unchanged file omitted
  })
  test('binary changes are noted, not patched', () => {
    const a = new Map<string, TreeEntry>([['img', { kind: 'binary', hash: 'h1' }]])
    const b = new Map<string, TreeEntry>([['img', { kind: 'binary', hash: 'h2' }]])
    const diff = gitStyleDirDiff(a, b)
    expect(diff).toContain('Binary files a/img and b/img differ')
  })
  test('identical binary is omitted', () => {
    const a = new Map<string, TreeEntry>([['img', { kind: 'binary', hash: 'h1' }]])
    const b = new Map<string, TreeEntry>([['img', { kind: 'binary', hash: 'h1' }]])
    expect(gitStyleDirDiff(a, b)).toBe('')
  })
})

describe('hashDir', () => {
  test('is deterministic and content-sensitive', () => {
    const h = build()
    try {
      const d = join(h.fsOpts.appHome, 'x')
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'a.txt'), 'hello')
      const h1 = hashDir(d)
      expect(hashDir(d)).toBe(h1) // stable
      writeFileSync(join(d, 'a.txt'), 'world')
      expect(hashDir(d)).not.toBe(h1) // content change detected
    } finally {
      h.cleanup()
    }
  })
})

// --- the funnel + history --------------------------------------------------

describe('skill versioning funnel', () => {
  let h: H
  beforeEach(() => {
    h = build()
  })
  afterEach(() => h.cleanup())

  test('createManagedSkill establishes v1', async () => {
    const created = await createManagedSkill(h.db, h.fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'v1 body',
      frontmatterExtra: {},
    })
    const skill = await getSkill(h.db, 'lint')
    expect(skill?.contentVersion).toBe(1)
    const versions = listSkillVersions(h.db, h.fsOpts, created.id)
    expect(versions).toHaveLength(1)
    expect(versions[0]?.versionIndex).toBe(1)
    expect(versions[0]?.source).toBe('initial')
    // disk snapshot exists
    expect(
      existsSync(join(h.fsOpts.appHome, skillVersionRelPath(created.id, 1), 'SKILL.md')),
    ).toBe(true)
  })

  test('writeSkillContent bumps to v2; old version preserved', async () => {
    const created = await createManagedSkill(h.db, h.fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'v1 body',
      frontmatterExtra: {},
    })
    await writeSkillContent(h.db, h.fsOpts, created.id, { bodyMd: 'v2 body' }, 'user-1')
    const skill = await getSkill(h.db, 'lint')
    expect(skill?.contentVersion).toBe(2)
    const versions = listSkillVersions(h.db, h.fsOpts, created.id)
    expect(versions.map((v) => v.versionIndex)).toEqual([2, 1]) // newest first
    expect(versions[0]?.source).toBe('editor')
    expect(versions[0]?.authorUserId).toBe('user-1')
    // v1 snapshot still holds the original body
    expect(getSkillVersionContent(h.db, h.fsOpts, created.id, 1).content.bodyMd).toContain(
      'v1 body',
    )
    expect(getSkillVersionContent(h.db, h.fsOpts, created.id, 2).content.bodyMd).toContain(
      'v2 body',
    )
    expect(liveSkillMd(h, created.id)).toContain('v2 body')
  })

  test('empty editor write does not inflate history', async () => {
    const created = await createManagedSkill(h.db, h.fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'stable',
      frontmatterExtra: {},
    })
    // re-save identical content
    await writeSkillContent(
      h.db,
      h.fsOpts,
      created.id,
      { bodyMd: 'stable', description: 'd' },
      'u',
    )
    expect(listSkillVersions(h.db, h.fsOpts, created.id)).toHaveLength(1)
    expect((await getSkill(h.db, 'lint'))?.contentVersion).toBe(1)
  })

  test('support-file write + delete each version the tree', async () => {
    const created = await createManagedSkill(h.db, h.fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'b',
      frontmatterExtra: {},
    })
    await writeSkillFile(
      h.db,
      h.fsOpts,
      created.id,
      'references/x.md',
      'ref content',
      'u',
    )
    expect((await getSkill(h.db, 'lint'))?.contentVersion).toBe(2)
    const v2 = getSkillVersionContent(h.db, h.fsOpts, created.id, 2)
    expect(v2.files.some((f) => f.path === 'references/x.md')).toBe(true)
    // delete it
    await deleteSkillFile(h.db, h.fsOpts, created.id, 'references/x.md', 'u')
    expect((await getSkill(h.db, 'lint'))?.contentVersion).toBe(3)
    expect(
      existsSync(
        join(h.fsOpts.appHome, 'skills', created.id, 'files', 'references', 'x.md'),
      ),
    ).toBe(false)
    // but v2 snapshot still has it
    expect(
      existsSync(
        join(
          h.fsOpts.appHome,
          skillVersionRelPath(created.id, 2),
          'references',
          'x.md',
        ),
      ),
    ).toBe(true)
  })

  test('diffSkillVersions returns a git-style diff DiffViewer can split', async () => {
    const created = await createManagedSkill(h.db, h.fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'alpha',
      frontmatterExtra: {},
    })
    await writeSkillContent(h.db, h.fsOpts, created.id, { bodyMd: 'alpha\nbeta' }, 'u')
    const { diff } = diffSkillVersions(h.db, h.fsOpts, created.id, 1, 2)
    expect(diff).toContain('diff --git a/SKILL.md b/SKILL.md')
    expect(diff).toContain('+beta')
  })

  test('restoreSkillVersion is forward-only and reverts content', async () => {
    const created = await createManagedSkill(h.db, h.fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'original',
      frontmatterExtra: {},
    })
    await writeSkillContent(h.db, h.fsOpts, created.id, { bodyMd: 'changed' }, 'u')
    expect(liveSkillMd(h, created.id)).toContain('changed')
    const { version } = restoreSkillVersion(
      h.db,
      h.fsOpts,
      created.id,
      1,
      'admin',
      'rollback',
    )
    expect(version.versionIndex).toBe(3) // new version, never destructive
    expect(version.source).toBe('restore')
    expect(version.restoredFromVersion).toBe(1)
    expect((await getSkill(h.db, 'lint'))?.contentVersion).toBe(3)
    expect(liveSkillMd(h, created.id)).toContain('original') // content reverted
    expect(
      readSkillContent(h.db, h.fsOpts, created.id).then((c) => c.bodyMd),
    ).resolves.toContain('original')
  })

  test('OCC: commitSkillVersion rejects a stale expectedVersion', async () => {
    const created = await createManagedSkill(h.db, h.fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'b',
      frontmatterExtra: {},
    })
    let code: string | undefined
    try {
      commitSkillVersion(h.db, h.fsOpts, created.id, () => {}, {
        source: 'editor',
        authorUserId: 'u',
        expectedVersion: 99,
      })
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe('skill-version-conflict')
  })
})

// --- legacy backfill + reconcile -------------------------------------------

describe('lazy backfill + reconcile', () => {
  let h: H
  beforeEach(() => {
    h = build()
  })
  afterEach(() => h.cleanup())

  function seedLegacySkill(name: string, body: string): string {
    // Simulate a skill created before RFC-101: a DB row + files/ on disk, no
    // skill_versions rows.
    const id = ulid()
    const filesDir = join(h.fsOpts.appHome, 'skills', id, 'files')
    mkdirSync(filesDir, { recursive: true })
    writeFileSync(
      join(filesDir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: d\n---\n${body}\n`,
      'utf-8',
    )
    h.db
      .insert(skills)
      .values({
        id,
        name,
        sourceKind: 'managed',
        managedPath: `skills/${id}/files`,
      })
      .run()
    return id
  }

  test('ensureInitialSkillVersion backfills v1 from current files on first access', () => {
    const id = seedLegacySkill('legacy', 'legacy body')
    expect(listSkillVersions(h.db, h.fsOpts, id)).toHaveLength(1)
    expect(getSkillVersionContent(h.db, h.fsOpts, id, 1).content.bodyMd).toContain(
      'legacy body',
    )
  })

  test('a legacy skill then edited keeps legacy content as v1, edit as v2', async () => {
    const id = seedLegacySkill('legacy', 'legacy body')
    await writeSkillContent(h.db, h.fsOpts, id, { bodyMd: 'edited body' }, 'u')
    expect(getSkillVersionContent(h.db, h.fsOpts, id, 1).content.bodyMd).toContain(
      'legacy body',
    )
    expect(getSkillVersionContent(h.db, h.fsOpts, id, 2).content.bodyMd).toContain(
      'edited body',
    )
  })

  test('reconcileSkillLiveFiles restores live files/ ONLY when it is lost entirely', async () => {
    const created = await createManagedSkill(h.db, h.fsOpts, {
      name: 'lint',
      description: 'd',
      bodyMd: 'good',
      frontmatterExtra: {},
    })
    const filesDir = join(h.fsOpts.appHome, 'skills', created.id, 'files')
    // Live present but DIFFERENT (e.g. an out-of-funnel ZIP overwrite): must NOT
    // be clobbered by the snapshot (Codex P1 — that would lose the write).
    writeFileSync(join(filesDir, 'SKILL.md'), 'EXTERNAL EDIT', 'utf-8')
    reconcileSkillLiveFiles(h.db, h.fsOpts)
    expect(liveSkillMd(h, created.id)).toContain('EXTERNAL EDIT') // preserved

    // Live lost entirely (files/ deleted): restored from the current snapshot.
    rmSync(filesDir, { recursive: true, force: true })
    reconcileSkillLiveFiles(h.db, h.fsOpts)
    expect(liveSkillMd(h, created.id)).toContain('good')
  })
})

// --- source-text guard: SKILL.md writes funnel through commitSkillVersion ---

describe('write-path single funnel (source guard)', () => {
  test('skill.ts no longer writes SKILL.md outside commitSkillVersion', () => {
    const src = readFileSync(resolve(import.meta.dir, '..', 'src', 'services', 'skill.ts'), 'utf-8')
    // The only writeFileSync(...) calls remaining must be inside produce()
    // closures handed to commitSkillVersion — never a direct write to the live
    // root's SKILL.md (which would bypass versioning).
    expect(src).not.toContain("writeFileSync(join(root, 'SKILL.md')")
    expect(src).toContain('commitSkillVersion(')
  })
})
