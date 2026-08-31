import type {
  CombinedSaveSkill,
  CreateManagedSkill,
  DeleteSkill,
  RestoreSkillVersion,
  Skill,
  WriteSkillFile,
} from '@agent-workflow/shared'
import type { ActorSource } from '@/auth/actor'
import type { SkillOperationContext } from '../../public/participants'
import type {
  DeleteSkillFileCatalogReceipt,
  RestoreSkillVersionCatalogReceipt,
  SkillCatalogContent,
  SkillCatalogFileNode,
  SkillCatalogVersion,
  SkillCatalogVersionContent,
  SkillCatalogVersionDiff,
  WriteSkillFileCatalogReceipt,
} from '../../public/types'

export interface SkillRepository {
  list(): Promise<readonly Skill[]>
  get(id: string): Promise<Skill | null>
  create(authority: SkillOperationContext, input: CreateManagedSkill): Promise<Skill>
  save(
    authority: SkillOperationContext,
    current: Skill,
    input: CombinedSaveSkill,
  ): Promise<SkillCatalogContent>
  delete(authority: SkillOperationContext, current: Skill, input: DeleteSkill): Promise<void>
  readContent(id: string): Promise<SkillCatalogContent>
  listFiles(id: string): Promise<readonly SkillCatalogFileNode[]>
  readFile(id: string, path: string): Promise<string>
  writeFile(
    authority: SkillOperationContext,
    current: Skill,
    path: string,
    input: WriteSkillFile,
  ): Promise<WriteSkillFileCatalogReceipt>
  deleteFile(
    authority: SkillOperationContext,
    current: Skill,
    path: string,
    expectedToken: string | undefined,
  ): Promise<DeleteSkillFileCatalogReceipt>
  listVersions(id: string): readonly SkillCatalogVersion[]
  diffVersions(id: string, from: number, to: number): SkillCatalogVersionDiff
  getVersionContent(id: string, version: number): SkillCatalogVersionContent
  restoreVersion(
    authority: SkillOperationContext,
    current: Skill,
    version: number,
    input: RestoreSkillVersion,
  ): Promise<RestoreSkillVersionCatalogReceipt>
}

export interface SkillAccessPort {
  filterVisible(authority: SkillOperationContext, rows: readonly Skill[]): Promise<readonly Skill[]>
  canView(authority: SkillOperationContext, row: Skill): Promise<boolean>
  requireResourceEdit(authority: SkillOperationContext, row: Skill): Promise<void>
  requireResourceGovern(authority: SkillOperationContext, row: Skill): Promise<void>
}

export interface SkillDeleteConfirmationPort {
  assertResource(body: unknown, expectedName: string): void
  assertFile(body: unknown, expectedPath: string, source: ActorSource): void
}

export interface SkillMutationClock {
  nextUpdatedAt(skill: Skill): number
}
