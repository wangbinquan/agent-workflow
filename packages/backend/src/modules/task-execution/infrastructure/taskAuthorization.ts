import { tablesOf } from '@/platform/persistence/sessionTables'
// RFC-359 W1-T2c —— 任务成员/可见性判定的**一份**实现，两个引擎共用。
//
// 此前 `sqliteTaskAuthorization.ts`（同步 DbTxSync 孪生）与 `postgresqlTaskAuthorization.ts`
// 各一份，查询逐字相同。PostgreSQL 那份由本文件替代；SQLite 的同步孪生在其余 dbTxSync
// 调用方迁完前保留（W4 pair-deletion）。

import { chunkedAll } from '@/util/sqlChunk'
import { and, eq, inArray, or, type Placeholder, type SQL, type SQLWrapper } from 'drizzle-orm'

import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import type {
  AsyncTaskAuthorizationParticipantInTx,
  TaskActingMembershipInput,
  TaskAuthorizationLookupInput,
  TaskAuthorizationQueries,
  VisibleTaskIdsInput,
} from '../application/ports/taskAuthorization'

type TaskAuthorizationReader = Pick<PersistenceDb, 'select'>

async function canActOnTask(
  db: TaskAuthorizationReader,
  input: TaskActingMembershipInput,
): Promise<boolean> {
  const { taskCollaborators } = tablesOf(db)
  const rows = await db
    .select({ role: taskCollaborators.role })
    .from(taskCollaborators)
    .where(
      and(eq(taskCollaborators.taskId, input.taskId), eq(taskCollaborators.userId, input.userId)),
    )
  return rows.some((row) => row.role === 'owner' || row.role === 'collaborator')
}

function bind(db: TaskAuthorizationReader) {
  return Object.freeze({
    async canViewTask(input: TaskAuthorizationLookupInput) {
      if (input.taskId.length === 0) return false
      return (await visibleTaskIdsFor(db, input.subject, [input.taskId])).has(input.taskId)
    },
    async visibleTaskIds(input: VisibleTaskIdsInput) {
      return await visibleTaskIdsFor(db, input.subject, input.taskIds)
    },
    async canActOnTask(input: TaskActingMembershipInput) {
      return await canActOnTask(db, input)
    },
  })
}

/** 绑定到调用方已经开好的事务（两个引擎同一份判定）。 */
export function createTaskAuthorizationParticipantInTx(
  tx: PersistenceTx,
): AsyncTaskAuthorizationParticipantInTx {
  return bind(tx)
}

export function createTaskAuthorizationQueries(db: PersistenceDb): TaskAuthorizationQueries {
  return bind(db)
}

/**
 * 读侧句柄：只需要 `select`——库、事务、以及只暴露读面的窄类型都能传进来
 * （判据只读，不关心事务边界）。
 */
export type TaskVisibilityReader = Pick<PersistenceDb, 'select'>

/**
 * 请求者的闭合投影。判据只认这两件事，不认整个 `Actor`。
 *
 * `userId` 允许是 `Placeholder`：`taskOverviewQuery` 把这条判据编进**预编译模板**
 * （每次调用只换绑定值，不重新编译 SQL）。不放宽这一处，那边就只能自己再抄一份判据——
 * 而它正是首页计数的口径，抄一份就等于给「概览和列表对不上」留了一条无人看守的路。
 */
export interface TaskVisibilitySubject {
  readonly userId: string | Placeholder
  readonly canReadAllTasks: boolean
}

/**
 * `Actor` → 判据认识的闭合投影。**结构化取值**，不 import identity-access 的 `Actor`：
 * 这条查询不需要知道谁是「演员」，只需要「哪个用户」「能不能看全部」。
 */
export function taskVisibilitySubjectOf(actor: {
  readonly user: { readonly id: string }
  readonly permissions: ReadonlySet<string>
}): TaskVisibilitySubject {
  return { userId: actor.user.id, canReadAllTasks: actor.permissions.has('tasks:read:all') }
}

/**
 * 判据作用的那一行。缺省是 `tasks` 本身；列表页的联表查询要对**别名列**求值，
 * 所以留成参数（RFC-357 `taskListPage/authorization.ts` 就是这个用法）。
 */
export interface TaskVisibilityRowRef {
  readonly id: SQLWrapper
  readonly ownerUserId: SQLWrapper
}

export function defaultTaskVisibilityRowRef(db: object): TaskVisibilityRowRef {
  const { tasks } = tablesOf(db)
  return { id: tasks.id, ownerUserId: tasks.ownerUserId }
}

/** 「我参与的任务 id」子查询。判据与它的分块版本共用同一份，两条路不可能漂。 */
export function taskCollaboratorTaskIds(db: TaskVisibilityReader, userId: string | Placeholder) {
  const { taskCollaborators } = tablesOf(db)
  return db
    .select({ taskId: taskCollaborators.taskId })
    .from(taskCollaborators)
    .where(eq(taskCollaborators.userId, userId))
}

/**
 * 给「已经 join 了 `tasks`」的查询用的可见性条件：owner 是本人，或本人在
 * `task_collaborators` 里。`canReadAllTasks` 为真时返回 `undefined`（无需收窄），
 * 可以直接交给 `and(...)`。
 *
 * **仓里唯一的一份**。此前这条 `or(owner = me, id IN (我参与的))` 在六处逐字重复：
 * 本文件、`taskListPage/authorization.ts`、`collaborationTaskAccess.ts`、
 * `reviewTaskAccess.ts`、`taskOverviewQuery.ts`、`postgresqlTaskRouteOperations.ts`。
 * 它是**授权判据**——任何一处漂了，用户要么看见不该看见的任务，要么丢掉本该看见的，
 * 而六处里有一处还是 provider 专属的（那正是本 RFC 要消灭的形状）。
 */
export function taskVisibilityCondition(
  db: TaskVisibilityReader,
  subject: TaskVisibilitySubject,
  ref: TaskVisibilityRowRef = defaultTaskVisibilityRowRef(db),
): SQL | undefined {
  if (subject.canReadAllTasks) return undefined
  return or(
    eq(ref.ownerUserId, subject.userId),
    inArray(ref.id, taskCollaboratorTaskIds(db, subject.userId)),
  )
}

/**
 * 「这些 taskId 里，哪些**存在且**对该请求者可见」。
 *
 * 存在性过滤是语义的一部分：不存在的 id 不会出现在结果里，`tasks:read:all` 也一样
 * （`rfc311-badge-counts` 的 `visibleTaskIdsOf drops unknown ids for every actor` 钉着这条）。
 *
 * **仓里唯一的一份**。此前四处各写一遍同一个「按 500 分块 + 逐块查存在性与可见性」的循环，
 * 其中 `collaborationTaskAccess.ts` 与 `reviewTaskAccess.ts` 的两份**逐字相同**、还各自把
 * 分块大小硬写成字面量 500（`util/sqlChunk.ts` 的 `SQL_IN_CHUNK` 就是这个数，它存在的理由
 * 正是「别把某个具体数字写进判据」）。
 */
export async function visibleTaskIdsFor(
  db: TaskVisibilityReader,
  subject: TaskVisibilitySubject,
  taskIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (taskIds.length === 0) return new Set()
  const visibility = taskVisibilityCondition(db, subject)
  const rows = await chunkedAll([...new Set(taskIds)], (chunk) => {
    const { tasks } = tablesOf(db)
    return db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        visibility === undefined
          ? inArray(tasks.id, chunk)
          : and(inArray(tasks.id, chunk), visibility),
      )
  })
  return new Set(rows.map((row) => row.id))
}

export async function readRealtimeTaskAudience(db: PersistenceDb, taskId: string, userId: string) {
  const { taskCollaborators } = tablesOf(db)
  const { tasks } = tablesOf(db)
  const taskRows = await db
    .select({ ownerUserId: tasks.ownerUserId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  const task = taskRows[0]
  if (task === undefined) return null
  const memberships = await db
    .select({ userId: taskCollaborators.userId })
    .from(taskCollaborators)
    .where(and(eq(taskCollaborators.taskId, taskId), eq(taskCollaborators.userId, userId)))
    .limit(1)
  return { ownerUserId: task.ownerUserId, member: memberships.length > 0 }
}
