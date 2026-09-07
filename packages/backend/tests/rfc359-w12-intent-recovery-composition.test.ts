// The recovery inputs are persisted crash states and real plugin generations.
// No artifact compensation, publication result, or database operation is mocked.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { intentApplyJournal, intentSessions, plugins } from '@/db/schema'
import { INTENT_APPLY_COMMITTED_ROLL_FORWARD_RETRYABLE } from '@/modules/intent/application/journalConvergence'
import { composeSqliteIntentApplyArtifactLifecycle } from '@/modules/intent/composition/apply'
import { composePostgresqlIntentApplyConvergence } from '@/modules/intent/composition/postgresqlApplyMaintenance'
import {
  encodeIntentJournalArtifacts,
  type IntentJournalArtifactV1,
} from '@/modules/intent/domain/journalArtifacts'
import { convergeIntentApplyJournal } from '@/modules/intent/infrastructure/sqliteIntentApplyOperations'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createLogger } from '@/util/log'
import { describeEachProvider } from './helpers/eachProvider'

const pluginBytes = 'export default function recoveredPlugin() { return "published-generation" }\n'
const staleTimestamp = () => Date.now() - 3_600_000
const log = createLogger('rfc359-intent-recovery-composition')

describeEachProvider('RFC-359 W12 Intent recovery complete composition', (harness) => {
  const directories: string[] = []
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function environment() {
    const appHome = mkdtempSync(join(tmpdir(), 'aw-w12-intent-recovery-'))
    directories.push(appHome)
    const pluginsDir = join(appHome, 'plugins')
    mkdirSync(pluginsDir)
    return { appHome, pluginsDir }
  }

  function compose(input: { appHome: string; pluginsDir: string }) {
    if (harness.capabilities.isolation === 'exclusive') {
      const db = harness.db as DbClient
      const artifacts = composeSqliteIntentApplyArtifactLifecycle({ db, appHome: input.appHome })
      return {
        converge: (command: { readonly activeJournalIds: readonly string[] }) =>
          convergeIntentApplyJournal(db, artifacts, log, command),
      }
    }
    return composePostgresqlIntentApplyConvergence({
      ...input,
      db: harness.db as PostgresqlDatabaseClient,
      log,
    })
  }

  function generation(pluginsDir: string) {
    const pluginId = ulid()
    const generationId = ulid()
    const generationDir = join(pluginsDir, pluginId, 'generations', generationId)
    mkdirSync(generationDir, { recursive: true })
    const entry = join(generationDir, 'index.js')
    writeFileSync(entry, pluginBytes)
    const artifact: IntentJournalArtifactV1 = {
      kind: 'plugin-install',
      pluginId,
      generationId,
      generationDir,
    }
    return { pluginId, generationId, generationDir, entry, artifact }
  }

  async function journal(input: {
    state: 'prepared' | 'applying' | 'committed'
    artifacts: readonly IntentJournalArtifactV1[]
    fresh?: boolean
    corrupt?: boolean
  }) {
    const sessionId = ulid()
    const id = ulid()
    const timestamp = input.fresh ? Date.now() : staleTimestamp()
    await harness.db.insert(intentSessions).values({
      id: sessionId,
      ownerUserId: 'recovery-fixture-owner',
      title: 'Recovery fixture',
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    const preparedArtifactsJson = input.corrupt
      ? 'not-json'
      : harness.capabilities.isolation === 'exclusive'
        ? encodeIntentJournalArtifacts(input.artifacts)
        : JSON.stringify(input.artifacts)
    const receiptJson =
      input.state === 'committed'
        ? JSON.stringify({ journalId: id, commitSeq: 1, applied: [] })
        : null
    await harness.db.insert(intentApplyJournal).values({
      id,
      sessionId,
      clientMutationId: ulid(),
      draftId: ulid(),
      draftHash: 'recovery-draft-hash',
      state: input.state,
      preparedArtifactsJson,
      receiptJson,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    return { id, preparedArtifactsJson, receiptJson }
  }

  async function readJournal(id: string) {
    const [row] = await harness.db
      .select()
      .from(intentApplyJournal)
      .where(eq(intentApplyJournal.id, id))
    if (row === undefined) throw new Error(`journal ${id} disappeared`)
    return row
  }

  test('stale uncommitted generations are removed while active and fresh journals remain intact', async () => {
    const input = environment()
    const stale = generation(input.pluginsDir)
    const active = generation(input.pluginsDir)
    const fresh = generation(input.pluginsDir)
    const staleJournal = await journal({ state: 'prepared', artifacts: [stale.artifact] })
    const activeJournal = await journal({ state: 'applying', artifacts: [active.artifact] })
    const freshJournal = await journal({
      state: 'prepared',
      artifacts: [fresh.artifact],
      fresh: true,
    })
    const originalActive = await readJournal(activeJournal.id)
    const originalFresh = await readJournal(freshJournal.id)

    expect(await compose(input).converge({ activeJournalIds: [activeJournal.id] })).toEqual({
      failed: 1,
      rolledForward: 0,
    })
    expect(existsSync(stale.generationDir)).toBe(false)
    expect(await readJournal(staleJournal.id)).toMatchObject({
      state: 'failed',
      error: 'daemon-restart before commit',
    })
    expect(await readJournal(activeJournal.id)).toEqual(originalActive)
    expect(await readJournal(freshJournal.id)).toEqual(originalFresh)
    expect(readFileSync(active.entry, 'utf8')).toBe(pluginBytes)
    expect(readFileSync(fresh.entry, 'utf8')).toBe(pluginBytes)

    // A new composition owns the same persisted journal and filesystem state.
    expect(await compose(input).converge({ activeJournalIds: [] })).toEqual({
      failed: 1,
      rolledForward: 0,
    })
    expect(existsSync(active.generationDir)).toBe(false)
    expect(readFileSync(fresh.entry, 'utf8')).toBe(pluginBytes)
    await harness.db
      .update(intentApplyJournal)
      .set({ updatedAt: staleTimestamp() })
      .where(eq(intentApplyJournal.id, freshJournal.id))
    expect(await compose(input).converge({ activeJournalIds: [] })).toEqual({
      failed: 1,
      rolledForward: 0,
    })
    expect(existsSync(fresh.generationDir)).toBe(false)
    expect(await compose(input).converge({ activeJournalIds: [] })).toEqual({
      failed: 0,
      rolledForward: 0,
    })
  })

  test('committed publication remains retryable until both its plugin row and entry file exist', async () => {
    const input = environment()
    const published = generation(input.pluginsDir)
    const committed = await journal({ state: 'committed', artifacts: [published.artifact] })
    const recover = () => compose(input).converge({ activeJournalIds: [] })
    expect(await recover()).toEqual({ failed: 0, rolledForward: 0 })
    expect(await readJournal(committed.id)).toMatchObject({
      state: 'committed',
      error: INTENT_APPLY_COMMITTED_ROLL_FORWARD_RETRYABLE,
    })
    expect(readFileSync(published.entry, 'utf8')).toBe(pluginBytes)

    await harness.db.insert(plugins).values({
      id: published.pluginId,
      name: 'Recovered plugin',
      spec: published.entry,
      sourceKind: 'file',
      cachedPath: published.entry,
      installedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    rmSync(published.entry)
    expect(await recover()).toEqual({ failed: 0, rolledForward: 0 })
    expect((await readJournal(committed.id)).error).toBe(
      INTENT_APPLY_COMMITTED_ROLL_FORWARD_RETRYABLE,
    )
    expect(existsSync(published.generationDir)).toBe(true)

    writeFileSync(published.entry, pluginBytes)
    expect(await recover()).toEqual({ failed: 0, rolledForward: 1 })
    const completed = await readJournal(committed.id)
    expect(completed).toMatchObject({
      state: 'committed',
      error: null,
      receiptJson: committed.receiptJson,
      preparedArtifactsJson: committed.preparedArtifactsJson,
    })
    expect(readFileSync(published.entry, 'utf8')).toBe(pluginBytes)
    // Committed rows are replayed on every run; their count remains one while
    // their durable state, receipt and published bytes stay unchanged.
    expect(await recover()).toEqual({ failed: 0, rolledForward: 1 })
    expect(await readJournal(committed.id)).toEqual(completed)
    expect(readFileSync(published.entry, 'utf8')).toBe(pluginBytes)
  })

  test('an unreadable recovery journal stays visible and leaves its generation untouched', async () => {
    const input = environment()
    const published = generation(input.pluginsDir)
    const corrupt = await journal({
      state: 'prepared',
      artifacts: [published.artifact],
      corrupt: true,
    })
    expect(await compose(input).converge({ activeJournalIds: [] })).toEqual({
      failed: 0,
      rolledForward: 0,
    })
    const retained = await readJournal(corrupt.id)
    expect(retained.state).toBe('prepared')
    expect(retained.preparedArtifactsJson).toBe('not-json')
    expect(retained.error).toStartWith('retryable: artifact decode failed:')
    expect(readFileSync(published.entry, 'utf8')).toBe(pluginBytes)
  })
})
