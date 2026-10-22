// RFC-395 II-pre：用户测试夹具通过生产 identity-access 命令、查询和认证运行时建号与更新。
// 保留测试使用的调用签名；密码实现、账户规则、授权写入与会话撤销仍由生产路径负责。
import { type PersistenceTables } from '@/platform/persistence/sessionTables'
import { ulid } from 'ulid'
import type { CreateUserBody, PatchUserBody, UserPublic } from '@agent-workflow/shared'
import { SYSTEM_USER_ID } from '@/auth/actor'
import type { AuthRuntime } from '@/auth/application/authRuntime'
import { createAuthRuntimeFor } from '@/auth/composition'
import { hashPassword } from '@/auth/passwords'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import { composeIdentityUserOperations } from '@/modules/identity-access/composition/userOperations'
import {
  AuthorityFenceCache,
  createUserAccessRepository,
} from '@/modules/identity-access/infrastructure/userAccessPersistence'
import { UserAccessError } from '@/modules/identity-access/public/types'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'

export type UserRow = PersistenceTables['users']['$inferSelect']
export interface CreateUserInput extends Omit<CreateUserBody, 'additionalPermissions'> {
  additionalPermissions?: CreateUserBody['additionalPermissions']
  createdBy?: string | null
  now?: number
  status?: 'active' | 'disabled' | 'invited'
}
export interface ResetPasswordInput {
  newPassword: string
  force?: boolean
  now?: number
}
export interface SearchInput {
  q?: string
  limit?: number
  excludeIds?: string[]
  status?: UserPublic['status']
}

async function withIdentity<T>(
  db: PersistenceDb,
  run: (runtime: ReturnType<typeof createIdentityAccessRuntime>) => Promise<T>,
): Promise<T> {
  const runtime = createIdentityAccessRuntime({ db })
  try {
    return await run(runtime)
  } catch (error) {
    // 与 HTTP 适配器相同的错误投影；领域判定由生产命令执行。
    if (!(error instanceof UserAccessError)) throw error
    switch (error.kind) {
      case 'conflict':
        throw new ConflictError(error.code, error.message, error.details)
      case 'forbidden':
        throw new ForbiddenError(error.code, error.message, error.details)
      case 'not-found':
        throw new NotFoundError(error.code, error.message, error.details)
      case 'validation':
        throw new ValidationError(error.code, error.message, error.details)
    }
  } finally {
    runtime.shutdown()
  }
}

const userRepository = (db: PersistenceDb) =>
  createUserAccessRepository(db, new AuthorityFenceCache())

export async function findById(db: PersistenceDb, id: string): Promise<UserRow | null> {
  return (await userRepository(db).findAccessSnapshot(id))?.user ?? null
}

export async function findByUsername(db: PersistenceDb, username: string): Promise<UserRow | null> {
  // 管理夹具包含系统行；生产 public directory 按设计不返回该行。
  if (username === SYSTEM_USER_ID) return findById(db, SYSTEM_USER_ID)
  const row = await userRepository(db).findByUsername(username)
  return row === null ? null : findById(db, row.id)
}

export async function listAllUsers(db: PersistenceDb): Promise<UserRow[]> {
  return (await userRepository(db).listAccessSnapshots()).map(({ user }) => user)
}

export async function countNonSystemUsers(db: PersistenceDb): Promise<number> {
  return (await listAllUsers(db)).filter((user) => user.id !== SYSTEM_USER_ID).length
}

export async function createUser(db: PersistenceDb, input: CreateUserInput): Promise<UserRow> {
  return withIdentity(db, async (runtime) => {
    const operator = await runtime.localOperator.forUser(input.createdBy ?? SYSTEM_USER_ID)
    if (operator === null)
      throw new ForbiddenError('user-access-actor-inactive', 'user access actor is not active')
    const id = ulid()
    const passwordHash = input.password ? await hashPassword(input.password) : null
    // CLI / OIDC 风格夹具允许指定初始状态、创建者和时间；统一交给生产建号命令。
    await runtime.createManagedUser.execute(operator.commandContext(input.now ?? Date.now()), {
      id,
      username: input.username,
      email: input.email ?? null,
      displayName: input.displayName,
      passwordHash,
      role: input.role,
      status: input.status ?? (passwordHash === null ? 'invited' : 'active'),
      forcePasswordChange: false,
      createdBy: input.createdBy ?? null,
      schemaVersion: 1,
      additionalPermissions: input.additionalPermissions ?? [],
    })
    return (await findById(db, id))!
  })
}

export async function patchUser(
  db: PersistenceDb,
  id: string,
  patch: PatchUserBody,
  now: number = Date.now(),
  actorId?: string,
  auth: AuthRuntime = createAuthRuntimeFor({ db }),
): Promise<UserRow> {
  return withIdentity(db, async (runtime) => {
    const operator =
      actorId === undefined
        ? await runtime.localOperator.forUser(SYSTEM_USER_ID)
        : await runtime.localOperator.forLegacyHttpUser(actorId)
    if (operator === null)
      throw new ForbiddenError('user-access-actor-inactive', 'user access actor is not active')
    await composeIdentityUserOperations({ identityAccess: runtime, auth }).updateUser.invoke(
      operator.commandContext(now),
      { targetUserId: id, ...patch },
    )
    return (await findById(db, id))!
  })
}

export async function disableUser(
  db: PersistenceDb,
  id: string,
  now: number = Date.now(),
  actorId?: string,
  auth: AuthRuntime = createAuthRuntimeFor({ db }),
): Promise<void> {
  await patchUser(db, id, { status: 'disabled' }, now, actorId, auth)
}

export async function enableUser(
  db: PersistenceDb,
  id: string,
  now: number = Date.now(),
): Promise<void> {
  await patchUser(db, id, { status: 'active' }, now)
}

export async function resetPassword(
  db: PersistenceDb,
  id: string,
  input: ResetPasswordInput,
  auth: AuthRuntime = createAuthRuntimeFor({ db }),
): Promise<void> {
  return withIdentity(db, async (runtime) => {
    const operator = (await runtime.localOperator.forUser(SYSTEM_USER_ID))!
    // 只适配旧夹具的显式时钟；写密码与撤销会话的顺序和规则仍在生产 operations。
    const clockedAuth: AuthRuntime =
      input.now === undefined
        ? auth
        : {
            ...auth,
            writeLocalPasswordIfUnmanaged: (request) =>
              auth.writeLocalPasswordIfUnmanaged({ ...request, updatedAt: input.now! }),
            revokeAllSessionsForUser: (userId) => auth.revokeAllSessionsForUser(userId, input.now!),
          }
    await composeIdentityUserOperations({
      identityAccess: runtime,
      auth: clockedAuth,
    }).resetPassword.invoke(operator.commandContext(input.now ?? Date.now()), {
      targetUserId: id,
      newPassword: input.newPassword,
      force: input.force,
    })
  })
}

export async function lookupUsersPublic(db: PersistenceDb, ids: string[]): Promise<UserPublic[]> {
  return withIdentity(db, async (runtime) => [...(await runtime.userDirectory.lookup(ids))])
}

export async function searchUsersPublic(
  db: PersistenceDb,
  input: SearchInput,
): Promise<UserPublic[]> {
  return withIdentity(db, async (runtime) => [
    ...(await runtime.userDirectory.search({
      ...input,
      limit: Math.min(Math.max(input.limit ?? 20, 1), 100),
      excludeIds: input.excludeIds ?? [],
    })),
  ])
}

export async function getUserGitCommitIdentity(db: PersistenceDb, userId: string) {
  return withIdentity(db, (runtime) => runtime.getUserGitCommitIdentity.execute(userId))
}
