// RFC-370: selected content must drive real Intent apply and recovery without
// replacing AW's resource transaction, durable journal or old-format replay.
import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { canonicalIntentJson, parseIntentChangeset } from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import {
  intentApplyJournal,
  intentDrafts,
  intentSessions,
  intentTurns,
  plugins,
  skills,
  skillVersions,
  users,
} from '@/db/schema'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import type { IntentApplyInput } from '@/modules/intent/application/ports/intentApplyOperations'
import type { IntentArtifactContentPort } from '@/modules/intent/application/ports/intentArtifactContent'
import { INTENT_APPLY_COMMITTED_ROLL_FORWARD_RETRYABLE } from '@/modules/intent/application/journalConvergence'
import {
  composeIntentApplyArtifactLifecycle,
  composeIntentApplyOperations,
} from '@/modules/intent/composition/apply'
import { composeIntentApplyConvergence } from '@/modules/intent/composition/applyMaintenance'
import { composeIntentMaintenanceCommandsForDatabase } from '@/modules/intent/composition/maintenance'
import {
  encodeIntentJournalArtifacts,
  type IntentJournalArtifactV1,
} from '@/modules/intent/domain/journalArtifacts'
import type { IntentApplyArtifact } from '@/modules/resource-catalog/public/types'
import type {
  IntentPluginArtifactOwner,
  IntentSkillArtifactOwner,
} from '@/modules/resource-catalog/public/participants'
import type { IntentArtifactStage } from '@/modules/resource-catalog/application/intent/artifactOwners'
import { encodeSkillToken } from '@/modules/resource-catalog/application/skills/skillToken'
import { createLogger } from '@/util/log'
import { describeEachProvider } from './helpers/eachProvider'

const ownerId = 'intent-storage-owner'
const hash = 'a'.repeat(64)
const actor = buildActor({
  user: { id: ownerId, username: ownerId, displayName: ownerId, role: 'admin', status: 'active' },
  source: 'session',
})
const log = createLogger('rfc370-intent-storage')
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function barrier() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return { pending, release }
}

describeEachProvider('RFC-370 selected Intent artifact content', (harness) => {
  async function fixture(kind: 'skill' | 'plugin', update = false) {
    const directory = mkdtempSync(join(tmpdir(), 'aw-intent-content-'))
    directories.push(directory)
    const appHome = join(directory, 'absent-home')
    await harness.db.insert(users).values({ ...actor.user, createdAt: 1, updatedAt: 1 })
    const authority = composeIdentityAccess(harness.db).contexts.fromAuthenticatedPrincipal(
      { userId: ownerId, source: 'session' },
      'http',
    ).authority
    const sessionId = ulid(),
      draftId = ulid(),
      existingSkillId = ulid()
    if (update) {
      await harness.db.insert(skills).values({
        id: existingSkillId,
        name: 'intent-storage',
        description: '',
        managedPath: 'object-ref:skill-live',
        ownerUserId: ownerId,
        visibility: 'private',
        reservationState: 'ready',
        versionState: 'snapshot-authoritative',
        contentVersion: 1,
        metaRevision: 0,
        createdAt: 1,
        updatedAt: 1,
      })
      await harness.db.insert(skillVersions).values({
        id: ulid(),
        skillId: existingSkillId,
        versionIndex: 1,
        filesPath: 'object-ref:skill-v1',
        source: 'initial',
        summary: 'Initial',
        contentHash: hash,
        createdAt: 1,
      })
    }
    await harness.db.insert(intentSessions).values({
      id: sessionId,
      ownerUserId: ownerId,
      title: 'Selected storage',
      contextManifestJson: update
        ? JSON.stringify([
            {
              handle: 'res#skill#1',
              resourceType: 'skill',
              resourceId: existingSkillId,
              root: true,
              detail: true,
              fence: {
                kind: 'skill',
                token: encodeSkillToken({
                  skillId: existingSkillId,
                  contentVersion: 1,
                  metaRevision: 0,
                }),
              },
            },
          ])
        : '[]',
      createdAt: 1,
      updatedAt: 1,
    })
    const parsed = parseIntentChangeset(
      JSON.stringify({
        $schema_version: 1,
        ops: [
          {
            opId: 'op-1',
            action: update ? 'update' : 'create',
            resourceType: kind,
            ...(update ? { target: 'res#skill#1' } : { tempRef: `$new:${kind}` }),
            payload:
              kind === 'skill'
                ? {
                    name: 'intent-storage',
                    description: '',
                    frontmatterExtra: { license: 'MIT' },
                    bodyMd: '存储正文',
                    files: [{ path: 'notes.txt', content: '完整内容\n' }],
                  }
                : {
                    name: 'intent-storage',
                    description: '',
                    spec: 'intent-storage@1.0.0',
                    optionsJson: {},
                    enabled: true,
                  },
          },
        ],
      }),
    )
    if (!parsed.ok) throw new Error(parsed.errors.join('; '))
    const canonical = canonicalIntentJson(parsed.changeset)
    const draftHash = `sha256:${createHash('sha256').update(canonical).digest('hex')}`
    await harness.db.insert(intentDrafts).values({
      id: draftId,
      sessionId,
      revision: 1,
      changesetJson: canonical,
      validationJson: '{"errors":[],"credentialFindings":[]}',
      draftHash,
      contextRevision: 0,
      createdAt: 1,
    })
    await harness.db
      .update(intentSessions)
      .set({ currentDraftId: draftId })
      .where(eq(intentSessions.id, sessionId))
    const command: IntentApplyInput = {
      sessionId,
      clientMutationId: ulid(),
      draftRevision: 1,
      draftHash,
      decisions: [],
    }
    const journal = async () => {
      const row = await harness.db
        .select()
        .from(intentApplyJournal)
        .where(eq(intentApplyJournal.sessionId, sessionId))
        .get()
      if (row === undefined) throw new Error('Intent journal not created')
      return row
    }
    return { appHome, sessionId, existingSkillId, journal, request: { actor, authority, command } }
  }

  function owners(effects: {
    stage(artifact: IntentApplyArtifact): Promise<void>
    compensate(): Promise<void>
    rollForward(): Promise<void>
    complete(): Promise<void>
  }): { skill: IntentSkillArtifactOwner; plugin: IntentPluginArtifactOwner } {
    function stage<TResult>(
      artifact: IntentApplyArtifact,
      result: TResult,
    ): IntentArtifactStage<TResult> {
      return {
        artifact,
        async stage() {
          await effects.stage(artifact)
          return result
        },
        compensate: effects.compensate,
        rollForward: effects.rollForward,
        complete: effects.complete,
      }
    }
    const skillStage = (skillId: string, operationId: string, version: number) =>
      stage(
        version === 1
          ? {
              kind: 'skill-stage',
              skillId,
              operationId,
              stagingDirectory: 'object-ref:skill-stage',
            }
          : {
              kind: 'skill-version-stage',
              skillId,
              operationId,
              version,
              stagingDirectory: 'object-ref:skill-stage',
              versionDirectory: `object-ref:skill-v${version}`,
            },
        {
          managedPath: 'object-ref:skill-live',
          filesPath: `object-ref:skill-v${version}`,
          contentHash: hash,
          async commitInTransaction(_transaction: unknown, versionIndex: number) {
            expect(versionIndex).toBe(version)
          },
        },
      )
    return {
      skill: {
        async planCreate(request) {
          expect(request.payload.bodyMd).toBe('存储正文')
          expect(request.payload.files).toEqual([{ path: 'notes.txt', content: '完整内容\n' }])
          return skillStage(request.skillId, request.operationId, 1)
        },
        async planUpdate(request) {
          expect(request.current.contentVersion).toBe(1)
          return skillStage(request.current.id, request.operationId, 2)
        },
      },
      plugin: {
        async planInstall(request) {
          expect(request.spec).toBe('intent-storage@1.0.0')
          return stage(
            {
              kind: 'plugin-install',
              pluginId: request.pluginId,
              generationId: request.operationId,
              generationDir: 'object-ref:plugin-generation',
            },
            {
              sourceKind: 'npm' as const,
              cachedPath: 'object-ref:plugin-content',
              resolvedVersion: '1.0.0',
            },
          )
        },
      },
    }
  }

  function content(overrides: Partial<IntentArtifactContentPort> = {}): IntentArtifactContentPort {
    return {
      pluginExists: async () => true,
      discardPlugin: async () => {},
      publishSkill: async () => {},
      discardSkill: async () => {},
      discardLegacy: async () => {},
      ...overrides,
    }
  }

  for (const kind of ['skill', 'plugin'] as const) {
    test(`${kind} real apply records before stage and waits for owner publication, content and completion`, async () => {
      const f = await fixture(kind)
      const entered = barrier(),
        stage = barrier(),
        published = barrier(),
        publish = barrier(),
        stored = barrier(),
        store = barrier(),
        completed = barrier(),
        complete = barrier()
      const calls: string[] = []
      let settled = false
      const selected = owners({
        async stage(artifact) {
          const row = await f.journal()
          expect(row.state).toBe('prepared')
          expect(JSON.parse(row.preparedArtifactsJson)).toEqual([artifact])
          calls.push('stage')
          entered.release()
          await stage.pending
        },
        async compensate() {
          throw new Error('successful apply must not compensate')
        },
        async rollForward() {
          expect((await f.journal()).state).toBe('committed')
          calls.push('owner-publish')
          published.release()
          await publish.pending
        },
        async complete() {
          calls.push('complete')
          completed.release()
          await complete.pending
        },
      })
      const observedStorage = async () => {
        expect((await f.journal()).state).toBe('committed')
        calls.push('content')
        stored.release()
        await store.pending
      }
      const artifactContent = content({
        async publishSkill(publication) {
          expect(publication).toMatchObject({
            version: 1,
            disposition: 'current',
            managedPath: 'object-ref:skill-live',
            filesPath: 'object-ref:skill-v1',
            contentHash: hash,
          })
          await observedStorage()
        },
        async pluginExists(reference) {
          expect(reference).toBe('object-ref:plugin-content')
          await observedStorage()
          return true
        },
      })
      const operations = composeIntentApplyOperations({
        db: harness.db,
        appHome: f.appHome,
        skillArtifacts: selected.skill,
        pluginArtifacts: selected.plugin,
        artifactContent,
      })
      const pending = operations.apply(f.request).then((receipt) => {
        settled = true
        return receipt
      })
      try {
        await Promise.race([
          entered.pending,
          pending.then(() => {
            throw new Error('stage not reached')
          }),
        ])
        expect(await harness.db.select().from(kind === 'skill' ? skills : plugins)).toHaveLength(0)
        expect(settled).toBe(false)
        stage.release()
        await Promise.race([
          published.pending,
          pending.then(() => {
            throw new Error('owner publication not reached')
          }),
        ])
        expect(await harness.db.select().from(kind === 'skill' ? skills : plugins)).toHaveLength(1)
        expect(settled).toBe(false)
        publish.release()
        await Promise.race([
          stored.pending,
          pending.then(() => {
            throw new Error('content publication not reached')
          }),
        ])
        expect(settled).toBe(false)
        store.release()
        await Promise.race([
          completed.pending,
          pending.then(() => {
            throw new Error('completion not reached')
          }),
        ])
        expect(settled).toBe(false)
        complete.release()
        const receipt = await pending
        expect(receipt.applied).toHaveLength(1)
        expect(calls).toEqual(['stage', 'owner-publish', 'content', 'complete'])
        expect(await operations.apply(f.request)).toEqual(receipt)
        expect(calls).toEqual(['stage', 'owner-publish', 'content', 'complete'])
        expect(existsSync(f.appHome)).toBe(false)
      } finally {
        stage.release()
        publish.release()
        store.release()
        complete.release()
        await pending.catch(() => {})
      }
    })
  }

  test('skill update keeps the original metadata/version machine while publishing selected version references', async () => {
    const f = await fixture('skill', true)
    const selected = owners({
      async stage() {},
      async compensate() {},
      async rollForward() {},
      async complete() {},
    })
    const publications: unknown[] = []
    const operations = composeIntentApplyOperations({
      db: harness.db,
      appHome: f.appHome,
      skillArtifacts: selected.skill,
      artifactContent: content({
        async publishSkill(value) {
          publications.push(value)
        },
      }),
    })
    const receipt = await operations.apply(f.request)
    expect(receipt.applied).toMatchObject([{ resourceId: f.existingSkillId, action: 'update' }])
    expect(
      await harness.db
        .select({
          managedPath: skills.managedPath,
          contentVersion: skills.contentVersion,
          metaRevision: skills.metaRevision,
        })
        .from(skills),
    ).toEqual([{ managedPath: 'object-ref:skill-live', contentVersion: 2, metaRevision: 0 }])
    expect(
      await harness.db
        .select({ filesPath: skillVersions.filesPath, contentHash: skillVersions.contentHash })
        .from(skillVersions)
        .where(eq(skillVersions.versionIndex, 2)),
    ).toEqual([{ filesPath: 'object-ref:skill-v2', contentHash: hash }])
    expect(publications).toMatchObject([
      { version: 2, disposition: 'current', filesPath: 'object-ref:skill-v2' },
    ])
    expect(existsSync(f.appHome)).toBe(false)
  })

  test('failed stage waits for both owner and durable-content compensation before settling the journal', async () => {
    const f = await fixture('skill'),
      ownerEntered = barrier(),
      ownerRelease = barrier(),
      contentEntered = barrier(),
      contentRelease = barrier()
    const error = new Error('storage stage unavailable')
    const selected = owners({
      async stage() {
        throw error
      },
      async compensate() {
        ownerEntered.release()
        await ownerRelease.pending
      },
      async rollForward() {
        throw new Error('failed stage must not publish')
      },
      async complete() {
        throw new Error('failed stage must not complete')
      },
    })
    const operations = composeIntentApplyOperations({
      db: harness.db,
      appHome: f.appHome,
      skillArtifacts: selected.skill,
      artifactContent: content({
        async discardSkill(request) {
          expect(request.version).toBe(1)
          contentEntered.release()
          await contentRelease.pending
        },
      }),
    })
    let settled = false
    const pending = operations.apply(f.request).then(
      () => {
        settled = true
        return null
      },
      (failure: unknown) => {
        settled = true
        return failure
      },
    )
    try {
      await Promise.race([
        ownerEntered.pending,
        pending.then(() => {
          throw new Error('owner compensation not reached')
        }),
      ])
      expect(settled).toBe(false)
      expect((await f.journal()).state).toBe('prepared')
      ownerRelease.release()
      await Promise.race([
        contentEntered.pending,
        pending.then(() => {
          throw new Error('content compensation not reached')
        }),
      ])
      expect(settled).toBe(false)
      expect((await f.journal()).state).toBe('prepared')
      contentRelease.release()
      expect(await pending).toBe(error)
      expect((await f.journal()).state).toBe('failed')
      expect(await harness.db.select().from(skills)).toHaveLength(0)
      expect(existsSync(f.appHome)).toBe(false)
    } finally {
      ownerRelease.release()
      contentRelease.release()
      await pending
    }
  })

  test('post-commit content failure retains the receipt and is retried through the actual recovery composition', async () => {
    const f = await fixture('skill'),
      recovering = barrier(),
      release = barrier()
    let unavailable = true,
      publications = 0
    const selected = owners({
      async stage() {},
      async compensate() {
        throw new Error('committed content must not compensate')
      },
      async rollForward() {},
      async complete() {},
    })
    const artifactContent = content({
      async publishSkill() {
        publications++
        if (unavailable) throw new Error('objects offline')
        recovering.release()
        await release.pending
      },
    })
    const operations = composeIntentApplyOperations({
      db: harness.db,
      appHome: f.appHome,
      skillArtifacts: selected.skill,
      artifactContent,
    })
    const receipt = await operations.apply(f.request)
    const before = await f.journal()
    expect(before).toMatchObject({
      state: 'committed',
      receiptJson: JSON.stringify(receipt),
      error: INTENT_APPLY_COMMITTED_ROLL_FORWARD_RETRYABLE,
    })
    unavailable = false
    const recovery = composeIntentApplyConvergence({
      db: harness.db,
      appHome: f.appHome,
      pluginsDir: join(f.appHome, 'plugins'),
      content: artifactContent,
    })
    let settled = false
    const pending = recovery.converge({ activeJournalIds: [] }).then((result) => {
      settled = true
      return result
    })
    try {
      await Promise.race([
        recovering.pending,
        pending.then(() => {
          throw new Error('recovery content not reached')
        }),
      ])
      expect(settled).toBe(false)
      expect(await f.journal()).toEqual(before)
      release.release()
      expect(await pending).toEqual({ failed: 0, rolledForward: 1 })
      expect(await f.journal()).toMatchObject({
        state: 'committed',
        receiptJson: before.receiptJson,
        preparedArtifactsJson: before.preparedArtifactsJson,
        error: null,
      })
      expect(publications).toBe(2)
      expect(await harness.db.select().from(skills)).toHaveLength(1)
      expect(existsSync(f.appHome)).toBe(false)
    } finally {
      release.release()
      await pending.catch(() => {})
    }
  })

  test('AW requires committed skill facts and selects superseded cleanup before invoking storage', async () => {
    const f = await fixture('skill', true)
    const artifact: IntentApplyArtifact = {
      kind: 'skill-stage',
      skillId: f.existingSkillId,
      operationId: 'operation',
      stagingDirectory: 'object-ref:stage',
    }
    const publications: unknown[] = []
    const lifecycle = composeIntentApplyArtifactLifecycle({
      db: harness.db,
      appHome: f.appHome,
      content: content({
        async publishSkill(value) {
          publications.push(value)
        },
      }),
    })
    await harness.db.delete(skillVersions)
    expect(await lifecycle.rollForward([artifact], log)).toBe(false)
    expect(publications).toEqual([])
    await harness.db.insert(skillVersions).values({
      id: ulid(),
      skillId: f.existingSkillId,
      versionIndex: 1,
      filesPath: 'object-ref:archive',
      source: 'initial',
      contentHash: hash,
      createdAt: 1,
    })
    await harness.db
      .update(skills)
      .set({ contentVersion: 3 })
      .where(eq(skills.id, f.existingSkillId))
    expect(await lifecycle.rollForward([artifact], log)).toBe(true)
    expect(publications).toMatchObject([
      {
        artifact,
        version: 1,
        disposition: 'superseded',
        filesPath: 'object-ref:archive',
        managedPath: 'object-ref:skill-live',
        contentHash: hash,
      },
    ])
    expect(existsSync(f.appHome)).toBe(false)
  })

  test('selected legacy publication preserves whole-batch unmarking and waits before advancing each journal', async () => {
    const f = await fixture('skill'),
      entered = barrier(),
      release = barrier()
    const artifacts: IntentJournalArtifactV1[] = ['first', 'second'].map((skillId) => ({
      kind: 'skill-version-stage',
      staged: {
        skillId,
        skillName: skillId,
        opId: null,
        publishId: `${skillId}-publish`,
        newVersion: 2,
        newHash: hash,
        filesDir: `object-ref:${skillId}-live`,
        versionDir: `object-ref:${skillId}-v2`,
        stagingDir: `object-ref:${skillId}-stage`,
        noop: null,
      },
    }))
    await harness.db.insert(intentApplyJournal).values({
      id: 'legacy-committed',
      sessionId: f.sessionId,
      clientMutationId: 'legacy-committed',
      draftId: 'draft',
      draftHash: 'hash',
      state: 'committed',
      preparedArtifactsJson: encodeIntentJournalArtifacts(artifacts),
      createdAt: 1,
      updatedAt: 1,
      error: 'retryable',
    })
    const calls: string[] = []
    const recovery = composeIntentApplyConvergence({
      db: harness.db,
      appHome: f.appHome,
      pluginsDir: join(f.appHome, 'plugins'),
      content: content({
        async publishSkill() {
          throw new Error('legacy publication must use the selected compatibility owner')
        },
      }),
      legacySkillArtifacts: {
        unmarkSkillBootVerified(skillId) {
          calls.push(`unmark:${skillId}`)
        },
        async publishStagedSkillVersion(db, options, value) {
          expect(db).toBe(harness.db)
          expect(options).toEqual({ appHome: f.appHome })
          const artifact =
            artifacts.find(
              (entry) => entry.kind === 'skill-version-stage' && entry.staged === value,
            ) ??
            artifacts.find(
              (entry) =>
                entry.kind === 'skill-version-stage' &&
                JSON.stringify(entry.staged) === JSON.stringify(value),
            )
          if (artifact?.kind !== 'skill-version-stage') throw new Error('unknown staged artifact')
          calls.push(`publish:${artifact.staged.skillId}`)
          if (artifact.staged.skillId === 'first') {
            entered.release()
            await release.pending
          }
        },
        async loadSkillOperationState() {
          throw new Error('null operation id must not query operation state')
        },
        async finishOperation() {
          throw new Error('version-only replay must not finish create operations')
        },
      },
    })
    let settled = false
    const pending = recovery.converge({ activeJournalIds: [] }).then((result) => {
      settled = true
      return result
    })
    try {
      await Promise.race([
        entered.pending,
        pending.then(() => {
          throw new Error('legacy publication not reached')
        }),
      ])
      expect(settled).toBe(false)
      expect(calls).toEqual(['unmark:first', 'unmark:second', 'publish:first'])
      expect((await harness.db.select().from(intentApplyJournal).get())?.error).toBe('retryable')
      release.release()
      expect(await pending).toEqual({ failed: 0, rolledForward: 1 })
      expect(calls).toEqual(['unmark:first', 'unmark:second', 'publish:first', 'publish:second'])
      expect((await harness.db.select().from(intentApplyJournal).get())?.error).toBeNull()
      expect(existsSync(f.appHome)).toBe(false)
    } finally {
      release.release()
      await pending.catch(() => {})
    }
  })

  test('boot maintenance forwards selected recovery and waits for native/legacy cleanup without touching active journals', async () => {
    const f = await fixture('skill'),
      entered = barrier(),
      release = barrier()
    const native: IntentApplyArtifact = {
      kind: 'skill-stage',
      skillId: 'native',
      operationId: 'native-op',
      stagingDirectory: 'object-ref:native-stage',
    }
    const legacy = {
      kind: 'skill-stage' as const,
      skillId: 'legacy',
      opId: 'legacy-op',
      skillDir: 'object-ref:legacy-stage',
    }
    for (const [id, preparedArtifactsJson] of [
      ['native', JSON.stringify([native])],
      ['legacy', encodeIntentJournalArtifacts([legacy])],
      ['active', JSON.stringify([native])],
    ] as const) {
      await harness.db.insert(intentApplyJournal).values({
        id,
        sessionId: f.sessionId,
        clientMutationId: id,
        draftId: 'draft',
        draftHash: 'hash',
        state: 'prepared',
        preparedArtifactsJson,
        createdAt: 1,
        updatedAt: 1,
      })
    }
    const calls: string[] = []
    const cleanup = async (id: string) => {
      calls.push(id)
      entered.release()
      await release.pending
    }
    const maintenance = composeIntentMaintenanceCommandsForDatabase({
      db: harness.db,
      appHome: f.appHome,
      pluginsDir: join(f.appHome, 'plugins'),
      scratchDirectoryName: 'scratch',
      resourcePackages: {
        async converge() {
          return { failed: 0, rolledForward: 0 }
        },
      },
      content: content({
        async discardSkill(value) {
          expect(value.artifact).toEqual(native)
          await cleanup('native')
        },
        async discardLegacy(value) {
          expect(value).toEqual(legacy)
          await cleanup('legacy')
        },
      }),
    })
    let settled = false
    const pending = maintenance.recovery
      .recover({
        recoverTurnIds: [],
        activeIntentApplyJournalIds: ['active'],
        activeBundleApplyIds: [],
      })
      .then((result) => {
        settled = true
        return result
      })
    try {
      await Promise.race([
        entered.pending,
        pending.then(() => {
          throw new Error('selected boot cleanup not reached')
        }),
      ])
      expect(settled).toBe(false)
      expect(
        (await harness.db.select().from(intentApplyJournal)).every(
          (row) => row.state === 'prepared',
        ),
      ).toBe(true)
      release.release()
      expect(await pending).toMatchObject({ failed: 2, rolledForward: 0 })
      expect([...calls].sort()).toEqual(['legacy', 'native'])
      expect(
        (
          await harness.db
            .select()
            .from(intentApplyJournal)
            .where(eq(intentApplyJournal.id, 'active'))
            .get()
        )?.state,
      ).toBe('prepared')
      expect(existsSync(f.appHome)).toBe(false)
    } finally {
      release.release()
      await pending.catch(() => {})
    }
  })

  test('database maintenance waits for selected scratch listing/removal and preserves running, failed and recent rows', async () => {
    const f = await fixture('skill'),
      listing = barrier(),
      listRelease = barrier(),
      removing = barrier(),
      removeRelease = barrier()
    for (const [seq, id, kind, createdAt] of [
      [1, 'failed', 'error', 1],
      [2, 'removed', 'error', 1],
      [3, 'running', 'running', 1],
      [4, 'recent', 'error', 10_001],
    ] as const) {
      await harness.db.insert(intentTurns).values({
        id,
        sessionId: f.sessionId,
        seq,
        role: 'agent',
        kind,
        scratchRetained: true,
        createdAt,
      })
    }
    const calls: string[] = []
    const warnings: unknown[] = []
    const maintenance = composeIntentMaintenanceCommandsForDatabase({
      db: harness.db,
      appHome: f.appHome,
      pluginsDir: join(f.appHome, 'plugins'),
      scratchDirectoryName: 'scratch',
      resourcePackages: {
        async converge() {
          return { failed: 0, rolledForward: 0 }
        },
      },
      content: content(),
      log: {
        ...log,
        warn(message, fields) {
          warnings.push({ message, fields })
        },
      },
      scratch: {
        async staleTurnIds(cutoff) {
          expect(cutoff).toBe(10_000)
          listing.release()
          await listRelease.pending
          return ['failed', 'removed', 'running']
        },
        async remove(turnId) {
          calls.push(turnId)
          if (turnId === 'failed') throw new Error('objects unavailable')
          expect(turnId).toBe('removed')
          removing.release()
          await removeRelease.pending
        },
      },
    })
    const retained = async () =>
      await harness.db
        .select({ id: intentTurns.id, retained: intentTurns.scratchRetained })
        .from(intentTurns)
        .orderBy(intentTurns.id)
    let settled = false
    const pending = maintenance.scratch
      .sweep({ retentionHours: 1, now: 3_610_000 })
      .then((result) => {
        settled = true
        return result
      })
    try {
      await Promise.race([
        listing.pending,
        pending.then(() => {
          throw new Error('listing not reached')
        }),
      ])
      expect(settled).toBe(false)
      expect((await retained()).every((row) => row.retained)).toBe(true)
      expect(calls).toEqual([])
      listRelease.release()
      await Promise.race([
        removing.pending,
        pending.then(() => {
          throw new Error('removal not reached')
        }),
      ])
      expect(settled).toBe(false)
      expect((await retained()).every((row) => row.retained)).toBe(true)
      removeRelease.release()
      expect(await pending).toEqual({ removed: 1 })
      expect(calls).toEqual(['failed', 'removed'])
      expect(await retained()).toEqual([
        { id: 'failed', retained: true },
        { id: 'recent', retained: true },
        { id: 'removed', retained: false },
        { id: 'running', retained: true },
      ])
      expect(warnings).toEqual([
        {
          message: 'intent-scratch-sweep-failed',
          fields: { turnId: 'failed', error: 'objects unavailable' },
        },
      ])
      expect(existsSync(f.appHome)).toBe(false)
    } finally {
      listRelease.release()
      removeRelease.release()
      await pending.catch(() => {})
    }
  })
})
