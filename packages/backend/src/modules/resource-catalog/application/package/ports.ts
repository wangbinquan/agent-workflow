import type { CommandContext } from '@/modules/identity-access/public/participants'

export interface ResourcePackageExportReceipt {
  readonly packageId: string
  readonly filename: string
}

/**
 * Composition-owned execution adapter. Handles identify one-shot, privately
 * staged transport material; neither bytes nor credentials enter application
 * DTOs.
 */
export interface ResourcePackageExecutionPort {
  inspect(context: CommandContext, handle: string): Promise<string>
  apply(context: CommandContext, handle: string): Promise<string>
  export(context: CommandContext, handle: string): Promise<ResourcePackageExportReceipt>
}

export interface ResourcePackageResultIdFactory {
  next(): string
}
