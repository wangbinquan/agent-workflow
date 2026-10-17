import type { Agent, DeclaredInjectionManifest } from '@agent-workflow/shared'
import type { AgentMaterialIntent } from '@/modules/runtime-management/public/participants'
import type { RuntimeProfile } from '@/modules/runtime-management/public/types'
import type {
  BusinessNativeAgent,
  BusinessNativeConfig,
  BusinessNativePlugin,
} from '@/platform/crewstation/nativeMaterial'
import {
  EMPTY_RUNTIME_PROFILE,
  declareSkills,
  emptyDeclaredManifest,
  partitionMcpsForInjection,
} from '@/services/execution/agentInjection'

export interface HostedNativeMaterialContent {
  readonly dependentAgentProfile?: (model: string, name: string) => Promise<string>
  /** The content owner must read the frozen generation, never today's plugin. */
  readonly pluginFiles?: (
    plugin: NonNullable<AgentMaterialIntent['injection']['plugins']>[number],
  ) => Promise<BusinessNativePlugin>
}

/** The same declarations feed the material and the persisted startup context.
 * No process launch or current-resource lookup takes place in this compiler. */
export async function compileHostedNativeMaterial(
  intent: AgentMaterialIntent,
  content: HostedNativeMaterialContent,
): Promise<{ nativeConfig: BusinessNativeConfig; declared: DeclaredInjectionManifest }> {
  if (intent.extraArgs?.length || intent.injection.profile?.extraArgs?.length)
    throw new Error('hosted-capability-unavailable: runtime arguments are platform-owned')
  if (intent.injection.profile?.isSandbox)
    throw new Error('hosted-capability-unavailable: runtime environment is platform-owned')
  const profiles = new Map(intent.resolvedProfiles)
  const rootProfile = intent.injection.profile ?? profiles.get(intent.agentName)
  const definition = async (
    agent: Agent | undefined,
    name: string,
    body: string,
  ): Promise<BusinessNativeAgent> => {
    const params =
      (name === intent.agentName ? rootProfile : profiles.get(name)) ?? EMPTY_RUNTIME_PROFILE
    let agentProfileId: string | undefined
    if (name !== intent.agentName && params.model !== null && params.model !== rootProfile?.model) {
      if (intent.protocol !== 'opencode' || !content.dependentAgentProfile)
        throw new Error(`hosted-capability-unavailable: dependent model mapping for ${name}`)
      agentProfileId = await content.dependentAgentProfile(params.model, name)
      if (!agentProfileId)
        throw new Error(`hosted-runtime-profile-unmapped: ${name}/${params.model}`)
    }
    const options: Record<string, unknown> = { description: agent?.description ?? name }
    if (intent.protocol === 'opencode') {
      if (agent?.permission) options.permission = agent.permission
      for (const key of ['variant', 'temperature', 'steps', 'maxSteps'] as const)
        if (params[key] !== null) options[key] = params[key]
    } else {
      if (Object.keys(agent?.permission ?? {}).length)
        throw new Error('hosted-capability-unavailable: Claude permission translation')
      const unsupported = ['variant', 'temperature', 'steps', 'maxSteps'] as const
      if (unsupported.some((key: keyof RuntimeProfile) => params[key] != null))
        throw new Error('hosted-capability-unavailable: Claude model options')
    }
    return { name, body, options, ...(agentProfileId ? { agentProfileId } : {}) }
  }
  const rootBody = [intent.systemPrompt, intent.injectedMemoryBlock].filter(Boolean).join('\n\n')
  const agent = await definition(intent.injection.agent, intent.agentName, rootBody)
  const subagents: BusinessNativeAgent[] = []
  const names = new Set([intent.agentName])
  for (const dependent of intent.injection.dependents ?? []) {
    if (names.has(dependent.name)) continue
    names.add(dependent.name)
    subagents.push(await definition(dependent, dependent.name, dependent.bodyMd))
  }
  const { injected, declared: mcpDeclaration } = partitionMcpsForInjection(intent.injection.mcps)
  const mcp: BusinessNativeConfig['mcp'] = injected.map((server) => {
    if (
      intent.protocol === 'claude-code' &&
      server.type === 'remote' &&
      server.config.oauth !== undefined
    )
      throw new Error('hosted-capability-unavailable: Claude MCP OAuth native material')
    if (intent.protocol === 'claude-code' && server.config.timeoutMs !== undefined)
      throw new Error('hosted-capability-unavailable: Claude per-server MCP timeout')
    return server.type === 'local'
      ? { name: server.name, type: 'local', ...server.config }
      : { name: server.name, type: 'remote', ...server.config }
  })
  const plugins: BusinessNativePlugin[] = []
  const pluginIds = new Set<string>()
  const pluginNames = new Set<string>()
  for (const plugin of intent.injection.plugins ?? []) {
    if (!plugin.declaration.enabled || pluginIds.has(plugin.declaration.id)) continue
    if (pluginNames.has(plugin.declaration.name)) throw new Error('hosted-plugin-name-conflict')
    if (intent.protocol === 'claude-code' && Object.keys(plugin.declaration.options ?? {}).length)
      throw new Error('hosted-capability-unavailable: Claude plugin options')
    if (!content.pluginFiles) throw new Error('hosted-plugin-content-owner-unavailable')
    const loaded = await content.pluginFiles(plugin)
    if (loaded.name !== plugin.declaration.name)
      throw new Error('hosted-plugin-content-name-mismatch')
    pluginIds.add(plugin.declaration.id)
    pluginNames.add(loaded.name)
    plugins.push(loaded)
  }
  return {
    nativeConfig: { version: 1, protocol: intent.protocol, agent, subagents, mcp, plugins },
    declared: {
      ...emptyDeclaredManifest(),
      ...mcpDeclaration,
      skills: declareSkills(intent.injection.skills ?? []),
      subagents: subagents.map((entry) => entry.name),
      plugins: plugins.map((entry) => entry.name),
    },
  }
}
