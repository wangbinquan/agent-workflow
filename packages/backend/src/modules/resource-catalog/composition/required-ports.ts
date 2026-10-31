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
