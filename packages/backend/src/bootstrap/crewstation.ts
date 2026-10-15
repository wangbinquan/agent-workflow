import { z } from 'zod'
import type { StartOptions } from '@/cli/start'
import { composeCrewStationCredentialAdapters } from '@/modules/identity-access/composition/authentication'
import { composeCrewStationResourceContent } from '@/modules/resource-catalog/composition/skillContentBinding'
import {
  AW_TASK_CONTRACT_VERSION,
  composeCrewStationSystemSelections,
  prepareCrewStationDatabase,
  readCrewStationEnvironment,
} from '@/modules/system-operations/composition/crewstationDeployment'
import { createCrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import { createCrewStationObjectStorage } from '@/platform/crewstation/objectStorage'
import { composeCrewStationWorkspaceOwner } from '@/modules/source-control/composition/crewstationWorkspace'
import { composeCrewStationExecutionOwner } from '@/modules/task-execution/composition/crewstationExecution'
import { composeLocalTaskAgentRuntimeBindings } from '@/modules/runtime-management/composition/taskAgentRuntimeBindings'
import { DomainError } from '@/util/errors'
import { composeLocalSystemAgentRunFamily } from '@/modules/task-execution/composition/localSystemAgentRunFamily'
import { selectExecutionInitialization } from './executionInitialization'

const Profiles = z
  .array(
    z.object({
      protocol: z.enum(['opencode', 'claude-code']),
      model: z.string().nullable(),
      agentProfileId: z.string().uuid(),
    }),
  )
  .min(1)

/** The only hosted assembly root. Business applications consume the same
 * owner ports as standalone; no deployment branch enters a task or engine. */
export async function composeCrewStationStartOptions(
  env: Readonly<Record<string, string | undefined>>,
): Promise<StartOptions> {
  const environment = readCrewStationEnvironment(env)
  if (environment.objectsUrl === null)
    throw new Error('CS_OBJECTS_URL is required for hosted task artifacts')
  const profiles = Profiles.parse(JSON.parse(env.AW_AGENT_PROFILES ?? '[]'))
  const profileKeys = profiles.map((profile) => `${profile.protocol}:${profile.model ?? ''}`)
  if (new Set(profileKeys).size !== profileKeys.length)
    throw new Error('AW_AGENT_PROFILES contains duplicate runtime/model mappings')
  const prepared = await prepareCrewStationDatabase({ environment, schema: 'verify', env })
  const db = prepared.openBootstrapClient()
  const system = composeCrewStationSystemSelections({ environment, prepared })
  const initialized = selectExecutionInitialization(system.executionAuthority)
  const fence = system.mutationFence
  const api = createCrewStationBusinessExecution(system.platform)
  const objects = createCrewStationObjectStorage({ baseUrl: environment.objectsUrl, fence })
  const resources = composeCrewStationResourceContent({ db })
  const workspace = composeCrewStationWorkspaceOwner({
    db,
    api,
    fence,
    secretBox: system.secretBox,
    installation: `${environment.project}/${environment.service}`,
    taskContractVersion: AW_TASK_CONTRACT_VERSION,
  })
  const execution = composeCrewStationExecutionOwner({
    db,
    fence,
    api,
    objects,
    profiles,
    workspaces: workspace.workspaces,
    locate: workspace.locate,
    reference: workspace.reference,
    skills: resources.resourcePackageSkillContent,
    runtimeBindingsFor: (binding) =>
      composeLocalTaskAgentRuntimeBindings({
        persistence: binding.nodeRunRuntime,
        registry: binding.runtimeRegistry,
        readBinaryConfiguration: async () => undefined,
      }).bindings,
  })
  return {
    host: '0.0.0.0',
    port: environment.port,
    applicationConfiguration: system.applicationConfiguration,
    databaseInstallation: system.databaseInstallation,
    executionAuthority: {
      ...initialized.authority,
      unavailableGroups: {
        intent: 'System Agent execution is available with RFC-370 M2.',
        purpose: 'System Agent execution is available with RFC-370 M2.',
        diagnostics: 'Runtime and MCP diagnostics are available with RFC-370 M2.',
        verification: 'Verification execution is available with RFC-370 M2.',
        memory: 'Memory distillation is available with RFC-370 M2.',
        development: 'Development automation is available with RFC-370 M2.',
        'digital-employee': 'Digital employee execution is available with RFC-370 M2.',
        knowledge: 'Knowledge evolution execution is available with RFC-370 M2.',
        'event-dispatch': 'Platform event execution is available with RFC-370 M3.',
        maintenance: 'Hosted backup and restore are available with RFC-370 M3.',
      },
    },
    initializeExecution: initialized.initialize,
    ...execution.selections,
    secretBox: system.secretBox,
    credentials: composeCrewStationCredentialAdapters({
      jwksUrl: environment.jwksUrl,
      project: environment.project,
      service: environment.service,
      administratorSubjects: environment.adminSubjects,
    }),
    executionHost: 'remote',
    ...resources,
    ...workspace.bind(execution.helper),
    systemAgentRunFamily(options) {
      // M1 selects an explicitly unavailable family for all system callers,
      // including background calls that do not pass through HTTP admission.
      const binding = composeLocalSystemAgentRunFamily(options)
      const family = {
        ...binding.family,
        async run(): Promise<never> {
          throw new DomainError(
            'hosted-capability-unavailable',
            'System Agent execution requires RFC-370 M2',
            503,
          )
        },
      }
      return {
        ...binding,
        family,
        withFixture: () => ({ family, bindRuntime: binding.bindRuntime }),
      }
    },
  }
}
