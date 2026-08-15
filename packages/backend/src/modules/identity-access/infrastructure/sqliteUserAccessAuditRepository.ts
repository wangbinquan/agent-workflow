import { sql } from 'drizzle-orm'
import type { DbTxSync } from '@/db/txSync'
import type { UserAccessAuditRecord } from '../application/ports/userAccessAuditRepository'

export function appendUserAccessAudit(transaction: DbTxSync, record: UserAccessAuditRecord): void {
  transaction.run(sql`
    INSERT INTO user_access_audit (
      id,
      target_user_id,
      actor_user_id,
      actor_kind,
      operation_id,
      correlation_id,
      before_role,
      after_role,
      added_permissions_json,
      removed_permissions_json,
      access_revision,
      created_at
    ) VALUES (
      ${record.id},
      ${record.targetUserId},
      ${record.actorUserId},
      ${record.actorKind},
      ${record.operationId},
      ${record.correlationId},
      ${record.beforeRole},
      ${record.afterRole},
      ${JSON.stringify(record.addedPermissions)},
      ${JSON.stringify(record.removedPermissions)},
      ${record.accessRevision},
      ${record.createdAt}
    )
  `)
}
