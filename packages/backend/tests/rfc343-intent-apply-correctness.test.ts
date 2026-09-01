// RFC-343 / RFC-294 P0-B — Intent apply must not be weaker than BundleApply:
// bounded lock cardinality, durable/retryable compensation, a versioned and
// complete artifact oracle, corruption fail-closed, and committed roll-forward.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { buildActor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { intentApplyJournal, intentSessions, skillOperations, users } from '../src/db/schema'
import { dbTxSync } from '../src/db/txSync'
import {
  __intentApplyLockCountForTests,
  __withSessionApplyLockForTests,
  convergeIntentApplyJournal,
} from '../src/services/intent/applyChangeset'
import {
  decodeIntentJournalArtifacts,
  encodeIntentJournalArtifacts,
  type IntentJournalArtifactV1,
} from '../src/services/intent/journalArtifacts'
import { createManagedSkillWithFiles } from '../src/modules/resource-catalog/infrastructure/legacy/skill'
import {
  commitSkillVersionInTx,
  stageSkillVersion,
  type StagedSkillVersion,
} from '../src/modules/resource-catalog/infrastructure/legacy/skillVersion'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const OWNER_ID = 'rfc343-intent-owner'

let db: DbClient
let appHome: string
let sessionId: string

const actor = buildActor({
  user: {
    id: OWNER_ID,
    username: OWNER_ID,
    displayName: 'RFC-343 owner',
    role: 'admin',
    status: 'active',
  },
  source: 'daemon',
})

beforeEach(async () => {
  db = createInMemoryDb(MIGRATIONS)
  appHome = mkdtempSync(join(tmpdir(), 'aw-rfc343-intent-'))
  sessionId = ulid()
  const now = Date.now()
  await db.insert(users).values({
    id: OWNER_ID,
    username: OWNER_ID,
    displayName: 'RFC-343 owner',
    role: 'admin',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  })
  await db.insert(intentSessions).values({
    id: sessionId,
    ownerUserId: OWNER_ID,
    title: 'RFC-343 Intent apply',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  })
})

afterEach(() => {
  db.$client.close()
  rmSync(appHome, { recursive: true, force: true })
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function stagedFixture(): StagedSkillVersion {
  return {
    skillId: 'skill-1',
    skillName: 'skill-one',
    opId: 'op-1',
    publishId: 'publish-1',
    newVersion: 2,
    newHash: 'sha256:fixture',
    filesDir: '/tmp/skill-1/files',
    versionDir: '/tmp/skill-1/versions/v2',
    stagingDir: '/tmp/skill-1/.staged-publish-1',
    noop: null,
  }
}

async function seedJournal(
  state: 'prepared' | 'applying' | 'committed',
  preparedArtifactsJson: string,
): Promise<string> {
  const id = ulid()
  const stale = Date.now() - 11 * 60 * 1000
  await db.insert(intentApplyJournal).values({
    id,
    sessionId,
    clientMutationId: ulid(),
    draftId: ulid(),
    draftHash: `sha256:${ulid()}`,
    state,
    preparedArtifactsJson,
    receiptJson:
      state === 'committed' ? JSON.stringify({ journalId: id, commitSeq: 1, applied: [] }) : null,
    createdAt: stale,
    updatedAt: stale,
  })
  return id
}

describe('session apply lock identity', () => {
  test('the last derived chain deletes the key while an earlier waiter cannot', async () => {
    const firstGate = deferred()
    const secondGate = deferred()
    const first = __withSessionApplyLockForTests('same-session', () => firstGate.promise)
    await Promise.resolve()
    const second = __withSessionApplyLockForTests('same-session', () => secondGate.promise)
    await Promise.resolve()
    expect(__intentApplyLockCountForTests()).toBe(1)

    firstGate.resolve()
    await first
    expect(__intentApplyLockCountForTests()).toBe(1)

    secondGate.resolve()
    await second
    expect(__intentApplyLockCountForTests()).toBe(0)
  })

  test('high-cardinality completed sessions leave no process-local keys behind', async () => {
    await Promise.all(
      Array.from({ length: 128 }, (_, index) =>
        __withSessionApplyLockForTests(`session-${index}`, async () => {}),
      ),
    )
    expect(__intentApplyLockCountForTests()).toBe(0)
  })
})

describe('versioned journal artifact codec', () => {
  test('round-trips the complete skill-version publish oracle', () => {
    const artifacts: IntentJournalArtifactV1[] = [
      { kind: 'skill-version-stage', staged: stagedFixture() },
    ]
    const encoded = encodeIntentJournalArtifacts(artifacts)
    expect(JSON.parse(encoded)).toMatchObject({ version: 1 })
    expect(decodeIntentJournalArtifacts(encoded)).toEqual(artifacts)
  })

  test('rejects malformed envelopes and the lossy legacy skill-version shape', () => {
    expect(() => decodeIntentJournalArtifacts('{not-json')).toThrow(/not valid JSON/)
    expect(() =>
      decodeIntentJournalArtifacts(
        JSON.stringify({ version: 2, artifacts: [{ kind: 'skill-version-stage' }] }),
      ),
    ).toThrow(/envelope is invalid/)
    expect(() =>
      decodeIntentJournalArtifacts(
        JSON.stringify([
          {
            kind: 'skill-version-stage',
            skillId: 'skill-1',
            opId: 'op-1',
            stagingDir: '/tmp/incomplete',
          },
        ]),
      ),
    ).toThrow(/legacy skill-version-stage artifact is incomplete/)
  })

  test('rejects a V1 artifact when any required publish-oracle field is removed', () => {
    const envelope = JSON.parse(
      encodeIntentJournalArtifacts([{ kind: 'skill-version-stage', staged: stagedFixture() }]),
    ) as { artifacts: Array<{ staged: Record<string, unknown> }> }
    delete envelope.artifacts[0]!.staged.newHash
    expect(() => decodeIntentJournalArtifacts(JSON.stringify(envelope))).toThrow(
      /envelope is invalid/,
    )
  })

  test('keeps pre-generation legacy plugin rows readable without inventing a path', () => {
    expect(
      decodeIntentJournalArtifacts(JSON.stringify([{ kind: 'plugin-install', pluginId: 'p1' }])),
    ).toEqual([{ kind: 'legacy-plugin-install-untracked', pluginId: 'p1' }])
  })

  test('corrupt prepared and committed rows remain truthful and are not counted as converged', async () => {
    const preparedId = await seedJournal('prepared', '{broken')
    const committedId = await seedJournal(
      'committed',
      JSON.stringify({ version: 1, artifacts: [{ kind: 'unknown' }] }),
    )

    expect(await convergeIntentApplyJournal(db, appHome)).toEqual({
      failed: 0,
      rolledForward: 0,
    })
    const prepared = await db
      .select()
      .from(intentApplyJournal)
      .where(eq(intentApplyJournal.id, preparedId))
      .get()
    const committed = await db
      .select()
      .from(intentApplyJournal)
      .where(eq(intentApplyJournal.id, committedId))
      .get()
    expect(prepared?.state).toBe('prepared')
    expect(prepared?.error).toContain('artifact decode failed')
    expect(committed?.state).toBe('committed')
    expect(committed?.error).toContain('artifact decode failed')
  })
})

describe('committed skill-version convergence', () => {
  test('a persisted complete artifact publishes the exact unfinished version tail once', async () => {
    const skill = await createManagedSkillWithFiles(
      db,
      { appHome },
      { name: 'intent-tail', description: 'v1', ownerUserId: OWNER_ID, actor },
      (filesDir) => {
        writeFileSync(
          join(filesDir, 'SKILL.md'),
          '---\nname: intent-tail\ndescription: v1\n---\n\nbody v1\n',
        )
      },
    )
    const staged = stageSkillVersion(
      db,
      { appHome },
      skill.id,
      (stagingDir) => {
        writeFileSync(
          join(stagingDir, 'SKILL.md'),
          '---\nname: intent-tail\ndescription: v2\n---\n\nbody v2\n',
        )
      },
      {
        source: 'editor',
        authorUserId: OWNER_ID,
        expectedVersion: skill.contentVersion,
        expectedOwnerUserId: OWNER_ID,
      },
    )
    dbTxSync(db, (tx) =>
      commitSkillVersionInTx(tx, staged, {
        source: 'editor',
        authorUserId: OWNER_ID,
        expectedVersion: skill.contentVersion,
        expectedOwnerUserId: OWNER_ID,
      }),
    )
    const journalId = await seedJournal(
      'committed',
      encodeIntentJournalArtifacts([{ kind: 'skill-version-stage', staged }]),
    )

    expect(readFileSync(join(appHome, 'skills', skill.id, 'files', 'SKILL.md'), 'utf8')).toContain(
      'body v1',
    )
    rmSync(staged.stagingDir, { recursive: true, force: true })
    expect(await convergeIntentApplyJournal(db, appHome)).toEqual({
      failed: 0,
      rolledForward: 0,
    })
    expect(
      await db
        .select({ error: intentApplyJournal.error })
        .from(intentApplyJournal)
        .where(eq(intentApplyJournal.id, journalId))
        .get(),
    ).toEqual({
      error: 'retryable: committed roll-forward incomplete; inspect intent apply logs',
    })
    expect(
      await db
        .select({ active: skillOperations.active })
        .from(skillOperations)
        .where(eq(skillOperations.opId, staged.opId!))
        .get(),
    ).toEqual({ active: 1 })

    cpSync(staged.versionDir, staged.stagingDir, { recursive: true })
    expect(await convergeIntentApplyJournal(db, appHome)).toEqual({
      failed: 0,
      rolledForward: 1,
    })
    expect(
      await db
        .select({ error: intentApplyJournal.error })
        .from(intentApplyJournal)
        .where(eq(intentApplyJournal.id, journalId))
        .get(),
    ).toEqual({ error: null })
    expect(readFileSync(join(appHome, 'skills', skill.id, 'files', 'SKILL.md'), 'utf8')).toContain(
      'body v2',
    )
    const operation = await db
      .select()
      .from(skillOperations)
      .where(eq(skillOperations.opId, staged.opId!))
      .get()
    expect(operation).toMatchObject({ phase: 'done', active: 0 })

    // The retained audit row is seen again, but the completed exact op is not
    // republished or unmarked as if it were still pending.
    expect(await convergeIntentApplyJournal(db, appHome)).toEqual({
      failed: 0,
      rolledForward: 1,
    })
    expect(readFileSync(join(appHome, 'skills', skill.id, 'files', 'SKILL.md'), 'utf8')).toContain(
      'body v2',
    )
  })
})
