import { composeFusionResourceSeedParticipant } from '@/modules/resource-catalog/composition/fusionResourceSeed'
import { composeFusionOperationsFor } from '@/modules/knowledge-evolution/composition/fusion'
import { composeSkillMemoryFusionParticipantFactory } from '@/modules/memory/composition'
import { composeSkillVersionCommitParticipantFactory } from '@/modules/resource-catalog/composition/skillVersionCommit'

/** One fusion stack; task execution owns runtime configuration. */
export function composeDaemonFusionModules(
  input: Omit<
    Parameters<typeof composeFusionOperationsFor>[0],
    'memoryMembership' | 'skillVersionCommit' | 'resourceSeed'
  > & {
    readonly skillContent?: NonNullable<
      Parameters<typeof composeSkillVersionCommitParticipantFactory>[0]
    >['skillContent']
  },
) {
  const fusionOperations = composeFusionOperationsFor({
    db: input.db,
    appHome: input.appHome,
    memories: input.memories,
    tasks: input.tasks,
    resourceSeed: composeFusionResourceSeedParticipant(),
    memoryMembership: composeSkillMemoryFusionParticipantFactory(),
    skillVersionCommit: composeSkillVersionCommitParticipantFactory({
      skillContent: input.skillContent,
    }),
  })
  return Object.freeze({
    fusionOperations,
  })
}
export type DaemonFusionModules = ReturnType<typeof composeDaemonFusionModules>
