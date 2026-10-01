// RFC-370 H6: history and diff use the selected asynchronous snapshot reader.
// Real provider metadata and file snapshots preserve the existing history rules.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Skill } from '@agent-workflow/shared'
import { users } from '@/db/schema'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import type { SkillOperationContext } from '@/modules/resource-catalog/public/participants'
import type {
  SkillVersionContentReader,
  SkillVersionReadReference,
  SkillVersionTreeEntry,
} from '@/modules/resource-catalog/application/skills/versionContentReader'
import { composeSkillCatalog } from '@/modules/resource-catalog/composition/skillOperations'
import {
  createManagedSkill,
  writeSkillContent,
} from '@/modules/resource-catalog/infrastructure/legacy/skill'
import {
  diffSkillVersions,
  getSkillVersionContent,
} from '@/modules/resource-catalog/infrastructure/legacy/skillVersion'
import { createFileSkillVersionContentReader } from '@/modules/resource-catalog/infrastructure/local/fileSkillVersionContentReader'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider } from './helpers/eachProvider'
import { admitTestDirectAuthority } from './helpers/identityAccessAuthority'

function barrier() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return { pending, release }
}

async function reached(gate: ReturnType<typeof barrier>, pending: Promise<unknown>) {
  await Promise.race([
    gate.pending,
    pending.then(() => {
      throw new Error('history returned before the selected read')
    }),
  ])
}

describeEachProvider('RFC-370 skill version reader', (harness) => {
  let appHome: string
  let skill: Skill
  let authority: SkillOperationContext
  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-version-reader-'))
    await harness.db.insert(users).values({
      id: 'version-reader-admin',
      username: 'version-reader-admin',
      displayName: 'Version reader admin',
      role: 'admin',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    })
    const admitted = await admitTestDirectAuthority(
      createIdentityAccessRuntime({ db: harness.db }).directAuthority,
      { source: 'session', userId: 'version-reader-admin' },
    )
    if (admitted === null) throw new Error('history fixture authority unavailable')
    authority = admitted.actor
    skill = await createManagedSkill(
      harness.db,
      { appHome },
      {
        name: 'history-reader',
        description: 'local description',
        bodyMd: 'local first',
        frontmatterExtra: {},
      },
    )
    await writeSkillContent(
      harness.db,
      { appHome },
      skill.id,
      { bodyMd: 'local second' },
      'version-reader-admin',
    )
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  test('catalog awaits selected historical bytes without reading its app home', async () => {
    const entered = barrier(),
      ready = barrier()
    const references: SkillVersionReadReference[] = []
    const unused = join(appHome, 'absent-home')
    const reader: SkillVersionContentReader = {
      async readSnapshot(reference) {
        references.push(reference)
        entered.release()
        await ready.pending
        return {
          main: '---\nname: ignored-snapshot-name\ndescription: historical description\ncustom: kept\n---\nhistorical body',
          files: [{ path: 'notes.txt', type: 'file', size: 5, modifiedAt: 12 }],
        }
      },
      readTree() {
        throw new Error('content must not request a diff tree')
      },
    }
    const catalog = composeSkillCatalog({
      db: harness.db,
      appHome: unused,
      versionReader: reader,
      restoreMembership: { unfuseForRestore: async () => [] },
    })
    let settled = false
    const pending = catalog.versionQueries
      .content(authority, { id: skill.id, version: '1' })
      .then((result) => {
        settled = true
        return result
      })
    try {
      await reached(entered, pending)
      expect(settled).toBe(false)
    } finally {
      ready.release()
    }
    expect(await pending).toEqual({
      versionIndex: 1,
      content: {
        name: skill.name,
        description: 'historical description',
        bodyMd: 'historical body',
        frontmatterExtra: { custom: 'kept' },
      },
      files: [{ path: 'notes.txt', type: 'file', size: 5, modifiedAt: 12 }],
    })
    expect(references).toEqual([{ skillId: skill.id, version: 1 }])
    expect(existsSync(unused)).toBe(false)
  })

  test('catalog awaits both selected trees and preserves text and binary diff output', async () => {
    const first = barrier(),
      firstReady = barrier(),
      second = barrier(),
      secondReady = barrier()
    const refs: SkillVersionReadReference[] = []
    const reader: SkillVersionContentReader = {
      readSnapshot() {
        throw new Error('diff must not request snapshot content')
      },
      async readTree(reference) {
        refs.push(reference)
        const initial = reference.version === 1
        ;(initial ? first : second).release()
        await (initial ? firstReady : secondReady).pending
        return new Map<string, SkillVersionTreeEntry>([
          ['SKILL.md', { kind: 'text', content: initial ? 'before\n' : 'after\n' }],
          ['asset.bin', { kind: 'binary', hash: initial ? 'old-digest' : 'new-digest' }],
        ])
      },
    }
    const catalog = composeSkillCatalog({
      db: harness.db,
      appHome: join(appHome, 'absent-home'),
      versionReader: reader,
      restoreMembership: { unfuseForRestore: async () => [] },
    })
    let settled = false
    const pending = catalog.versionQueries
      .diff(authority, { id: skill.id, from: '1', to: '2' })
      .then((result) => {
        settled = true
        return result
      })
    try {
      await reached(first, pending)
      expect(refs).toEqual([{ skillId: skill.id, version: 1 }])
      firstReady.release()
      await reached(second, pending)
      expect(settled).toBe(false)
    } finally {
      firstReady.release()
      secondReady.release()
    }
    const result = await pending
    expect(result).toMatchObject({ from: 1, to: 2 })
    expect(result.diff).toContain('-before\n+after')
    expect(result.diff).toContain('Binary files a/asset.bin and b/asset.bin differ')
    expect(refs).toEqual([
      { skillId: skill.id, version: 1 },
      { skillId: skill.id, version: 2 },
    ])
  })

  test('missing metadata rejects before storage and reader failures remain observable', async () => {
    const failure = new Error('history unavailable')
    let reads = 0
    const fail = async () => {
      reads += 1
      throw failure
    }
    const opts = {
      appHome: join(appHome, 'absent-home'),
      versionReader: { readSnapshot: fail, readTree: fail },
    }
    await expect(getSkillVersionContent(harness.db, opts, 'missing', 1)).rejects.toMatchObject({
      code: 'skill-not-found',
    })
    await expect(getSkillVersionContent(harness.db, opts, skill.id, 99)).rejects.toMatchObject({
      code: 'skill-version-not-found',
    })
    await expect(diffSkillVersions(harness.db, opts, skill.id, 1, 99)).rejects.toMatchObject({
      code: 'skill-version-not-found',
    })
    expect(reads).toBe(0)
    await expect(getSkillVersionContent(harness.db, opts, skill.id, 1)).rejects.toBe(failure)
    await expect(diffSkillVersions(harness.db, opts, skill.id, 1, 2)).rejects.toBe(failure)
    expect(reads).toBe(2)
  })

  test('file adapter preserves historical metadata, NUL binary detection and missing snapshot semantics', async () => {
    const root = join(appHome, 'skills', skill.id, 'versions', 'v1', 'files')
    mkdirSync(join(root, 'nested'))
    writeFileSync(join(root, 'nested', 'note.txt'), 'old note')
    const binary = Buffer.from([0, 1, 255])
    writeFileSync(join(root, 'asset.bin'), binary)
    const reader = createFileSkillVersionContentReader(appHome)
    const ref = { skillId: skill.id, version: 1 }
    const snapshot = await reader.readSnapshot(ref)
    expect(snapshot.main).toContain('local first')
    expect(snapshot.files).toContainEqual({ path: 'nested', type: 'dir' })
    expect(snapshot.files.find((node) => node.path === 'nested/note.txt')).toMatchObject({
      type: 'file',
      size: 8,
      modifiedAt: expect.any(Number),
    })
    const tree = await reader.readTree(ref)
    expect(tree.get('nested/note.txt')).toEqual({ kind: 'text', content: 'old note' })
    expect(tree.get('asset.bin')).toEqual({ kind: 'binary', hash: sha256Hex(binary) })
    rmSync(join(root, 'SKILL.md'))
    const absentMain = await getSkillVersionContent(harness.db, { appHome }, skill.id, 1)
    expect(absentMain.content).toEqual({
      name: skill.name,
      description: '',
      bodyMd: '',
      frontmatterExtra: {},
    })
    expect(absentMain.files.some((node) => node.path === 'asset.bin')).toBe(true)
    rmSync(root, { recursive: true })
    expect(await reader.readSnapshot(ref)).toEqual({ main: null, files: [] })
    expect(await reader.readTree(ref)).toEqual(new Map())
    const absent = await getSkillVersionContent(harness.db, { appHome }, skill.id, 1)
    expect(absent.content.bodyMd).toBe('')
    expect(absent.files).toEqual([])
    // Version 2 and live remain present; neither is a fallback for version 1.
    expect(
      (await getSkillVersionContent(harness.db, { appHome }, skill.id, 2)).content.bodyMd,
    ).toContain('local second')
  })
})
