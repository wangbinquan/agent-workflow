// RFC-357 —— 共享场景的种子写入。`db` 是两个 provider 的公共基类型，所以这段
// insert 代码两边逐字相同；差异全在调用方怎么把客户端造出来。

import { lifecycleAlerts, taskCollaborators, tasks, users, workflows } from '@/db/schema'
import type { TaskListPageDb } from '@/modules/task-execution/infrastructure/taskListPage'

import {
  RFC357_SEED,
  rfc357BranchStartedAt,
  rfc357RootOf,
  rfc357StartedAt,
} from './rfc357PageScenario'

export async function seedRfc357Page(db: TaskListPageDb): Promise<void> {
  await db.insert(users).values(
    ['admin', 'alice', 'bob'].map((id) => ({
      id,
      username: id,
      displayName: id,
      role: id === 'admin' ? ('admin' as const) : ('user' as const),
      status: 'active' as const,
      createdAt: 1,
      updatedAt: 1,
    })),
  )
  await db.insert(workflows).values({
    id: 'wf1',
    name: 'Nightly Workflow',
    definition: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
  })

  for (const row of RFC357_SEED) {
    const startedAt = rfc357StartedAt(row.id)
    await db.insert(tasks).values({
      id: row.id,
      name: row.name,
      workflowId: 'wf1',
      workflowSnapshot: '{}',
      repoPath: row.repoPath ?? `/srv/repos/${row.id}`,
      worktreePath: `/tmp/wt-${row.id}`,
      baseBranch: 'main',
      branch: `agent-workflow/${row.id}`,
      status: row.status,
      inputs: '{}',
      startedAt,
      finishedAt: row.status === 'running' ? null : startedAt + 10,
      runningMs: 7,
      runningSince: row.status === 'running' ? startedAt : null,
      ownerUserId: row.owner,
      launchOrigin: row.origin,
      parentTaskId: row.parent ?? null,
      invocationDepth: row.parent === undefined ? 0 : 1,
      branchStartedAt: rfc357BranchStartedAt(row),
      rootTaskId: rfc357RootOf(row),
      catalogVisibility: 'public',
      workgroupId: row.workgroupConfigJson === undefined ? null : 'wg1',
      workgroupConfigJson: row.workgroupConfigJson ?? null,
      sourceAgentName: row.sourceAgentName ?? null,
      repoCount: 1,
    })
    for (const userId of row.collaborators ?? []) {
      await db
        .insert(taskCollaborators)
        .values({ taskId: row.id, userId, role: 'collaborator', addedBy: 'admin', addedAt: 1 })
    }
    for (let index = 0; index < (row.alerts ?? 0); index += 1) {
      await db.insert(lifecycleAlerts).values({
        id: `${row.id}-alert-${index}`,
        taskId: row.id,
        rule: 'stuck',
        severity: 'warning',
        detail: 'seeded',
        detectedAt: startedAt,
        resolvedAt: null,
      })
    }
  }
}
