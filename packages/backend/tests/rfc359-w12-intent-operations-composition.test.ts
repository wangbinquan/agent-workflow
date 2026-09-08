// RFC-359 W12 — construct all six provider apply/maintenance roots and exercise
// their real resource commits, journal recovery, activity snapshots and files.
// The prepare barrier only pauses the real resource session; it replaces no
// persistence or apply algorithm. Both providers use the same behavior cases.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { canonicalIntentJson, parseIntentChangeset } from '@agent-workflow/shared'

import { buildActor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import {
  agents,
  intentApplyJournal,
  intentDrafts,
  intentProvenance,
  intentSessions,
  intentTurns,
  intentWorkingSetChanges,
  plugins,
  users,
} from '@/db/schema'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import type { IntentApplyInput } from '@/modules/intent/application/ports/intentApplyOperations'
import {
  composePostgresqlIntentApplyOperations,
  composeSqliteIntentApplyArtifactLifecycle,
  composeSqliteIntentApplyOperations,
} from '@/modules/intent/composition/apply'
import {
  composePostgresqlIntentMaintenanceCommandsForAppHome,
  composePostgresqlIntentMaintenanceSnapshotQueries,
  composeSqliteIntentMaintenanceCommandsForAppHome,
  composeSqliteIntentMaintenanceSnapshotQueries,
} from '@/modules/intent/composition/maintenance'
import { createPostgresqlIntentApplyArtifactLifecycle } from '@/modules/intent/infrastructure/postgresqlIntentApplyArtifactLifecycle'
import { createPostgresqlIntentApplyOperations } from '@/modules/intent/infrastructure/postgresqlIntentApplyOperations'
import {
  composePostgresqlIntentApplyResourceBinding,
  composePostgresqlSkillArtifactCompensation,
  createPostgresqlIntentPluginArtifactLifecycle,
  createPostgresqlIntentSkillArtifactLifecycle,
} from '@/modules/resource-catalog/composition/intentApply'
import { createResourcePackageApplyActivityRegistry } from '@/modules/resource-catalog/application/resourcePackageMaintenance'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import {
  composePostgresqlResourcePackageApplyMaintenance,
  composeSqliteResourcePackageApplyMaintenance,
} from '@/modules/resource-catalog/composition/resourcePackageMaintenance'
import { createMcpTransactionLifecycle } from '@/modules/resource-catalog/infrastructure/mcpTransactionLifecycle'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { intentApplyResourceBinding } from './helpers/intentApplyResourceBinding'

const OWNER = 'rfc359-intent-composition-owner'
const SCRATCH_DIRECTORY = 'intent-scratch-composition'
const actor = buildActor({
  user: {
    id: OWNER,
    username: OWNER,
    displayName: 'Intent composition owner',
    role: 'admin',
    status: 'active',
  },
  source: 'session',
})

function signal() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function composeFor(harness: ProviderHarness, appHome: string, prepared?: () => Promise<void>) {
  const pluginsDir = join(appHome, 'plugins')
  if (harness.capabilities.isolation === 'exclusive') {
    const db = harness.db as DbClient
    const binding = intentApplyResourceBinding(db, actor)
    const resources: typeof binding.resourceApply = {
      createSession(options) {
        const session = binding.resourceApply.createSession(options)
        return {
          ...session,
          async prepare(plan, context) {
            await session.prepare(plan, context)
            await prepared?.()
          },
        }
      },
    }
    const resourcePackages = composeSqliteResourcePackageApplyMaintenance({
      db,
      appHome,
      pluginsDir,
      activitySource: createResourcePackageApplyActivityRegistry().query,
    }).command
    return {
      authority: binding.authority,
      apply: composeSqliteIntentApplyOperations({
        db,
        appHome,
        resources,
        artifacts: composeSqliteIntentApplyArtifactLifecycle({ db, appHome }),
      }),
      snapshots: composeSqliteIntentMaintenanceSnapshotQueries(db),
      maintenance: composeSqliteIntentMaintenanceCommandsForAppHome({
        db,
        appHome,
        scratchDirectoryName: SCRATCH_DIRECTORY,
        resourcePackages,
      }),
    }
  }

  const db = harness.db as PostgresqlDatabaseClient
  const identity = composeIdentityAccess(db)
  const { authority } = identity.contexts.fromAuthenticatedPrincipal(
    { userId: OWNER, source: 'session' },
    'http',
  )
  const binding = composePostgresqlIntentApplyResourceBinding({
    db,
    mcpLifecycle: createMcpTransactionLifecycle(),
    pluginArtifacts: createPostgresqlIntentPluginArtifactLifecycle({ pluginsDir }),
    skillArtifacts: createPostgresqlIntentSkillArtifactLifecycle({ appHome }),
    aclIdentities: composeResourceCatalogFor({ db }).persistence.identities,
  })
  const resources: typeof binding = {
    createSession(options) {
      const session = binding.createSession(options)
      return {
        ...session,
        async prepare(plan, context) {
          await session.prepare(plan, context)
          await prepared?.()
        },
      }
    },
  }
  const operations = createPostgresqlIntentApplyOperations({
    db,
    resources,
    artifacts: createPostgresqlIntentApplyArtifactLifecycle({
      db,
      appHome,
      pluginsDir,
      skillArtifacts: composePostgresqlSkillArtifactCompensation(),
    }),
  })
  return {
    authority,
    apply: composePostgresqlIntentApplyOperations(operations),
    snapshots: composePostgresqlIntentMaintenanceSnapshotQueries({ db, activity: operations }),
    maintenance: composePostgresqlIntentMaintenanceCommandsForAppHome({
      db,
      appHome,
      pluginsDir,
      scratchDirectoryName: SCRATCH_DIRECTORY,
      resourcePackages: composePostgresqlResourcePackageApplyMaintenance({
        db,
        appHome,
        pluginsDir,
      }).command,
    }),
  }
}

async function seedSession(harness: ProviderHarness): Promise<string> {
  const id = ulid()
  const now = Date.now()
  await harness.db.insert(intentSessions).values({
    id,
    ownerUserId: OWNER,
    title: 'Intent composition',
    createdAt: now,
    updatedAt: now,
  })
  return id
}

async function seedDraft(harness: ProviderHarness): Promise<IntentApplyInput> {
  const sessionId = await seedSession(harness)
  const draftId = ulid()
  const parsed = parseIntentChangeset(
    JSON.stringify({
      $schema_version: 1,
      ops: [
        {
          opId: 'op-1',
          action: 'create',
          resourceType: 'agent',
          tempRef: '$new:worker',
          payload: {
            name: 'composition-worker',
            description: 'created through the selected intent composition root',
            outputs: ['result'],
            skills: [],
            mcp: [],
            plugins: [],
            dependsOn: [],
            bodyMd: 'Complete the assigned work.',
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
    createdAt: Date.now(),
  })
  await harness.db
    .update(intentSessions)
    .set({ currentDraftId: draftId })
    .where(eq(intentSessions.id, sessionId))
  return { sessionId, clientMutationId: ulid(), draftRevision: 1, draftHash, decisions: [] }
}

async function seedTurn(harness: ProviderHarness, sessionId: string, createdAt: number) {
  const id = ulid()
  await harness.db.insert(intentTurns).values({
    id,
    sessionId,
    seq: 1,
    role: 'agent',
    kind: 'running',
    captureState: 'live',
    scratchRetained: true,
    createdAt,
  })
  await harness.db
    .update(intentSessions)
    .set({ inFlightTurnId: id })
    .where(eq(intentSessions.id, sessionId))
  return id
}

function writeScratch(appHome: string, turnId: string, modifiedAt: number) {
  const directory = join(appHome, SCRATCH_DIRECTORY, turnId)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'transcript.txt'), `scratch for ${turnId}`)
  const time = new Date(modifiedAt)
  utimesSync(directory, time, time)
  return directory
}

async function seedJournal(
  harness: ProviderHarness,
  sessionId: string,
  input: {
    readonly state: 'prepared' | 'committed'
    readonly generationDir: string
    readonly pluginId: string
    readonly error?: string
  },
) {
  const id = ulid()
  const stale = Date.now() - 2 * 3_600_000
  await harness.db.insert(intentApplyJournal).values({
    id,
    sessionId,
    clientMutationId: ulid(),
    draftId: ulid(),
    draftHash: 'sha256:composition-recovery',
    state: input.state,
    preparedArtifactsJson: JSON.stringify({
      version: 1,
      artifacts: [
        {
          kind: 'plugin-install',
          pluginId: input.pluginId,
          generationId: 'generation',
          generationDir: input.generationDir,
        },
      ],
    }),
    error: input.error ?? null,
    createdAt: stale,
    updatedAt: stale,
  })
  return id
}

describeEachProvider('RFC-359 intent apply and maintenance composition', (harness) => {
  let appHome = ''
  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'rfc359-intent-composition-'))
    const now = Date.now()
    await harness.db.insert(users).values({
      id: OWNER,
      username: OWNER,
      displayName: 'Intent composition owner',
      role: 'admin',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
  })
  afterEach(() => {
    rmSync(appHome, { recursive: true, force: true })
  })

  test('apply creates the resource and receipt once; snapshots track the exact live apply', async () => {
    const reached = signal()
    const release = signal()
    const composition = composeFor(harness, appHome, async () => {
      reached.resolve()
      await release.promise
    })
    const command = await seedDraft(harness)
    const request = { actor, authority: composition.authority, command }
    const applying = composition.apply.apply(request)
    let snapshot: readonly string[] = []
    try {
      await Promise.race([
        reached.promise,
        applying.then(() => {
          throw new Error('apply finished before its prepare barrier')
        }),
      ])
      snapshot = composition.snapshots.activeApplyJournalIds()
      const [journal] = await harness.db
        .select()
        .from(intentApplyJournal)
        .where(eq(intentApplyJournal.sessionId, command.sessionId))
      expect(journal).toMatchObject({ state: 'prepared', receiptJson: null })
      expect(snapshot).toEqual([journal!.id])
      expect(
        await harness.db.select().from(agents).where(eq(agents.name, 'composition-worker')),
      ).toEqual([])
    } finally {
      release.resolve()
      await applying.catch(() => undefined)
    }
    const receipt = await applying
    expect(receipt).toMatchObject({
      commitSeq: 1,
      applied: [
        {
          opId: 'op-1',
          resourceType: 'agent',
          action: 'create',
          fromCopy: false,
          name: 'composition-worker',
        },
      ],
    })
    expect(snapshot).toEqual([receipt.journalId])
    expect(composition.snapshots.activeApplyJournalIds()).toEqual([])
    const [created] = await harness.db
      .select()
      .from(agents)
      .where(eq(agents.id, receipt.applied[0]!.resourceId))
    expect(created).toMatchObject({
      name: 'composition-worker',
      bodyMd: 'Complete the assigned work.',
      outputs: '["result"]',
    })
    const [session] = await harness.db
      .select()
      .from(intentSessions)
      .where(eq(intentSessions.id, command.sessionId))
    expect(session).toMatchObject({ commitSeq: 1, contextRevision: 1, currentDraftId: null })
    const [journal] = await harness.db
      .select()
      .from(intentApplyJournal)
      .where(eq(intentApplyJournal.id, receipt.journalId))
    expect(journal).toMatchObject({
      state: 'committed',
      error: null,
      receiptJson: JSON.stringify(receipt),
    })
    expect(
      await harness.db
        .select()
        .from(intentProvenance)
        .where(eq(intentProvenance.commitId, receipt.journalId)),
    ).toMatchObject([
      { resourceType: 'agent', resourceId: created!.id, sessionId: command.sessionId },
    ])
    expect(await composition.apply.apply(request)).toEqual(receipt)
    expect(
      await harness.db.select().from(agents).where(eq(agents.name, 'composition-worker')),
    ).toHaveLength(1)
  })

  test('boot snapshots recover admitted turns, compensate stale artifacts, then sweep recovered scratch', async () => {
    const composition = composeFor(harness, appHome)
    const now = Date.now()
    const stale = now - 2 * 3_600_000
    const sessionId = await seedSession(harness)
    const turnId = await seedTurn(harness, sessionId, stale)
    const scratch = writeScratch(appHome, turnId, stale)
    const admitted = await composition.snapshots.bootTurnIds()
    expect(admitted).toEqual([turnId])
    expect(await composition.maintenance.recovery.bootTurnIds()).toEqual(admitted)
    const laterSession = await seedSession(harness)
    const laterTurn = await seedTurn(harness, laterSession, stale)
    const laterScratch = writeScratch(appHome, laterTurn, stale)
    await harness.db.insert(intentWorkingSetChanges).values({
      id: ulid(),
      sessionId,
      clientMutationId: ulid(),
      requestHash: 'queued-working-set',
      expectedTurnSeq: 1,
      expectedContextRevision: 0,
      mode: 'after-current',
      deltaJson: '{}',
      state: 'queued',
      createdAt: now,
      updatedAt: now,
    })
    const generationDir = join(appHome, 'plugins', 'uncommitted-plugin', 'generation')
    mkdirSync(generationDir, { recursive: true })
    writeFileSync(join(generationDir, 'index.js'), 'export default {}')
    const journalId = await seedJournal(harness, sessionId, {
      state: 'prepared',
      generationDir,
      pluginId: 'uncommitted-plugin',
    })

    expect(
      await composition.maintenance.recovery.recover({
        recoverTurnIds: admitted,
        activeIntentApplyJournalIds: composition.snapshots.activeApplyJournalIds(),
        activeBundleApplyIds: [],
        now,
      }),
    ).toEqual({
      failed: 1,
      rolledForward: 0,
      queuedWorkingSets: 1,
      orphanedTurns: 1,
      queuedSessionIds: [sessionId],
    })
    const [turn] = await harness.db.select().from(intentTurns).where(eq(intentTurns.id, turnId))
    expect(turn).toMatchObject({
      kind: 'error',
      contentJson: '{"code":"intent-run-daemon-restart"}',
      scratchRetained: true,
      captureState: 'incomplete',
      captureIncompleteReason: 'post-exit-flush-timeout',
    })
    const [journal] = await harness.db
      .select()
      .from(intentApplyJournal)
      .where(eq(intentApplyJournal.id, journalId))
    expect(journal).toMatchObject({ state: 'failed', error: 'daemon-restart before commit' })
    expect(existsSync(generationDir)).toBe(false)
    expect(await composition.snapshots.bootTurnIds()).toEqual([laterTurn])
    expect(await composition.maintenance.scratch.sweep({ retentionHours: 1, now })).toEqual({
      removed: 1,
    })
    expect(existsSync(scratch)).toBe(false)
    expect(readFileSync(join(laterScratch, 'transcript.txt'), 'utf8')).toBe(
      `scratch for ${laterTurn}`,
    )
    const retained = await harness.db
      .select({ id: intentTurns.id, retained: intentTurns.scratchRetained, kind: intentTurns.kind })
      .from(intentTurns)
      .orderBy(intentTurns.id)
    expect(retained).toEqual(
      [
        { id: turnId, retained: false, kind: 'error' as const },
        { id: laterTurn, retained: true, kind: 'running' as const },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    )
  })

  test('committed journal recovery clears a retryable publication only after the real files exist', async () => {
    const composition = composeFor(harness, appHome)
    const sessionId = await seedSession(harness)
    const pluginId = ulid()
    const generationDir = join(appHome, 'plugins', pluginId, 'generation')
    await harness.db.insert(plugins).values({
      id: pluginId,
      name: 'published-plugin',
      spec: 'fixture@1',
      sourceKind: 'npm',
      cachedPath: generationDir,
      installedAt: Date.now(),
    })
    const journalId = await seedJournal(harness, sessionId, {
      state: 'committed',
      generationDir,
      pluginId,
    })
    const recover = () =>
      composition.maintenance.recovery.recover({
        recoverTurnIds: [],
        activeIntentApplyJournalIds: [],
        activeBundleApplyIds: [],
      })
    expect(await recover()).toMatchObject({ failed: 0, rolledForward: 0 })
    const [pending] = await harness.db
      .select()
      .from(intentApplyJournal)
      .where(eq(intentApplyJournal.id, journalId))
    expect(pending).toMatchObject({
      state: 'committed',
      error: 'retryable: committed roll-forward incomplete; inspect intent apply logs',
    })
    mkdirSync(generationDir, { recursive: true })
    writeFileSync(join(generationDir, 'index.js'), 'export default {}')
    expect(await recover()).toMatchObject({ failed: 0, rolledForward: 1 })
    const [settled] = await harness.db
      .select()
      .from(intentApplyJournal)
      .where(eq(intentApplyJournal.id, journalId))
    expect(settled).toMatchObject({ state: 'committed', error: null })
    expect(readFileSync(join(generationDir, 'index.js'), 'utf8')).toBe('export default {}')
  })
})
