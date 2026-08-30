import type {
  LocalSystemOperationContext,
  PlanLocalRestoreInput,
  RecoveryStatusView,
  RestorePlanView,
  SystemOperationQueryContext,
} from './types'

export interface PlanLocalRestoreQuery {
  execute(
    context: LocalSystemOperationContext,
    input: PlanLocalRestoreInput,
  ): Promise<RestorePlanView>
}

export interface GetRecoveryStatusQuery {
  execute(context: SystemOperationQueryContext): RecoveryStatusView
}

export interface SystemOperationQueries {
  readonly planLocalRestore: PlanLocalRestoreQuery
  readonly getRecoveryStatus: GetRecoveryStatusQuery
}
