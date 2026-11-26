import type { PersistenceTx } from '@/platform/persistence/persistenceDb'

export interface SubjectTaskReferenceParticipant {
  nonTerminalTaskIds(subject: {
    readonly kind: 'agent' | 'workflow' | 'workgroup'
    readonly sourceId: string
  }): Promise<readonly string[]>
}

export type SubjectTaskReferencePort = (tx: PersistenceTx) => SubjectTaskReferenceParticipant

export type {
  McpDiagnosticExecution,
  McpDiagnosticExecutionFactory,
} from '../application/ports/mcpDiagnosticExecution'
export type { LocalMcpDiagnosticExecution } from '../application/ports/localMcpDiagnosticExecution'
/** RFC-609: implemented by the capability templates' PostgreSQL owner-native arm, taken through its designated adapter. */
export type { CapabilityTemplatePackageMutationOwner } from '../application/ports/capabilityTemplatePackageOwner'
