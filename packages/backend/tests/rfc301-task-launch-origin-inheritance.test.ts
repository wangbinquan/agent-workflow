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

import type { TaskCatalogVisibility, TaskLaunchOrigin } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { startTask, type MaterializedSpace } from '../src/services/task'
import { createTaskExecutionTestTopology } from './helpers/taskExecutionTestTopology'

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
  catalogVisibility: TaskCatalogVisibility = 'public',
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
      catalogVisibility,
      parentTaskId,
      invocationDepth: parentTaskId === null ? 0 : 1,
    })
    .run()
  return id
}

/**
 * RFC-359 W8-A：调用行必须**预留**它要铸的那个子任务 id —— 真实调用节点在 launch 之前就
 * stamp 了 `childTaskId`，铸行准入门（`child-task-reservation-mismatch`）按它对账。
 */
function seedCallRun(h: Harness, taskId: string, childTaskId: string): string {
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
      childTaskId,
    })
    .run()
  return id
}

function callLaunch(parentTaskId: string, parentNodeRunId: string, invocationDepth: number) {
  return {
    parentTaskId,
    parentNodeRunId,
    invocationDepth,
    // 本文件的父任务都不带 owner（NULL owner 的历史行），发起者身份不参与判定。
    launchActorUserId: '__system__',
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
    const rootId = seedRunningTask(h, 'webhook', null, 'internal')
    const childId = ulid()
    const rootRunId = seedCallRun(h, rootId, childId)
    let grandchildId: string | undefined

    await startTask(
      { workflowId: h.workflowId, name: 'child', inputs: {} },
      {
        db: h.db,
        schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
          .schedulerDriver,
        materializedSpace: inheritedSpace(h, childId, false),
        callLaunch: callLaunch(rootId, rootRunId, 1),
        // A call child may not escape its parent's catalog boundary.
        catalogVisibility: 'public',
        triggerContext: { trigger: { webhook: { event_type: 'push' } } },
        awaitScheduler: true,
        workflowLaunchCommitHook: async (event) => {
          if (event.stage !== 'task-committed') return
          h!.db
            .update(tasks)
            .set({ status: 'running' })
            .where(sql`${tasks.id} = ${event.taskId}`)
            .run()
          grandchildId = ulid()
          const childRunId = seedCallRun(h!, event.taskId, grandchildId)
          await startTask(
            { workflowId: h!.workflowId, name: 'grandchild', inputs: {} },
            {
              db: h!.db,
              schedulerDriver: createTaskExecutionTestTopology({ db: h!.db, driver: 'real' })
                .schedulerDriver,
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
    const visibilities = h.db
      .select({ id: tasks.id, catalogVisibility: tasks.catalogVisibility })
      .from(tasks)
      .all()
    expect(new Set(visibilities.map((row) => row.catalogVisibility))).toEqual(new Set(['internal']))
  })

  test('concurrent siblings all copy one immutable parent value', async () => {
    h = buildHarness()
    const rootId = seedRunningTask(h, 'scheduled')
    const children = Array.from({ length: 8 }, () => {
      const id = ulid()
      return { id, runId: seedCallRun(h!, rootId, id) }
    })

    await Promise.all(
      children.map(({ id, runId }) =>
        startTask(
          { workflowId: h!.workflowId, name: `child-${id}`, inputs: {} },
          {
            db: h!.db,
            schedulerDriver: createTaskExecutionTestTopology({ db: h!.db, driver: 'real' })
              .schedulerDriver,
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
    const conflictingChildId = ulid()
    const blankMetadataChildId = ulid()
    const conflictingRunId = seedCallRun(h, rootId, conflictingChildId)
    const blankMetadataRunId = seedCallRun(h, rootId, blankMetadataChildId)

    await expect(
      startTask(
        { workflowId: h.workflowId, name: 'conflicting-child', inputs: {} },
        {
          db: h.db,
          schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
            .schedulerDriver,
          materializedSpace: inheritedSpace(h, conflictingChildId),
          callLaunch: callLaunch(rootId, conflictingRunId, 1),
          launchProvenance: { kind: 'direct-json', initiator: 'manual' },
        },
      ),
    ).rejects.toMatchObject({ code: 'task-launch-provenance-conflict' })

    await expect(
      startTask(
        { workflowId: h.workflowId, name: 'blank-metadata-child', inputs: {} },
        {
          db: h.db,
          schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
            .schedulerDriver,
          materializedSpace: inheritedSpace(h, blankMetadataChildId),
          callLaunch: callLaunch(rootId, blankMetadataRunId, 1),
          webhookFireId: ' ',
        },
      ),
    ).rejects.toMatchObject({ code: 'task-launch-child-metadata-invalid' })
  })
})
