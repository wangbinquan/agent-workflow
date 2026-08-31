import { NotFoundError } from '@/util/errors'
import type { CommandContext, QueryContext } from '@/modules/identity-access/public/participants'
import type {
  ApplyResourcePackage,
  ExportResourcePackage,
  InspectResourcePackage,
} from '../../public/types'
import type {
  ResourcePackageExecutionPort,
  ResourcePackageExportReceipt,
  ResourcePackageResultIdFactory,
} from './ports'

interface ResourcePackagePreviewReceipt {
  readonly previewId: string
}

interface GetResourcePackagePreview {
  readonly previewId: string
}

interface ResourcePackagePreviewView {
  readonly previewId: string
  readonly document: string
}

interface ResourcePackageApplyReceipt {
  readonly receiptId: string
}

interface GetResourcePackageApplyReceipt {
  readonly receiptId: string
}

interface ResourcePackageApplyReceiptView {
  readonly receiptId: string
  readonly document: string
}

export interface ResourcePackageApplicationDependencies {
  readonly execution: ResourcePackageExecutionPort
  readonly ids: ResourcePackageResultIdFactory
}

interface ResourcePackageCommands {
  inspect(
    context: CommandContext,
    input: InspectResourcePackage,
  ): Promise<ResourcePackagePreviewReceipt>
  apply(context: CommandContext, input: ApplyResourcePackage): Promise<ResourcePackageApplyReceipt>
  export(
    context: CommandContext,
    input: ExportResourcePackage,
  ): Promise<ResourcePackageExportReceipt>
}

interface ResourcePackageQueries {
  getPreview(
    context: QueryContext,
    input: GetResourcePackagePreview,
  ): Promise<ResourcePackagePreviewView>
  getReceipt(
    context: QueryContext,
    input: GetResourcePackageApplyReceipt,
  ): Promise<ResourcePackageApplyReceiptView>
}

export interface ResourcePackageApplication {
  readonly commands: ResourcePackageCommands
  readonly queries: ResourcePackageQueries
}

export function createResourcePackageApplication(
  deps: ResourcePackageApplicationDependencies,
): ResourcePackageApplication {
  const previews = new Map<string, string>()
  const receipts = new Map<string, string>()

  const commands: ResourcePackageCommands = Object.freeze({
    async inspect(
      context: CommandContext,
      input: InspectResourcePackage,
    ): Promise<ResourcePackagePreviewReceipt> {
      const document = await deps.execution.inspect(context, input.submission.handle)
      const previewId = deps.ids.next()
      previews.set(previewId, document)
      return Object.freeze({ previewId })
    },
    async apply(
      context: CommandContext,
      input: ApplyResourcePackage,
    ): Promise<ResourcePackageApplyReceipt> {
      const document = await deps.execution.apply(context, input.submission.handle)
      const receiptId = deps.ids.next()
      receipts.set(receiptId, document)
      return Object.freeze({ receiptId })
    },
    async export(
      context: CommandContext,
      input: ExportResourcePackage,
    ): Promise<ResourcePackageExportReceipt> {
      return deps.execution.export(context, input.submission.handle)
    },
  })

  const queries: ResourcePackageQueries = Object.freeze({
    async getPreview(
      _context: QueryContext,
      input: GetResourcePackagePreview,
    ): Promise<ResourcePackagePreviewView> {
      const document = previews.get(input.previewId)
      if (document === undefined) {
        throw new NotFoundError(
          'resource-package-preview-not-found',
          `resource package preview '${input.previewId}' not found`,
        )
      }
      previews.delete(input.previewId)
      return Object.freeze({ previewId: input.previewId, document })
    },
    async getReceipt(
      _context: QueryContext,
      input: GetResourcePackageApplyReceipt,
    ): Promise<ResourcePackageApplyReceiptView> {
      const document = receipts.get(input.receiptId)
      if (document === undefined) {
        throw new NotFoundError(
          'resource-package-receipt-not-found',
          `resource package receipt '${input.receiptId}' not found`,
        )
      }
      receipts.delete(input.receiptId)
      return Object.freeze({ receiptId: input.receiptId, document })
    },
  })

  return Object.freeze({ commands, queries })
}
