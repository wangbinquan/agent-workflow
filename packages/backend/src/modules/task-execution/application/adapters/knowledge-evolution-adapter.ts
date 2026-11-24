// RFC-560 (RFC-294 S9 step 15): Task Execution's designated adapter for Knowledge Evolution's consumer-owned required
// ports (`@/modules/knowledge-evolution/composition/required-ports`, type-only). Task Execution implements the fusion
// engine task operations in `infrastructure/fusionEngineTaskOperations.ts`.
export type {
  FusionEngineTaskLaunch,
  FusionEngineTaskOperations,
} from '@/modules/knowledge-evolution/composition/required-ports'
