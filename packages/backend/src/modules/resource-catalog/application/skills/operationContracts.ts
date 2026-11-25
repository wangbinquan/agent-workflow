// RFC-581 — the skill operation descriptors, file / version command ports, zip import participant and their catalog
// inputs / receipts. They left `public/` with the skill HTTP binding (now `inbound/http/skillRoutes.ts`).
import type {
  CommandOperationDescriptor,
  QueryOperationDescriptor,
} from '@/platform/operations/contracts'
import type {
  CommitSkillZipResponse,
  FileNode,
  ParseSkillZipResponse,
  Skill,
  SkillZipDecisionMap,
} from '@agent-workflow/shared'
import type { ResourceAclOperationDescriptors } from '../../public/operations'
import type { SkillOperationContext } from '../../public/participants'
import type {
  DiffSkillVersionsCatalogInput,
  GetSkillCatalogInput,
  GetSkillContentCatalogInput,
  GetSkillVersionContentCatalogInput,
  JsonBodySubmission,
  ListSkillFilesCatalogInput,
  ListSkillVersionsCatalogInput,
  ReadSkillFileCatalogInput,
  SkillCatalogContent,
  SkillCatalogResource,
  SkillCatalogVersion,
  SkillCatalogVersionContent,
  SkillCatalogVersionDiff,
} from '../../public/types'

interface SkillJsonSubmission {
  readonly kind: 'json-body'
  readonly body: string
}

export interface CreateSkillCatalogInput {
  readonly submission: JsonBodySubmission
}

export interface SaveSkillCatalogInput {
  readonly id: string
  readonly submission: JsonBodySubmission
}

export interface DeleteSkillCatalogInput {
  readonly id: string
  readonly submission: JsonBodySubmission
}

export interface DeleteSkillCatalogReceipt {
  readonly deleted: Skill
}

export interface WriteSkillFileCatalogInput {
  readonly id: string
  readonly path: string
  readonly submission: SkillJsonSubmission
}

export interface WriteSkillFileCatalogReceipt {
  readonly ok: true
  readonly path: string
  readonly token: string | null
}

export interface DeleteSkillFileCatalogInput {
  readonly id: string
  readonly path: string
  readonly expectedToken?: string
  readonly submission: SkillJsonSubmission
}

export interface DeleteSkillFileCatalogReceipt {
  readonly deleted: Readonly<{
    readonly skillId: string
    readonly name: string
    readonly path: string
  }>
  readonly token: string | null
}

export interface RestoreSkillVersionCatalogInput {
  readonly id: string
  readonly version: string
  readonly submission: SkillJsonSubmission
}

export interface RestoreSkillVersionCatalogReceipt {
  readonly version: SkillCatalogVersion
  readonly unfusedMemoryIds: readonly string[]
  readonly token: string | null
}

/** Closed transport envelope; archive bytes never expose a runtime buffer type. */
export interface SkillZipArchiveSubmission {
  readonly encoding: 'base64'
  readonly content: string
}

export interface ParseSkillZipCatalogInput {
  readonly archive: SkillZipArchiveSubmission
}

export type ParseSkillZipCatalogReceipt = ParseSkillZipResponse

export interface CommitSkillZipCatalogInput {
  readonly archive: SkillZipArchiveSubmission
  readonly decisions: SkillZipDecisionMap
}

export type CommitSkillZipCatalogReceipt = CommitSkillZipResponse

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

/** Provider-bound whole-tree ZIP import; route owns only multipart decoding. */
export interface SkillZipImportParticipant {
  parse(
    authority: SkillOperationContext,
    input: ParseSkillZipCatalogInput,
  ): Promise<ParseSkillZipCatalogReceipt>
  commit(
    authority: SkillOperationContext,
    input: CommitSkillZipCatalogInput,
  ): Promise<CommitSkillZipCatalogReceipt>
}

export interface SkillOperationDescriptors extends ResourceAclOperationDescriptors<SkillOperationContext> {
  readonly list: QueryOperationDescriptor<
    Record<never, never>,
    SkillCatalogResource[],
    SkillOperationContext
  >
  readonly get: QueryOperationDescriptor<
    GetSkillCatalogInput,
    SkillCatalogResource | null,
    SkillOperationContext
  >
  readonly create: CommandOperationDescriptor<
    CreateSkillCatalogInput,
    SkillCatalogResource,
    SkillOperationContext
  >
  readonly save: CommandOperationDescriptor<
    SaveSkillCatalogInput,
    SkillCatalogContent,
    SkillOperationContext
  >
  readonly delete: CommandOperationDescriptor<
    DeleteSkillCatalogInput,
    DeleteSkillCatalogReceipt,
    SkillOperationContext
  >
  readonly content: QueryOperationDescriptor<
    GetSkillContentCatalogInput,
    SkillCatalogContent,
    SkillOperationContext
  >
  readonly listFiles: QueryOperationDescriptor<
    ListSkillFilesCatalogInput,
    FileNode[],
    SkillOperationContext
  >
  readonly readFile: QueryOperationDescriptor<
    ReadSkillFileCatalogInput,
    Readonly<{ path: string; content: string }>,
    SkillOperationContext
  >
  readonly writeFile: CommandOperationDescriptor<
    WriteSkillFileCatalogInput,
    WriteSkillFileCatalogReceipt,
    SkillOperationContext
  >
  readonly deleteFile: CommandOperationDescriptor<
    DeleteSkillFileCatalogInput,
    DeleteSkillFileCatalogReceipt,
    SkillOperationContext
  >
  readonly listVersions: QueryOperationDescriptor<
    ListSkillVersionsCatalogInput,
    SkillCatalogVersion[],
    SkillOperationContext
  >
  readonly diffVersions: QueryOperationDescriptor<
    DiffSkillVersionsCatalogInput,
    SkillCatalogVersionDiff,
    SkillOperationContext
  >
  readonly getVersionContent: QueryOperationDescriptor<
    GetSkillVersionContentCatalogInput,
    SkillCatalogVersionContent,
    SkillOperationContext
  >
  readonly restoreVersion: CommandOperationDescriptor<
    RestoreSkillVersionCatalogInput,
    RestoreSkillVersionCatalogReceipt,
    SkillOperationContext
  >
}
