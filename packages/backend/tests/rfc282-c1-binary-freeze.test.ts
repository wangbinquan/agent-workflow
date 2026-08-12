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
import { DEFAULT_CONFIG_DIR_PROFILE } from '@agent-workflow/shared'
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

  test('a NON-null frozen binary ignores later config values (D15: resume reads the snapshot)', async () => {
    await resolveFrozenRuntime(db, nodeRunId, null, null, null, { opencodePath: '/opt/first' })
    const again = await resolveFrozenRuntime(db, nodeRunId, null, null, null, {
      opencodePath: '/opt/EDITED-LATER',
    })
    expect(again.binary).toBe('/opt/first')
  })

  // Codex impl-gate P1-3 (RFC-282 收尾门): rows minted BEFORE C1 never froze the
  // config head — it rode the per-entry opencodeCmd channel, read at spawn time.
  // Their NULL runtime_binary means "no explicit head", NOT "bare protocol", so
  // resuming one must keep resolving against the current config. D15 narrows to
  // "a non-NULL frozen value never drifts"; the stored column stays NULL (compat
  // read only — no backfill), which the row assertion pins.
  test('a pre-C1 frozen row (runtime set, binary NULL) resolves the CURRENT config head on resume', async () => {
    await db
      .update(nodeRuns)
      .set({ runtime: 'opencode', runtimeBinary: null, runtimeParamsJson: '{}' })
      .where(eq(nodeRuns.id, nodeRunId))
    const resumed = await resolveFrozenRuntime(db, nodeRunId, null, null, null, {
      opencodePath: '/opt/post-upgrade-oc',
    })
    expect(resumed.protocol).toBe('opencode')
    expect(resumed.binary).toBe('/opt/post-upgrade-oc')
    const row = (
      await db
        .select({ runtimeBinary: nodeRuns.runtimeBinary })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, nodeRunId))
    )[0]!
    expect(row.runtimeBinary).toBeNull()
  })

  test('a pre-C1 frozen row without any config contribution stays bare (NULL)', async () => {
    await db
      .update(nodeRuns)
      .set({ runtime: 'opencode', runtimeBinary: null, runtimeParamsJson: '{}' })
      .where(eq(nodeRuns.id, nodeRunId))
    const resumed = await resolveFrozenRuntime(db, nodeRunId, null, null, null, {
      opencodePath: null,
    })
    expect(resumed.binary).toBeNull()
  })

  // Codex impl-gate P1-2 (RFC-282 收尾门): commit/merge sessions freeze via an
  // inherit-literal (pre-resolved profile object). A NULL profile binaryPath +
  // config head used to reach those spawns through opts.opencodeCmd; the fold
  // must apply to the inherit branch too, and this first freeze of the new row
  // captures the head into the column (same semantics as fresh-resolve).
  test('inherit-literal with NULL binary folds the config head and freezes it', async () => {
    const frozen = await resolveFrozenRuntime(
      db,
      nodeRunId,
      null,
      null,
      {
        protocol: 'opencode',
        binary: null,
        params: {
          model: null,
          variant: null,
          temperature: null,
          steps: null,
          maxSteps: null,
          isSandbox: false,
        },
        configDir: DEFAULT_CONFIG_DIR_PROFILE['opencode'],
      },
      { opencodePath: '/opt/commit-agent-oc' },
    )
    expect(frozen.binary).toBe('/opt/commit-agent-oc')
    const row = (
      await db
        .select({ runtimeBinary: nodeRuns.runtimeBinary })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, nodeRunId))
    )[0]!
    expect(row.runtimeBinary).toBe('/opt/commit-agent-oc')
  })

  test('inherit-literal with an explicit binary is untouched by config (registry wins)', async () => {
    const frozen = await resolveFrozenRuntime(
      db,
      nodeRunId,
      null,
      null,
      {
        protocol: 'opencode',
        binary: '/opt/profile-oc',
        params: {
          model: null,
          variant: null,
          temperature: null,
          steps: null,
          maxSteps: null,
          isSandbox: false,
        },
        configDir: DEFAULT_CONFIG_DIR_PROFILE['opencode'],
      },
      { opencodePath: '/opt/config-oc' },
    )
    expect(frozen.binary).toBe('/opt/profile-oc')
  })
})
