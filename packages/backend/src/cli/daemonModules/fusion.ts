import { composeFusionOperationsFor } from '@/modules/knowledge-evolution/composition/fusion'
import { composeSkillMemoryFusionParticipantFactory } from '@/modules/memory/composition'
import { composeSkillVersionCommitParticipantFactory } from '@/modules/resource-catalog/composition/skillVersionCommit'
import type { composeTaskLaunchConfiguration } from '@/modules/task-execution/composition/launchConfiguration'

/** One fusion stack; task execution owns runtime configuration. */
export function composeDaemonFusionModules(
  input: Omit<
    Parameters<typeof composeFusionOperationsFor>[0],
    'memoryMembership' | 'skillVersionCommit'
  > & {
    readonly skillContent?: NonNullable<
      Parameters<typeof composeSkillVersionCommitParticipantFactory>[0]
    >['skillContent']
    readonly configPath?: string
    readonly taskLaunchConfiguration: ReturnType<typeof composeTaskLaunchConfiguration>
  },
) {
  const fusionOperations = composeFusionOperationsFor({
    db: input.db,
    appHome: input.appHome,
    memories: input.memories,
    tasks: input.tasks,
    memoryMembership: composeSkillMemoryFusionParticipantFactory(),
    skillVersionCommit: composeSkillVersionCommitParticipantFactory({
      skillContent: input.skillContent,
    }),
  })
  return Object.freeze({
    fusionOperations,
    launchConfiguration: input.taskLaunchConfiguration.continuationQueries,
  })
}
export type DaemonFusionModules = ReturnType<typeof composeDaemonFusionModules>
