import type { IsoHandle } from '@/platform/contracts/isolationWorkspace'
import type {
  IsolationRestoreInput,
  IsolationWorkspaceScope,
} from '@/modules/source-control/public/types'

/** One isolation workspace session per mechanics state (RFC-402); construction stays in infrastructure. */
export interface ExecutionWorkspaceSession {
  scope(): Promise<IsolationWorkspaceScope>
  restore(input: IsolationRestoreInput): Promise<IsoHandle>
}
