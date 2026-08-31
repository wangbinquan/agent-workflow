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
