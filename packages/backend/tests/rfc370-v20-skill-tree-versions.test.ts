// RFC-370 §10 V20 — fusion seeds, proposal candidates and fusion versions go
// through Resource Catalog's skill tree operations over the SELECTED skill
// content binding.
//
// Why these tests exist: memory→skill fusion read its seed from
// `appHome/skills/<id>/versions/v<n>/files` and applied a proposal by copying a
// local directory over the skill, so on a hosted deployment (skills kept in
// `skill_content_entries`, no persistent disk) every fusion failed with
// `fusion-skill-unversioned`. The operations below are the only way fusion now
// touches skill bytes; they lock, on both database providers and for both the
// local file store and the database store: the strict version read (no live
// fallback), candidate capture/read/discard, and the journaled stage →
// tx-bound commit (`before` ahead of the composite fence, `after` in the same
// transaction) → publish / abort ladder.
import { afterEach, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import {
  skillContentEntries,
  skillOperationLocks,
  skillOperations,
  skills,
  skillVersions,
} from '@/db/schema'
import type { SkillTreeVersionFile } from '@/modules/resource-catalog/public/participants'
import { composeSkillVersionCommitParticipantFactory } from '@/modules/resource-catalog/composition/skillVersionCommit'
import { selectSkillContentDependencies } from '@/modules/resource-catalog/composition/skillContentBinding'
import { createDatabaseSkillContent } from '@/modules/resource-catalog/infrastructure/databaseSkillContent'
import { createManagedSkill } from '@/modules/resource-catalog/infrastructure/legacy/skill'
import { resetSkillBootVerifyForTest } from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import { restoreSkillVersion } from '@/modules/resource-catalog/infrastructure/legacy/skillVersion'
import { ConflictError } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'

const enc = (text: string) => new TextEncoder().encode(text)
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const roots: string[] = []
afterEach(() => {
  resetSkillBootVerifyForTest()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function file(path: string, content: string | Uint8Array): SkillTreeVersionFile {
  return { path, content: typeof content === 'string' ? enc(content) : content }
}

function byPath(files: readonly SkillTreeVersionFile[] | null): Record<string, string> {
  if (files === null) throw new Error('expected a tree')
  return Object.fromEntries(
    files.map((entry) => [entry.path, Buffer.from(entry.content).toString('hex')]),
  )
}

describeEachProvider('RFC-370 §10 V20 skill tree versions', (harness) => {
  for (const storage of ['file', 'database'] as const) {
    async function fixture() {
      const appHome = mkdtempSync(join(tmpdir(), 'aw-v20-trees-'))
      roots.push(appHome)
      const binding =
        storage === 'database' ? createDatabaseSkillContent({ db: harness.db }) : undefined
      const opts =
        binding === undefined ? { appHome } : selectSkillContentDependencies(binding, appHome)
      const skill = await createManagedSkill(harness.db, opts, {
        name: `v20-${storage}-${ulid().toLowerCase()}`,
        description: 'd',
        bodyMd: 'SNAPSHOT-BODY',
        frontmatterExtra: {},
      })
      const trees = composeSkillVersionCommitParticipantFactory(
        binding === undefined ? {} : { skillContent: binding },
      ).bind({ db: harness.db, appHome })
      return { appHome, opts, skill, trees }
    }
    async function state(skillId: string) {
      const skill = (await harness.db.select().from(skills).where(eq(skills.id, skillId)))[0]!
      const operations = await harness.db
        .select()
        .from(skillOperations)
        .where(eq(skillOperations.skillId, skillId))
      const locks = await harness.db
        .select()
        .from(skillOperationLocks)
        .where(eq(skillOperationLocks.lockedSkillId, skillId))
      return {
        contentVersion: skill.contentVersion,
        activeOperations: operations.filter((row) => row.active === 1).length,
        locks: locks.length,
      }
    }

    test(`${storage}: the version read is strict — exact snapshot bytes, null when absent, never live`, async () => {
      const { appHome, skill, trees } = await fixture()
      const v1 = await trees.readVersionTree({ skillId: skill.id, version: 1 })
      expect(dec(v1!.find((entry) => entry.path === 'SKILL.md')!.content)).toContain(
        'SNAPSHOT-BODY',
      )
      expect(await trees.readVersionTree({ skillId: skill.id, version: 9 })).toBeNull()
      if (storage === 'file') {
        writeFileSync(join(appHome, 'skills', skill.id, 'files', 'SKILL.md'), 'LIVE-TAMPERED')
        expect(byPath(await trees.readVersionTree({ skillId: skill.id, version: 1 }))).toEqual(
          byPath(v1),
        )
        rmSync(join(appHome, 'skills', skill.id, 'versions'), { recursive: true, force: true })
      } else {
        await harness.db
          .delete(skillContentEntries)
          .where(
            and(
              eq(skillContentEntries.skillId, skill.id),
              eq(skillContentEntries.tree, 'version:1'),
            ),
          )
      }
      expect(await trees.readVersionTree({ skillId: skill.id, version: 1 })).toBeNull()
    })

    test(`${storage}: candidates keep exact bytes until discarded`, async () => {
      const { skill, trees } = await fixture()
      const candidateId = ulid()
      const files = [
        file('SKILL.md', '﻿# proposed\n'),
        file('bin/data', new Uint8Array([0, 255, 7])),
      ]
      await trees.captureCandidate({ skillId: skill.id, candidateId, files })
      expect(byPath(await trees.readCandidate({ skillId: skill.id, candidateId }))).toEqual(
        byPath(files),
      )
      await trees.discardCandidate({ skillId: skill.id, candidateId })
      expect(await trees.readCandidate({ skillId: skill.id, candidateId })).toBeNull()
      await expect(
        trees.captureCandidate({ skillId: skill.id, candidateId: '../escape', files }),
      ).rejects.toMatchObject({ code: 'skill-candidate-invalid' })
    })

    test(`${storage}: stage → before → fence → rows → after → publish closes the journaled operation`, async () => {
      const { skill, trees } = await fixture()
      const proposal = [
        file('SKILL.md', '# fused\n'),
        file('assets/logo.bin', new Uint8Array([1, 2, 3])),
      ]
      const staged = await trees.stage({
        skillId: skill.id,
        source: { kind: 'tree', files: proposal },
        versionSource: 'fusion',
        summary: 'fused',
        fusionId: null,
        authorUserId: '__system__',
        now: 10,
        expectedSkillId: skill.id,
        expectedVersion: 1,
      })
      expect(await state(skill.id)).toMatchObject({
        contentVersion: 1,
        activeOperations: 1,
        locks: 1,
      })
      const order: string[] = []
      const version = await harness.session.transaction(
        async (tx) =>
          await trees.inTransaction(tx).commit(staged, {
            before: () => {
              order.push('before')
            },
            after: (index) => {
              order.push(`after:${index}`)
            },
          }),
      )
      expect(version).toBe(2)
      expect(order).toEqual(['before', 'after:2'])
      await trees.publish(staged)
      expect(await state(skill.id)).toEqual({ contentVersion: 2, activeOperations: 0, locks: 0 })
      const row = (
        await harness.db
          .select()
          .from(skillVersions)
          .where(and(eq(skillVersions.skillId, skill.id), eq(skillVersions.versionIndex, 2)))
      )[0]!
      expect(row).toMatchObject({ source: 'fusion', summary: 'fused' })
      expect(byPath(await trees.readVersionTree({ skillId: skill.id, version: 2 }))).toEqual(
        byPath(proposal),
      )
    })

    test(`${storage}: the caller's before check answers first; a drifted skill hits the caller's stale message`, async () => {
      const { skill, trees } = await fixture()
      const stale = (expectedVersion: number) =>
        trees.stage({
          skillId: skill.id,
          source: { kind: 'tree', files: [file('SKILL.md', '# x\n')] },
          versionSource: 'fusion',
          summary: null,
          fusionId: null,
          authorUserId: '__system__',
          now: 11,
          expectedSkillId: skill.id,
          expectedVersion,
          staleMessage: 'fusion target skill changed; reload and retry',
        })
      const first = await stale(7)
      await expect(
        harness.session.transaction(
          async (tx) =>
            await trees.inTransaction(tx).commit(first, {
              before: () => {
                throw new ConflictError('fusion-not-applying', 'checked first')
              },
            }),
        ),
      ).rejects.toMatchObject({ code: 'fusion-not-applying' })
      await trees.abort(first)
      const second = await stale(7)
      await expect(
        harness.session.transaction(async (tx) => await trees.inTransaction(tx).commit(second, {})),
      ).rejects.toMatchObject({
        code: 'resource-operation-stale',
        message: 'fusion target skill changed; reload and retry',
      })
      await trees.abort(second)
      expect(await state(skill.id)).toEqual({ contentVersion: 1, activeOperations: 0, locks: 0 })
    })

    // 2026-10-19 hosted acceptance: approving a fusion whose SKILL.md declared a
    // new description left `skills.description` (what skill lists and pickers
    // show) at the old text; restoring an earlier version did the same.
    test(`${storage}: the current SKILL.md's description is the skill's — after a fused tree (BOM too) and after a restore`, async () => {
      const { opts, skill, trees } = await fixture()
      const fuse = async (main: string, now: number) => {
        const staged = await trees.stage({
          skillId: skill.id,
          source: { kind: 'tree', files: [file('SKILL.md', main)] },
          versionSource: 'fusion',
          summary: null,
          fusionId: null,
          authorUserId: '__system__',
          now,
        })
        await harness.session.transaction(
          async (tx) => await trees.inTransaction(tx).commit(staged),
        )
        await trees.publish(staged)
      }
      const description = async () =>
        (await harness.db.select().from(skills).where(eq(skills.id, skill.id)))[0]!.description
      const restore = (version: number) =>
        restoreSkillVersion(harness.db, opts, skill.id, version, null, {
          unfuseForRestore: async () => [],
        })
      await fuse(`\uFEFF---\nname: ${skill.name}\ndescription: fused guidance\n---\n# body\n`, 20)
      expect(await description()).toBe('fused guidance')
      await fuse('# no frontmatter\n', 21)
      expect(await description()).toBe('')
      await restore(2)
      expect(await description()).toBe('fused guidance')
      await restore(1)
      expect(await description()).toBe('d')
    })

    test(`${storage}: a candidate stages directly; a tree without SKILL.md is refused before any operation`, async () => {
      const { skill, trees } = await fixture()
      const candidateId = ulid()
      const files = [file('SKILL.md', '# from candidate\n'), file('notes/a.md', 'A')]
      await trees.captureCandidate({ skillId: skill.id, candidateId, files })
      const staged = await trees.stage({
        skillId: skill.id,
        source: { kind: 'candidate', candidateId },
        versionSource: 'fusion',
        summary: null,
        fusionId: null,
        authorUserId: '__system__',
        now: 12,
      })
      await harness.session.transaction(async (tx) => await trees.inTransaction(tx).commit(staged))
      await trees.publish(staged)
      expect(byPath(await trees.readVersionTree({ skillId: skill.id, version: 2 }))).toEqual(
        byPath(files),
      )
      await expect(
        trees.stage({
          skillId: skill.id,
          source: { kind: 'tree', files: [file('README.md', 'no main')] },
          versionSource: 'fusion',
          summary: null,
          fusionId: null,
          authorUserId: '__system__',
          now: 13,
        }),
      ).rejects.toMatchObject({ code: 'skill-tree-main-missing' })
      await expect(
        trees.stage({
          skillId: skill.id,
          source: { kind: 'candidate', candidateId: ulid() },
          versionSource: 'fusion',
          summary: null,
          fusionId: null,
          authorUserId: '__system__',
          now: 14,
        }),
      ).rejects.toMatchObject({ code: 'skill-candidate-not-found' })
      expect(await state(skill.id)).toEqual({ contentVersion: 2, activeOperations: 0, locks: 0 })
    })
  }
})
