import type { Actor } from '@/auth/actor'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { DirectAuthorityAdmission } from '@/modules/identity-access/public/participants'

/** RFC-370 §9.2 V4 — the deployment selects a platform recovery consumer; the
 * provider graph supplies only the ordinary business commands it calls. */
export interface TaskRecoveryProviderContext {
  readonly db: PersistenceDb
  /** The ordinary resume command, as the given actor. */
  readonly resumeTaskAs: (actor: Actor, taskId: string) => Promise<void>
  readonly assertManualExecutionAllowed: (actor: Actor, taskId: string) => Promise<void>
}

export type TaskRecoveryProviderSelection = (context: TaskRecoveryProviderContext) => {
  tick(): Promise<void>
}
export type TaskRecoveryDeploymentSelection = (identityAccess: {
  readonly directAuthority: DirectAuthorityAdmission
}) => TaskRecoveryProviderSelection
