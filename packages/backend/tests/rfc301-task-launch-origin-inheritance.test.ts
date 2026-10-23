// RFC-395 II-pre：改接生产启动 / 读取路径，保留原断言意图。
// RFC-301 — application-side task-tree launch-origin inheritance.
//
// The migration trigger is tested separately. These tests deliberately drop it
// so a green result proves the new writer itself reads the exact parent inside
// the initial INSERT transaction, including multi-level and concurrent calls.

import {
  nodeRunFixture,
  patchTaskFixture,
  readTaskFixtures,
  taskFixture,
  workflowFixture,
} from './helpers/model'
import { rawExec, queryWrite } from '@/platform/persistence/queryHelpers'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { TaskCatalogVisibility, TaskLaunchOrigin } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { launchTestTask } from './helpers/productionTaskLaunch'
import { type MaterializedSpace } from '@/modules/source-control/infrastructure/workspaceMaterializer'

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
  rawExec(db, sql`DROP TRIGGER trg_tasks_launch_origin_inherit_child`)
  const workflowId = ulid()
  workflowFixture(db, { id: workflowId, name: `wf-${workflowId}`, definition: EMPTY_DEF })
  return { db, workflowId, roots: [] }
}

function inheritedSpace(h: Harness, taskId: string): MaterializedSpace {
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
    earlyError: null,
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
  taskFixture(h.db, {
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
  return id
}

/**
 * RFC-359 W8-A：调用行必须**预留**它要铸的那个子任务 id —— 真实调用节点在 launch 之前就
 * stamp 了 `childTaskId`，铸行准入门（`child-task-reservation-mismatch`）按它对账。
 */
function seedCallRun(h: Harness, taskId: string, childTaskId: string): string {
  const id = ulid()
  nodeRunFixture(h.db, {
    id,
    taskId,
    nodeId: `call-${id}`,
    status: 'running',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now(),
    childTaskId,
  })
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

    await launchTestTask(
      { workflowId: h.workflowId, name: 'child', inputs: {} },
      {
        db: h.db,
        schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
          .schedulerDriver,
        coordinator: { submit: async ({ taskId }) => ({ kind: 'accepted', taskId }) },
        materializedSpace: inheritedSpace(h, childId),
        callLaunch: callLaunch(rootId, rootRunId, 1),
        // A call child may not escape its parent's catalog boundary.
        catalogVisibility: 'public',
        awaitScheduler: true,
      },
    )

    queryWrite(patchTaskFixture(h.db, { id: childId }, { status: 'running' }))
    const grandchildId = ulid()
    const childRunId = seedCallRun(h, childId, grandchildId)
    await launchTestTask(
      { workflowId: h.workflowId, name: 'grandchild', inputs: {} },
      {
        db: h.db,
        schedulerDriver: createTaskExecutionTestTopology({ db: h.db, driver: 'real' })
          .schedulerDriver,
        coordinator: { submit: async ({ taskId }) => ({ kind: 'accepted', taskId }) },
        materializedSpace: inheritedSpace(h, grandchildId),
        callLaunch: callLaunch(childId, childRunId, 2),
      },
    )

    const origins = new Map(
      (
        await readTaskFixtures(h.db).then((rows) =>
          rows.map((row) => ({ id: row.id, launchOrigin: row.launchOrigin })),
        )
      ).map((row) => [row.id, row.launchOrigin]),
    )
    expect(origins.get(rootId)).toBe('webhook')
    expect(origins.get(childId)).toBe('webhook')
    expect(origins.get(grandchildId!)).toBe('webhook')
    const visibilities = await readTaskFixtures(h.db).then((rows) =>
      rows.map((row) => ({ id: row.id, catalogVisibility: row.catalogVisibility })),
    )
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
        launchTestTask(
          { workflowId: h!.workflowId, name: `child-${id}`, inputs: {} },
          {
            db: h!.db,
            schedulerDriver: createTaskExecutionTestTopology({ db: h!.db, driver: 'real' })
              .schedulerDriver,
            coordinator: { submit: async ({ taskId }) => ({ kind: 'accepted', taskId }) },
            materializedSpace: inheritedSpace(h!, id),
            callLaunch: callLaunch(rootId, runId, 1),
          },
        ),
      ),
    )

    const rows = (
      await readTaskFixtures(h.db).then((rows) =>
        rows.map((row) => ({ id: row.id, launchOrigin: row.launchOrigin })),
      )
    ).filter((row) => row.id !== rootId)
    expect(rows).toHaveLength(children.length)
    expect(new Set(rows.map((row) => row.launchOrigin))).toEqual(new Set(['scheduled']))
  })
})
