// RFC-301 — application-side task-tree launch-origin inheritance.
//
// The migration trigger is tested separately. These tests deliberately drop it
// so a green result proves the new writer itself reads the exact parent inside
// the initial INSERT transaction, including multi-level and concurrent calls.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { TaskLaunchOrigin } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { startTask, type MaterializedSpace } from '../src/services/task'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const EMPTY_DEF = JSON.stringify({ $schema_version: 4, inputs: [], nodes: [], edges: [] })

interface Harness {
  db: DbClient
  workflowId: string
  roots: string[]
}

function buildHarness(): Harness {
  const db = createInMemoryDb(MIGRATIONS)
  db.run(sql`DROP TRIGGER trg_tasks_launch_origin_inherit_child`)
  const workflowId = ulid()
  db.insert(workflows)
    .values({ id: workflowId, name: `wf-${workflowId}`, definition: EMPTY_DEF })
    .run()
  return { db, workflowId, roots: [] }
}

function inheritedSpace(h: Harness, taskId: string, failBeforeScheduler = true): MaterializedSpace {
  const worktreePath = mkdtempSync(join(tmpdir(), 'aw-rfc301-child-'))
  h.roots.push(worktreePath)
  const branch = `agent-workflow/${taskId}`
  return {
    kind: 'single',
    spaceKind: 'inherited',
    taskId,
    worktreePath,
    branch,
    baseCommit: null,
    earlyError: failBeforeScheduler ? 'rfc301 fixture stops before scheduler' : null,
    resolvedSources: [
      {
        repoPath: worktreePath,
        baseBranch: 'main',
        repoUrl: null,
        cachedRepoId: null,
        pathFetchError: null,
        ffWarnings: [],
      },
    ],
    repos: [
      {
        repoIndex: 0,
        repoPath: worktreePath,
        repoUrl: null,
        cachedRepoId: null,
        baseBranch: 'main',
        branch,
        baseCommit: null,
        worktreePath,
        worktreeDirName: '',
        mountPath: '',
        subdir: '',
        readonly: false,
        submoduleInitOk: true,
        submoduleInitError: null,
        hasSubmodules: false,
      },
    ],
    nodePaths: [],
    cleanup: {
      taskId,
      ownedRoot: null,
      worktrees: [],
      state: 'owned',
      report: null,
    },
  }
}

function seedRunningTask(
  h: Harness,
  launchOrigin: TaskLaunchOrigin,
  parentTaskId: string | null = null,
): string {
  const id = ulid()
  h.db
    .insert(tasks)
    .values({
      id,
      name: `task-${id}`,
      workflowId: h.workflowId,
      workflowSnapshot: EMPTY_DEF,
      repoPath: '/tmp/rfc301-parent',
      worktreePath: '/tmp/rfc301-parent',
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
      launchOrigin,
      parentTaskId,
      invocationDepth: parentTaskId === null ? 0 : 1,
    })
    .run()
  return id
}

function seedCallRun(h: Harness, taskId: string): string {
  const id = ulid()
  h.db
    .insert(nodeRuns)
    .values({
      id,
      taskId,
      nodeId: `call-${id}`,
      status: 'running',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now(),
    })
    .run()
  return id
}

function callLaunch(parentTaskId: string, parentNodeRunId: string, invocationDepth: number) {
  return {
    parentTaskId,
    parentNodeRunId,
    invocationDepth,
    frozenSnapshotJson: EMPTY_DEF,
    refClosureJson: null,
  }
}

describe('RFC-301 task launch-origin inheritance without the compatibility trigger', () => {
  let h: Harness | undefined

  afterEach(() => {
    for (const root of h?.roots ?? []) rmSync(root, { recursive: true, force: true })
    h = undefined
  })

  test('a workflow child and grandchild copy the exact root origin', async () => {
    h = buildHarness()
    const rootId = seedRunningTask(h, 'webhook')
    const rootRunId = seedCallRun(h, rootId)
    const childId = ulid()
    let grandchildId: string | undefined

    await startTask(
      { workflowId: h.workflowId, name: 'child', inputs: {} },
      {
        db: h.db,
        materializedSpace: inheritedSpace(h, childId, false),
        callLaunch: callLaunch(rootId, rootRunId, 1),
        triggerContext: { trigger: { webhook: { event_type: 'push' } } },
        awaitScheduler: true,
        workflowLaunchCommitHook: async (event) => {
          if (event.stage !== 'task-committed') return
          h!.db
            .update(tasks)
            .set({ status: 'running' })
            .where(sql`${tasks.id} = ${event.taskId}`)
            .run()
          const childRunId = seedCallRun(h!, event.taskId)
          grandchildId = ulid()
          await startTask(
            { workflowId: h!.workflowId, name: 'grandchild', inputs: {} },
            {
              db: h!.db,
              materializedSpace: inheritedSpace(h!, grandchildId),
              callLaunch: callLaunch(event.taskId, childRunId, 2),
            },
          )
        },
      },
    )

    const origins = new Map(
      h.db
        .select({ id: tasks.id, launchOrigin: tasks.launchOrigin })
        .from(tasks)
        .all()
        .map((row) => [row.id, row.launchOrigin]),
    )
    expect(origins.get(rootId)).toBe('webhook')
    expect(origins.get(childId)).toBe('webhook')
    expect(origins.get(grandchildId!)).toBe('webhook')
  })

  test('concurrent siblings all copy one immutable parent value', async () => {
    h = buildHarness()
    const rootId = seedRunningTask(h, 'scheduled')
    const children = Array.from({ length: 8 }, () => ({
      id: ulid(),
      runId: seedCallRun(h!, rootId),
    }))

    await Promise.all(
      children.map(({ id, runId }) =>
        startTask(
          { workflowId: h!.workflowId, name: `child-${id}`, inputs: {} },
          {
            db: h!.db,
            materializedSpace: inheritedSpace(h!, id),
            callLaunch: callLaunch(rootId, runId, 1),
          },
        ),
      ),
    )

    const rows = h.db
      .select({ id: tasks.id, launchOrigin: tasks.launchOrigin })
      .from(tasks)
      .all()
      .filter((row) => row.id !== rootId)
    expect(rows).toHaveLength(children.length)
    expect(new Set(rows.map((row) => row.launchOrigin))).toEqual(new Set(['scheduled']))
  })

  test('a child cannot smuggle root provenance or even blank root attribution ids', async () => {
    h = buildHarness()
    const rootId = seedRunningTask(h, 'api')
    const runId = seedCallRun(h, rootId)

    await expect(
      startTask(
        { workflowId: h.workflowId, name: 'conflicting-child', inputs: {} },
        {
          db: h.db,
          materializedSpace: inheritedSpace(h, ulid()),
          callLaunch: callLaunch(rootId, runId, 1),
          launchProvenance: { kind: 'direct-json', initiator: 'manual' },
        },
      ),
    ).rejects.toMatchObject({ code: 'task-launch-provenance-conflict' })

    await expect(
      startTask(
        { workflowId: h.workflowId, name: 'blank-metadata-child', inputs: {} },
        {
          db: h.db,
          materializedSpace: inheritedSpace(h, ulid()),
          callLaunch: callLaunch(rootId, runId, 1),
          webhookFireId: ' ',
        },
      ),
    ).rejects.toMatchObject({ code: 'task-launch-child-metadata-invalid' })
  })
})
