import type { AgentMaterialIntent } from '@/modules/runtime-management/public/participants'
import type {
  AgentInvocationPreparation,
  CompiledAgentInvocation,
} from '../application/ports/agentInvocationPreparation'
import type {
  TaskAgentMaterialPreparation,
  TaskCompiledAgentInvocation,
} from '../application/ports/taskAgentMaterial'

/** Selected resource owners supply ordered references. They interpret their
 * own locations/readers; no physical resource or fixture field crosses here. */
export interface TaskAgentMaterialResources {
  readonly injection: Pick<AgentMaterialIntent['injection'], 'skills' | 'plugins'>
  readonly runtimeBinding?: AgentMaterialIntent['runtimeBinding']
  prepareMounts(): AgentMaterialIntent['taskMounts']
}

/** The same selected material owner projects its actual MCP declarations and
 * load diagnostics. Core receives closed observations, never raw diagnostics. */
export interface TaskAgentMaterialDiagnostics {
  readDeclaredMcpServers(compiled: CompiledAgentInvocation): readonly string[] | undefined
  reportSpawn(
    compiled: CompiledAgentInvocation,
    ...input: Parameters<TaskCompiledAgentInvocation['reportSpawn']>
  ): void
  detectPluginLoadFailure(
    compiled: CompiledAgentInvocation,
    line: string,
  ): { pluginName: string; message: string } | null
}

function selectedInjectionResources(
  references: TaskAgentMaterialResources['injection'],
): TaskAgentMaterialResources['injection'] {
  return {
    ...('plugins' in references ? { plugins: references.plugins } : {}),
    ...('skills' in references ? { skills: references.skills } : {}),
  }
}

/** Complete normal preparation: one full intent, one selected compile and
 * the existing late bind. Creation invokes no resource or diagnostic member. */
export function createTaskAgentMaterialPreparation(input: {
  readonly preparation: AgentInvocationPreparation
  readonly resources: TaskAgentMaterialResources
  readonly diagnostics: TaskAgentMaterialDiagnostics
}): TaskAgentMaterialPreparation {
  let taskMounts: AgentMaterialIntent['taskMounts']
  return {
    prepareMounts() {
      taskMounts = input.resources.prepareMounts()
    },
    async compile(declaration) {
      const resources = input.resources
      const preparation = input.preparation
      const injection = {
        mcps: declaration.injection.mcps,
        ...('agent' in declaration.injection ? { agent: declaration.injection.agent } : {}),
        ...('dependents' in declaration.injection
          ? { dependents: declaration.injection.dependents }
          : {}),
        ...selectedInjectionResources(resources.injection),
        ...('profile' in declaration.injection ? { profile: declaration.injection.profile } : {}),
      }
      const compiled = await preparation.compile({
        protocol: declaration.protocol,
        injection,
        prompt: declaration.prompt,
        agentName: declaration.agentName,
        systemPrompt: declaration.systemPrompt,
        ...('injectedMemoryBlock' in declaration
          ? { injectedMemoryBlock: declaration.injectedMemoryBlock }
          : {}),
        resolvedProfiles: declaration.resolvedProfiles,
        workspace: preparation.workspace.workspace,
        runContent: preparation.workspace.runContent,
        ...('configDir' in declaration ? { configDir: declaration.configDir } : {}),
        taskMounts,
        freshAgentRun: declaration.freshAgentRun,
        ...('resumeSessionId' in declaration
          ? { resumeSessionId: declaration.resumeSessionId }
          : {}),
        ...('runtimeBinding' in resources ? { runtimeBinding: resources.runtimeBinding } : {}),
        ...('gitUserName' in declaration ? { gitUserName: declaration.gitUserName } : {}),
        ...('gitUserEmail' in declaration ? { gitUserEmail: declaration.gitUserEmail } : {}),
        nodeRunId: declaration.nodeRunId,
        log: declaration.log,
        ...('extraArgs' in declaration ? { extraArgs: declaration.extraArgs } : {}),
        ...('nativeSessionId' in declaration
          ? { nativeSessionId: declaration.nativeSessionId }
          : {}),
      })
      return {
        get declared() {
          return compiled.declared
        },
        get evidenceCapabilities() {
          return compiled.evidenceCapabilities
        },
        bind() {
          return compiled.bind()
        },
        readDeclaredMcpServers() {
          return input.diagnostics.readDeclaredMcpServers(compiled)
        },
        reportSpawn(...report) {
          input.diagnostics.reportSpawn(compiled, ...report)
        },
        detectPluginLoadFailure(line) {
          return input.diagnostics.detectPluginLoadFailure(compiled, line)
        },
      }
    },
  }
}
