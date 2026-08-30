import type {
  LocalSystemOperationContext,
  PlanLocalRestoreInput,
  RecoveryStatusView,
  RestorePlanView,
} from './types'
import type { QueryContext } from '@/modules/identity-access/public/participants'

export interface PlanLocalRestoreQuery {
  execute(
    context: LocalSystemOperationContext,
    input: PlanLocalRestoreInput,
  ): Promise<RestorePlanView>
}

export interface GetRecoveryStatusQuery {
  execute(context: QueryContext): RecoveryStatusView
}

export interface SystemOperationQueries {
  readonly planLocalRestore: PlanLocalRestoreQuery
  readonly getRecoveryStatus: GetRecoveryStatusQuery
}
