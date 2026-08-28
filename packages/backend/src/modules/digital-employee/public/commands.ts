import type { DbClient } from '@/db/client'
import { createEmployeeInputUploadStore } from '../infrastructure/inputUploadStore'
import type {
  DigitalEmployeeResourceReceipt,
  EmployeeCaseLaunchInput,
  EmployeeCaseProjectionDocument,
  EmployeeTypeRef,
  ExactResourceRef,
} from './types'

/** Platform maintenance command; keeps the SQLite adapter behind this context's public edge. */
export function sweepExpiredEmployeeInputUploads(db: DbClient, now: number, limit: number): number {
  return createEmployeeInputUploadStore(db).sweepExpired(now, limit)
}

export type DigitalEmployeeAuthoringCommand =
  | {
      readonly kind: 'tool.register'
      readonly typeRef: EmployeeTypeRef
      readonly workItemRef: string
      readonly commandJson: string
      readonly actorUserId: string | null
    }
  | {
      readonly kind: 'tool.validate' | 'tool.retire'
      readonly typeRef: EmployeeTypeRef
      readonly workItemRef: string
      readonly resourceRef: ExactResourceRef
    }
  | {
      readonly kind: 'tool.publish'
      readonly typeRef: EmployeeTypeRef
      readonly workItemRef: string
      readonly resourceRef: ExactResourceRef
      readonly actorUserId: string | null
    }
  | {
      readonly kind: 'job-template.create'
      readonly typeRef: EmployeeTypeRef
      readonly commandJson: string
      readonly actorUserId: string | null
    }
  | {
      readonly kind: 'job-template.update'
      readonly resourceRef: ExactResourceRef
      readonly commandJson: string
    }
  | {
      readonly kind: 'job-template.publish'
      readonly resourceRef: ExactResourceRef
      readonly actorUserId: string | null
    }
  | {
      readonly kind: 'employee.create'
      readonly typeRef: EmployeeTypeRef
      readonly commandJson: string
      readonly actorUserId: string | null
    }
  | {
      readonly kind: 'employee.update'
      readonly resourceRef: ExactResourceRef
      readonly commandJson: string
      readonly actorUserId: string | null
    }
  | {
      readonly kind: 'execution-policy.publish'
      readonly commandJson: string
      readonly actorUserId: string | null
    }

export interface DigitalEmployeeCommandPort {
  execute(command: DigitalEmployeeAuthoringCommand): Promise<DigitalEmployeeResourceReceipt>
}

export interface EmployeeCaseCommandPort {
  launch(input: EmployeeCaseLaunchInput): EmployeeCaseProjectionDocument
  requestPolicyUpgrade(caseId: string, targetPolicyRevision: number): string
  applyPolicyUpgrade(previewToken: string): EmployeeCaseProjectionDocument
  terminate(caseId: string, terminalKind: string): EmployeeCaseProjectionDocument
}
