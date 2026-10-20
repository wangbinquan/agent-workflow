import { runtimeConfigOpts } from '@/services/task'
import { composeFusionOperationsFor } from '@/modules/knowledge-evolution/composition/fusion'
import { composeSkillMemoryFusionParticipantFactory } from '@/modules/memory/composition'
import { composeSkillVersionCommitParticipantFactory } from '@/modules/resource-catalog/composition/skillVersionCommit'
import type { composeTaskLaunchConfiguration } from '@/modules/task-execution/composition/launchConfiguration'

/** One fusion stack; routes and the provider task adapter share the live session reader. */
export function composeDaemonFusionModules(
  input: Omit<
    Parameters<typeof composeFusionOperationsFor>[0],
    'memoryMembership' | 'skillVersionCommit'
  > & {
    readonly skillContent?: NonNullable<
      Parameters<typeof composeSkillVersionCommitParticipantFactory>[0]
    >['skillContent']
    readonly taskLaunchConfiguration: ReturnType<typeof composeTaskLaunchConfiguration>
    readonly configPath?: string
    readonly daemonGeneration?: string
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
    async runConfiguration() {
      const fresh = await input.taskLaunchConfiguration.start()
      return Object.freeze({
        appHome: input.appHome,
        ...(input.configPath === undefined ? {} : { configPath: input.configPath }),
        ...(input.daemonGeneration === undefined
          ? {}
          : { daemonGeneration: input.daemonGeneration }),
        ...(fresh.subagentLiveCapture === undefined
          ? {}
          : { subagentLiveCapture: fresh.subagentLiveCapture }),
        ...runtimeConfigOpts(fresh),
      })
    },
  })
}
export type DaemonFusionModules = ReturnType<typeof composeDaemonFusionModules>
