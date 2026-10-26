import { collectReadOnlyProbes } from '@/platform/persistence/migration/run/probes'
// RFC-395 II-b: CLI-only conversion assembly; the migration caller supplies the frozen source and sink.
import { taskConversion, runConversion } from '@/modules/task-execution/composition/conversion'
import { conversion as collaborationConversion } from '@/modules/collaboration/composition/conversion'
import {
  createSkillBootConversion,
  skillBootEnvironment,
  readOnlyProbes as resourceProbes,
} from '@/modules/resource-catalog/composition/conversion'
import { convertFrozenSkillContent } from '@/platform/content/migration/skillContent'
import {
  conversion as sourceControlBoot,
  repositoryUrlEnvironment,
  type RepositoryUrlKeyProvider,
} from '@/modules/source-control/composition/conversion'
import { conversion as fusionBoot } from '@/modules/knowledge-evolution/composition/conversion'
import { conversion as memoryBoot } from '@/modules/memory/composition/conversion'
import {
  conversion as scheduleBoot,
  scheduledPayloadEnvironment,
} from '@/modules/integration/composition/conversion'
import {
  conversion as runtimeBoot,
  runtimeConfigEnvironment,
} from '@/modules/runtime-management/composition/conversion'
import { createBootUpgradeEnvironment } from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'
import { readOnlyProbes as taskProbes } from '@/modules/task-execution/composition/conversion'
import { readOnlyProbes as collaborationProbes } from '@/modules/collaboration/composition/conversion'
import { readOnlyProbes as intentProbes } from '@/modules/intent/composition/conversion'
import { readOnlyProbes as contentProbes } from '@/platform/content/migration/probes'
import { readOnlyProbes as historyProbes } from '@/modules/code-capability/composition/conversion'
import { conversion as resourceConversion } from '@/modules/resource-catalog/composition/conversion'
import { conversion as intentConversion } from '@/modules/intent/composition/conversion'
import { conversion as contentConversion } from '@/platform/content/migration'
import { conversion as archiveConversion } from '@/platform/persistence/migration/archives'
import { conversion as genericConversion } from '@/platform/persistence/migration/conversion/generic'
import { conversion as alignmentConversion } from '@/platform/persistence/migration/conversion/alignment'
import type { ConversionInput } from '@/platform/persistence/migration/conversion/plan'
import { persistenceSchema } from './persistenceSchema'
import targetRoster from './targetSchemaRoster.json'

export const conversionContributions = [
  sourceControlBoot,
  fusionBoot,
  memoryBoot,
  scheduleBoot,
  runtimeBoot,
  createSkillBootConversion(convertFrozenSkillContent),
  taskConversion,
  runConversion,
  collaborationConversion,
  resourceConversion,
  intentConversion,
  contentConversion,
  archiveConversion,
  genericConversion,
  alignmentConversion,
] as const
export function composeConversionInput(
  input: Omit<ConversionInput, 'target' | 'targetRoster' | 'contributions'>,
): ConversionInput {
  return {
    ...input,
    target: persistenceSchema,
    targetRoster,
    contributions: conversionContributions,
  }
}

export const conversionReadOnlyProbes = collectReadOnlyProbes([
  { owner: 'task-execution', probes: taskProbes },
  { owner: 'collaboration', probes: collaborationProbes },
  { owner: 'resource-catalog', probes: resourceProbes },
  { owner: 'intent', probes: intentProbes },
  { owner: 'platform/content', probes: contentProbes },
  { owner: 'code-capability', probes: historyProbes },
])

export function composeBootUpgradeEnvironment(keys: RepositoryUrlKeyProvider) {
  return createBootUpgradeEnvironment([
    repositoryUrlEnvironment(keys),
    skillBootEnvironment(),
    scheduledPayloadEnvironment(),
    runtimeConfigEnvironment(),
  ])
}
