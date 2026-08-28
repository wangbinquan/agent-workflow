import { normalizeAdditionalPermissionsForWrite } from '@agent-workflow/shared'
import { initialGrantsForRole } from '../../domain/initialGrants'
import { canonicalStoredAccess } from '../../domain/userAccessPolicy'
import type { AdminUserAccessView, ManagedUserStatus } from '../../public/types'
import { UserAccessError as AccessError } from '../../public/types'
import { mapPermissionValidationError } from '../errors'
import { subjectRefOf, trustedContextMetadata, type CommandContext } from '../operationContext'
import type { UserAccessTransactionRunner } from '../ports/userAccessTransaction'
import type { Role, Permission } from '@agent-workflow/shared'
import {
  admissionSubjectOf,
  admitUserAccessMutation,
  userAccessAuditKind,
} from '../accessAdmission'
import type { IdentityAccessObserver } from '../ports/identityAccessObserver'

export interface CreateManagedUserCommand {
  readonly id: string
  readonly username: string
  readonly email: string | null
  readonly displayName: string
  readonly passwordHash: string | null
  readonly role: Role
  readonly status: ManagedUserStatus
  readonly forcePasswordChange: boolean
  readonly createdBy: string | null
  readonly schemaVersion: number
  readonly additionalPermissions: ReadonlyArray<Permission>
}

export interface CreateManagedUserDeps {
  readonly transactions: UserAccessTransactionRunner
  readonly auditId: () => string
  readonly systemUserId: string
  readonly observer?: IdentityAccessObserver
}

export class CreateManagedUser {
  constructor(private readonly deps: CreateManagedUserDeps) {}

  async execute(
    context: CommandContext,
    command: CreateManagedUserCommand,
  ): Promise<AdminUserAccessView> {
    try {
      const contextMeta = trustedContextMetadata(context)
      // RFC-312 —— 建号默认授权与调用方显式勾选取**并集**，再统一规范化。
      // 规范化会去重、并对该角色 baseline 已含的点报错，所以策略必须只返回"可授予"的点
      // （initialGrantsForRole 对 admin 返回空正是为此）。
      // RFC-312 实现门 P2 —— **系统默认授予与操作者显式勾选必须分开归因**。
      // 合并成一个数组后统一记成操作者，审计里会显示"管理员显式授予了 users:presence"，
      // 而迁移 0188 给存量行写的是 NULL（系统）——同一个权限点两条来路两种归因。
      // 这里先把"纯系统默认"的那部分单独留存，写 grant 时据此归因为 NULL。
      const explicitlyRequested = new Set<Permission>(command.additionalPermissions)
      const systemDefaults = new Set<Permission>(
        initialGrantsForRole(command.role).filter((p: Permission) => !explicitlyRequested.has(p)),
      )
      const additionalPermissions = normalizeAdditionalPermissionsForWrite({
        role: command.role,
        additionalPermissions: [
          ...command.additionalPermissions,
          ...initialGrantsForRole(command.role).filter(
            (p: Permission) => !command.additionalPermissions.includes(p),
          ),
        ],
      })
      const view = this.deps.transactions.run((transaction) => {
        const actorUserId = subjectRefOf(context.authority).userId
        const actor = transaction.findUser(actorUserId)
        admitUserAccessMutation(
          admissionSubjectOf(
            actor,
            actor === null ? [] : transaction.listGrants(actor.id).map((grant) => grant.permission),
          ),
          contextMeta,
        )
        if (command.id === this.deps.systemUserId || command.username === this.deps.systemUserId) {
          throw new AccessError('conflict', 'username-reserved', 'system username is reserved')
        }
        if (transaction.findUserByUsername(command.username) !== null) {
          throw new AccessError('conflict', 'username-taken', 'username already exists')
        }
        transaction.insertUser({
          ...command,
          gitName: command.displayName,
          accessRevision: 0,
          createdAt: context.now,
          updatedAt: context.now,
          lastLoginAt: null,
        })
        for (const permission of additionalPermissions) {
          transaction.insertGrant({
            userId: command.id,
            permission,
            // 系统默认授予 ⇒ NULL（与 0188 backfill 一致）；操作者显式勾选 ⇒ 操作者。
            grantedByUserId: systemDefaults.has(permission)
              ? null
              : contextMeta.source === 'cli'
                ? null
                : actorUserId,
            grantedAt: context.now,
          })
        }
        transaction.appendAudit({
          id: this.deps.auditId(),
          targetUserId: command.id,
          actorUserId: contextMeta.source === 'cli' ? null : actorUserId,
          actorKind: userAccessAuditKind(contextMeta.source),
          operationId: context.operationId,
          correlationId: context.correlationId,
          beforeRole: command.role,
          afterRole: command.role,
          addedPermissions: additionalPermissions,
          removedPermissions: [],
          accessRevision: 0,
          createdAt: context.now,
        })
        return toView(command, additionalPermissions, context.now)
      })
      this.deps.observer?.managedUserCreate({
        operationId: context.operationId,
        targetUserId: command.id,
        outcome: 'success',
        revision: 0,
        addedPermissions: additionalPermissions,
      })
      return view
    } catch (error) {
      this.deps.observer?.managedUserCreate({
        operationId: context.operationId,
        targetUserId: command.id,
        outcome: 'rejected',
        addedPermissions: [],
      })
      return mapPermissionValidationError(error)
    }
  }
}

function toView(
  command: CreateManagedUserCommand,
  additionalPermissions: ReadonlyArray<Permission>,
  now: number,
): AdminUserAccessView {
  const canonical = canonicalStoredAccess({
    role: command.role,
    storedPermissions: additionalPermissions,
  })
  return {
    id: command.id,
    username: command.username,
    email: command.email,
    displayName: command.displayName,
    role: command.role,
    status: command.status,
    forcePasswordChange: command.forcePasswordChange,
    history: {
      createdBy: command.createdBy,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    },
    additionalPermissions: canonical.additionalPermissions,
    accessRevision: 0,
  }
}
