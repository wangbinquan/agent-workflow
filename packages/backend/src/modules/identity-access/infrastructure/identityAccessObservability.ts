import { createLogger, type Logger } from '@/util/log'
import type {
  AccessUpdateObservation,
  IdentityAccessObserver,
  ManagedUserCreateObservation,
} from '../application/ports/identityAccessObserver'

export interface IdentityAccessDiagnosticsSnapshot {
  readonly accessUpdate: Readonly<{
    success: number
    noOp: number
    conflict: number
    rejected: number
  }>
  readonly authorityReresolution: number
  readonly invalidStoredGrant: number
  readonly wsTargetedRefreshFailure: number
}

export interface IdentityAccessDiagnostics {
  snapshot(): IdentityAccessDiagnosticsSnapshot
}

export class IdentityAccessObservability
  implements IdentityAccessObserver, IdentityAccessDiagnostics
{
  private readonly accessUpdateCounts = {
    success: 0,
    noOp: 0,
    conflict: 0,
    rejected: 0,
  }
  private authorityReresolutionCount = 0
  private invalidStoredGrantCount = 0
  private wsTargetedRefreshFailureCount = 0

  constructor(private readonly log: Logger = createLogger('identity-access')) {}

  accessUpdate(observation: AccessUpdateObservation): void {
    this.accessUpdateCounts[outcomeKey(observation.outcome)] += 1
    const fields = {
      operationId: observation.operationId,
      targetUserId: observation.targetUserId,
      outcome: observation.outcome,
      revision: observation.revision,
      addedCount: observation.addedPermissions.length,
      removedCount: observation.removedPermissions.length,
      addedPermissions: observation.addedPermissions,
      removedPermissions: observation.removedPermissions,
    }
    if (observation.outcome === 'success' || observation.outcome === 'no-op') {
      this.log.info('user-access-update', fields)
    } else {
      this.log.warn('user-access-update', fields)
    }
  }

  managedUserCreate(observation: ManagedUserCreateObservation): void {
    const fields = {
      operationId: observation.operationId,
      targetUserId: observation.targetUserId,
      outcome: observation.outcome,
      revision: observation.revision,
      addedCount: observation.addedPermissions.length,
      addedPermissions: observation.addedPermissions,
    }
    if (observation.outcome === 'rejected') this.log.warn('managed-user-create', fields)
    else if (observation.addedPermissions.length > 0) {
      this.log.info('managed-user-create', fields)
    } else {
      this.log.debug('managed-user-create', fields)
    }
  }

  authorityReresolution(_userId: string): void {
    this.authorityReresolutionCount += 1
  }

  invalidStoredGrant(observation: {
    readonly userId: string
    readonly code: string
    readonly permission: unknown
  }): void {
    this.invalidStoredGrantCount += 1
    this.log.warn('invalid-stored-user-permission-grant', { ...observation })
  }

  targetedRefreshFailure(observation: {
    readonly userId: string
    readonly revision: number
    readonly error: unknown
  }): void {
    this.wsTargetedRefreshFailureCount += 1
    this.log.warn('authority-targeted-refresh-failed', {
      userId: observation.userId,
      revision: observation.revision,
      error:
        observation.error instanceof Error ? observation.error.message : String(observation.error),
    })
  }

  snapshot(): IdentityAccessDiagnosticsSnapshot {
    return Object.freeze({
      accessUpdate: Object.freeze({ ...this.accessUpdateCounts }),
      authorityReresolution: this.authorityReresolutionCount,
      invalidStoredGrant: this.invalidStoredGrantCount,
      wsTargetedRefreshFailure: this.wsTargetedRefreshFailureCount,
    })
  }
}

function outcomeKey(
  outcome: AccessUpdateObservation['outcome'],
): keyof IdentityAccessObservability['accessUpdateCounts'] {
  return outcome === 'no-op' ? 'noOp' : outcome
}
