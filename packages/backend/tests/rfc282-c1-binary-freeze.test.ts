// RFC-282 C1-2 — config.opencodePath folds into the FROZEN binary at mint.
//
// The old shape resolved config at SPAWN time through the per-entry
// opencodeCmd channel: editing config.opencodePath could flip the argv head
// of an already-minted run on resume — against RFC-111 D15 ("resume reads the
// frozen snapshot, never the mutable sources"). Now the fallback freezes with
// protocol/params/configDir, and the mapping "which config key backs which
// protocol" stays DRIVER knowledge (defaultBinary差分), zero kind literals in
// the mint (the rfc143 bypass-zero lock enforces that side).

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { resolveFrozenRuntime } from '../src/services/nodeRunMint'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-282 C1-2 — config binary fallback freezes at mint', () => {
  let db: DbClient
  let nodeRunId: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedTestDefaultOpencodeRuntime(db)
    const taskId = ulid()
    await db.insert(workflows).values({
      id: 'wf',
      name: 'wf-' + taskId.toLowerCase(),
      description: '',
      definition: JSON.stringify({ $schema_version: 2, inputs: [], nodes: [], edges: [] }),
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await db.insert(tasks).values({
      id: taskId,
      name: 't',
      workflowId: 'wf',
      workflowSnapshot: '{}',
      repoPath: '/repo',
      worktreePath: '/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      baseCommit: null,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    nodeRunId = ulid()
    await db.insert(nodeRuns).values({
      id: nodeRunId,
      taskId,
      nodeId: 'n1',
      iteration: 0,
      retryIndex: 0,
      status: 'pending',
    })
  })

  test('registry without binaryPath + config.opencodePath set → the CONFIG head freezes', async () => {
    const frozen = await resolveFrozenRuntime(db, nodeRunId, null, null, null, {
      opencodePath: '/opt/custom-oc',
    })
    expect(frozen.protocol).toBe('opencode')
    expect(frozen.binary).toBe('/opt/custom-oc')
    const row = (
      await db
        .select({ runtimeBinary: nodeRuns.runtimeBinary })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, nodeRunId))
    )[0]!
    expect(row.runtimeBinary).toBe('/opt/custom-oc')
  })

  test('no config contribution → binary stays null (custom-fork detection untouched)', async () => {
    const frozen = await resolveFrozenRuntime(db, nodeRunId, null, null, null, {
      opencodePath: null,
    })
    expect(frozen.binary).toBeNull()
  })

  test('an already-frozen row ignores later config values (D15: resume reads the snapshot)', async () => {
    await resolveFrozenRuntime(db, nodeRunId, null, null, null, { opencodePath: '/opt/first' })
    const again = await resolveFrozenRuntime(db, nodeRunId, null, null, null, {
      opencodePath: '/opt/EDITED-LATER',
    })
    expect(again.binary).toBe('/opt/first')
  })
})
