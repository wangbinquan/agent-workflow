// RFC-552 (RFC-294 S9): the ports the fusion orchestration runs on. It sat on `public/participants`; once the maintenance
// functions left the public entry no other module read it.
import type { MemoryCatalogOperations } from '@/modules/memory/public/operations'
import type { SkillTreeVersionOperations } from '@/modules/resource-catalog/public/participants'
import type { FusionEngineTaskOperations } from './fusionEngineTasks'
import type { FusionPersistence } from './fusionPersistence'

export interface FusionOperations {
  readonly persistence: FusionPersistence
  readonly memories: MemoryCatalogOperations
  readonly tasks: FusionEngineTaskOperations
  /** Seeds (strict version trees) and proposal candidates of the selected skill storage. */
  readonly skillTrees: SkillTreeVersionOperations
}
