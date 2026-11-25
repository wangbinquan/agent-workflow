import type { CommandContext } from '@/modules/identity-access/public/participants'
import type {
  CancelMcpDiagnosticsTurnInput,
  McpDiagnosticsSessionRef,
  McpRuntimeTestCreateReceipt,
  McpRuntimeTestMessageReceipt,
  McpRuntimeTestMutationReceipt,
  StartMcpDiagnosticsInput,
  SubmitMcpDiagnosticsTurnInput,
} from './types'
import type { SkillOperationContext } from './participants'
import type {
  DeleteSkillFileCatalogInput,
  DeleteSkillFileCatalogReceipt,
  RestoreSkillVersionCatalogInput,
  RestoreSkillVersionCatalogReceipt,
  WriteSkillFileCatalogInput,
  WriteSkillFileCatalogReceipt,
} from './types'

export interface SkillFileCommands {
  write(
    authority: SkillOperationContext,
    input: WriteSkillFileCatalogInput,
  ): Promise<WriteSkillFileCatalogReceipt>
  delete(
    authority: SkillOperationContext,
    input: DeleteSkillFileCatalogInput,
  ): Promise<DeleteSkillFileCatalogReceipt>
}

export interface SkillVersionCommands {
  restore(
    authority: SkillOperationContext,
    input: RestoreSkillVersionCatalogInput,
  ): Promise<RestoreSkillVersionCatalogReceipt>
}

export interface PluginGenerationGcInput {
  /** The platform runtime owns this coarse active-execution fence. */
  readonly executionFence: 'clear' | 'busy'
  readonly graceMs?: number
  readonly now?: number
}

export interface PluginGenerationGcReceipt {
  readonly removedGenerationPaths: readonly string[]
}

/** Provider-neutral maintenance command; persistence and filesystem stay private. */
export interface PluginGenerationGcCommand {
  run(input: PluginGenerationGcInput): Promise<PluginGenerationGcReceipt>
}

export interface McpDiagnosticsCommands {
  start(
    context: CommandContext,
    input: StartMcpDiagnosticsInput,
  ): Promise<McpRuntimeTestCreateReceipt>
  submitTurn(
    context: CommandContext,
    input: SubmitMcpDiagnosticsTurnInput,
  ): Promise<McpRuntimeTestMessageReceipt>
  cancel(
    context: CommandContext,
    input: CancelMcpDiagnosticsTurnInput,
  ): Promise<McpRuntimeTestMutationReceipt>
  end(
    context: CommandContext,
    input: McpDiagnosticsSessionRef,
  ): Promise<McpRuntimeTestMutationReceipt>
}
