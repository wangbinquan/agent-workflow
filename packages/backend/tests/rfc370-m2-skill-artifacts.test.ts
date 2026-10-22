import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { buildActor } from '@/auth/actor'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import { createDatabaseSkillArtifactOwners } from '@/modules/resource-catalog/infrastructure/crewstation/skillArtifacts'
import { createDatabaseSkillContent } from '@/modules/resource-catalog/infrastructure/databaseSkillContent'
import { getSkillById } from '@/modules/resource-catalog/infrastructure/legacy/skill'
import {
  readTree,
  LIVE_TREE,
  versionTree,
  stagingTree,
} from '@/modules/resource-catalog/infrastructure/databaseSkillTrees'
import type { ResourcePackageArtifactContext } from '@/modules/resource-catalog/application/package/artifactOwners'
import { describeEachProvider } from './helpers/eachProvider'
import { admitTestDirectAuthority } from './helpers/identityAccessAuthority'

describeEachProvider('RFC-370 durable skill artifacts', (harness) => {
  const identity = async () => {
    const actor = buildActor({
      user: {
        id: 'owner',
        username: 'owner',
        displayName: 'owner',
        role: 'admin',
        status: 'active',
      },
      source: 'session',
    })
    const { users } = tablesOf(harness.db)
    await insertOne(harness.db, users, { ...actor.user, createdAt: 1, updatedAt: 1 })
    const registry = composeIdentityAccess(harness.db)
    const admitted = await admitTestDirectAuthority(registry.directAuthority, {
      userId: 'owner',
      source: 'session',
    })
    if (!admitted) throw new Error('fixture owner was not admitted')
    return {
      actor: admitted.actor,
      authority: admitted.actor,
      requestAuthority: admitted.authority,
    }
  }
  const saveVersion = async (
    skillId: string,
    version: number,
    publication: { managedPath: string; filesPath: string; contentHash: string | null },
  ) => {
    await databaseSessionFor(harness.db).transaction(async (tx) => {
      const { skills, skillVersions } = tablesOf(tx)
      if (version === 1)
        await insertOne(tx, skills, {
          id: skillId,
          name: 'skill',
          managedPath: publication.managedPath,
          contentVersion: 1,
          versionState: 'snapshot-authoritative',
          ownerUserId: 'owner',
        })
      else await tx.update(skills).set({ contentVersion: version }).where(eq(skills.id, skillId))
      await insertOne(tx, skillVersions, {
        id: ulid(),
        skillId,
        versionIndex: version,
        filesPath: publication.filesPath,
        contentHash: publication.contentHash,
        source: 'import',
        summary: 'fixture commit',
      })
    })
  }

  test('Intent stage is invisible before metadata commit; cold publication preserves prior files and immutable versions', async () => {
    const { authority } = await identity()
    const skillId = ulid(),
      operationId = ulid()
    const owner = createDatabaseSkillArtifactOwners(harness.db)
    const plan = await owner.intent.planCreate({
      authority,
      skillId,
      operationId,
      payload: {
        name: 'skill',
        description: '',
        bodyMd: 'version one',
        files: [{ path: 'scripts/check.txt', content: 'retained helper' }],
      },
    })
    expect(await readTree(harness.db, skillId, stagingTree(operationId))).toHaveLength(0)
    const publication = await plan.stage()
    expect(await readTree(harness.db, skillId, LIVE_TREE)).toHaveLength(0)
    await expect(plan.complete()).rejects.toThrow('metadata-mismatch')
    await databaseSessionFor(harness.db).transaction(async (tx) =>
      publication.commitInTransaction(tx, 1),
    )
    await saveVersion(skillId, 1, publication)
    await createDatabaseSkillArtifactOwners(harness.db).recovery.publish({
      skillId,
      operationId,
      version: 1,
    })
    const content = createDatabaseSkillContent({ db: harness.db })
    expect(
      await content.content.readMain({ id: skillId, name: 'skill', contentVersion: 1 }),
    ).toContain('version one')
    const current = (await getSkillById(harness.db, skillId))!
    const updateId = ulid()
    const update = await owner.intent.planUpdate({
      authority,
      current,
      operationId: updateId,
      payload: { name: 'skill', description: '', bodyMd: 'version two', files: [] },
    })
    const next = await update.stage()
    await saveVersion(skillId, 2, next)
    await update.complete()
    await plan.complete() // An old replay must never replace a newer live tree.
    expect(
      await content.content.readMain({ id: skillId, name: 'skill', contentVersion: 2 }),
    ).toContain('version two')
    expect(
      await content.content.readFile(
        { id: skillId, name: 'skill', contentVersion: 2 },
        'scripts/check.txt',
      ),
    ).toBe('retained helper')
    expect(
      Buffer.from(
        (await readTree(harness.db, skillId, LIVE_TREE)).find((file) => file.path === 'SKILL.md')!
          .bytes,
      ).toString(),
    ).toContain('version two')
    expect(
      Buffer.from(
        (await readTree(harness.db, skillId, versionTree(1))).find(
          (file) => file.path === 'SKILL.md',
        )!.bytes,
      ).toString(),
    ).toContain('version one')
  })

  test('package stage preserves binary bytes, verifies publication receipt and recovers without a process plan', async () => {
    const { actor, requestAuthority } = await identity()
    const skillId = ulid(),
      opId = ulid()
    const context: ResourcePackageArtifactContext = {
      actor,
      authority: requestAuthority,
      humanMemberMappings: [],
      secretInputs: [],
      readSkillFile: () => new Uint8Array([0, 255, 7]),
      ids: { mintCreate: () => skillId, findCreate: () => skillId, listPending: () => [] },
    }
    const owner = createDatabaseSkillArtifactOwners(harness.db)
    const mutation = {
      kind: 'skill-create' as const,
      opId,
      slug: 'skill',
      payload: {
        name: 'packaged',
        description: '',
        bodyMd: 'package content',
        frontmatterExtra: {},
        files: [{ path: 'data.bin', ref: 'file1' }],
      },
    }
    const plan = owner.packages.planCreate(context, { mutation, skillId })
    const publication = await plan.stage()
    await saveVersion(skillId, 1, publication)
    const cold = createDatabaseSkillArtifactOwners(harness.db)
    await expect(
      cold.packages.rollForward(context, {
        artifact: plan.artifact,
        receipt: { journalId: 'journal', applied: [] },
      }),
    ).rejects.toThrow('receipt-missing')
    await cold.packages.rollForward(context, {
      artifact: plan.artifact,
      receipt: {
        journalId: 'journal',
        applied: [
          {
            operationId: opId,
            resourceId: skillId,
            resourceType: 'skill',
            action: 'create',
            name: 'packaged',
          },
        ],
      },
    })
    expect(
      (await readTree(harness.db, skillId, versionTree(1))).find(
        (file) => file.path === 'data.bin',
      )!.bytes,
    ).toEqual(new Uint8Array([0, 255, 7]))
    await cold.packages.compensate(context, { artifact: plan.artifact, databaseCommitted: false })
    expect(await readTree(harness.db, skillId, LIVE_TREE)).toHaveLength(2)
  })

  test('compensation drops only its staged tree and refuses changed bytes under one operation', async () => {
    const { authority } = await identity()
    const owner = createDatabaseSkillArtifactOwners(harness.db)
    const request = {
      authority,
      skillId: ulid(),
      operationId: ulid(),
      payload: { name: 'skill', description: '', bodyMd: 'first', files: [] },
    }
    const first = await owner.intent.planCreate(request)
    await first.stage()
    const changed = await owner.intent.planCreate({
      ...request,
      payload: { ...request.payload, bodyMd: 'changed' },
    })
    await expect(changed.stage()).rejects.toThrow('hash-mismatch')
    await first.compensate()
    expect(
      await readTree(harness.db, request.skillId, stagingTree(request.operationId)),
    ).toHaveLength(0)
    const { skills } = tablesOf(harness.db)
    expect(await harness.db.select().from(skills)).toHaveLength(0)
  })
})
