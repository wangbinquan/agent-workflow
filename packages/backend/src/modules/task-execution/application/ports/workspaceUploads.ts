import type { UploadFile, UploadInputDef, UploadLimits } from '../../domain/uploads'
import type { WorkspaceUploadBinding } from '@/modules/source-control/public/types'

export interface WorkspaceUploadPlan {
  readonly workspace: WorkspaceUploadBinding
  readonly inputsSubdir?: string
  readonly defs: ReadonlyMap<string, UploadInputDef>
  readonly files: readonly UploadFile[]
  readonly limits: UploadLimits
  /** Task-owned placement journal; its durable ACK precedes the content write. */
  readonly recovery?: {
    placement(index: number): string | null
    reserve(index: number, filename: string): Promise<void>
  }
}

export interface WorkspaceUploadResult {
  readonly packedByKey: ReadonlyMap<string, readonly string[]>
}
