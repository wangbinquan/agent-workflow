import type {
  AgentMaterialContentReference,
  AgentMaterialEvidenceCapabilities,
  AgentMaterialIntent,
  AgentMaterialPlugin,
  AgentMaterialSkill,
} from '../../application/ports/agentMaterial'
import type { RuntimeKind } from '../../public/types'
import type { AgentSpawnContext, AgentSpawnPlan, ResolvedSkill } from '@/services/runtime/types'
import type { RuntimePlugin } from '@/services/execution/agentInjection'
import {
  createLocalAgentMaterialCompiler,
  type NativeAgentMaterialContents,
  type NativeAgentMaterialFixture,
} from './agentMaterialCompiler'

function referenceKey(reference: AgentMaterialContentReference): string {
  return JSON.stringify([reference.owner, reference.reference, reference.version])
}

/** Copy declaration data without freezing the caller's live resources. Unknown
 * non-data values retain their old identity; no new serialization is imposed. */
function frozenDeclaration<T>(value: T, copies = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value
  const retained = copies.get(value)
  if (retained !== undefined) return retained as T
  if (Array.isArray(value)) {
    const snapshot: unknown[] = []
    copies.set(value, snapshot)
    for (const item of value) snapshot.push(frozenDeclaration(item, copies))
    return Object.freeze(snapshot) as T
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  const snapshot: Record<string, unknown> = {}
  copies.set(value, snapshot)
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(snapshot, key, {
      value: frozenDeclaration(item, copies),
      enumerable: true,
    })
  }
  return Object.freeze(snapshot) as T
}

/** Compatibility projection is native-owned. It captures physical locators
 * and lazy readers in this binding, while the compiler sees only AW intent.
 * No content-version reader is called during this projection. */
export function bindLegacyNativeAgentMaterial(protocol: RuntimeKind, context: AgentSpawnContext) {
  const paths = new Map<string, string>()
  const skills = new Map<string, ResolvedSkill>()
  const plugins = new Map<string, RuntimePlugin>()
  const reference = (
    owner: AgentMaterialContentReference['owner'],
    name: string,
    version: AgentMaterialContentReference['version'] = null,
  ): AgentMaterialContentReference =>
    Object.freeze({ owner, reference: `${context.nodeRunId}:${name}`, version })
  const pathReference = (
    owner: AgentMaterialContentReference['owner'],
    name: string,
    path: string,
  ) => {
    const result = reference(owner, name)
    paths.set(referenceKey(result), path)
    return result
  }
  const readPath = (ref: AgentMaterialContentReference): string => {
    const value = paths.get(referenceKey(ref))
    if (value === undefined) throw new Error('agent-material-content-reference-unavailable')
    return value
  }
  const skillReferences = context.injection.skills?.map((skill, index): AgentMaterialSkill => {
    const reader = skill.readContentVersion
    const snapshot: ResolvedSkill = {
      name: skill.name,
      sourceKind: skill.sourceKind,
      ...('skillId' in skill ? { skillId: skill.skillId } : {}),
      ...('contentVersion' in skill ? { contentVersion: skill.contentVersion } : {}),
      ...('sourcePath' in skill ? { sourcePath: skill.sourcePath } : {}),
      ...('readContentVersion' in skill
        ? { readContentVersion: reader === undefined ? undefined : () => reader.call(skill) }
        : {}),
    }
    const content = reference('resource-catalog', `skill:${index}`, snapshot.contentVersion ?? null)
    skills.set(referenceKey(content), snapshot)
    return Object.freeze({
      name: snapshot.name,
      sourceKind: snapshot.sourceKind,
      ...('skillId' in snapshot ? { skillId: snapshot.skillId } : {}),
      ...('contentVersion' in snapshot ? { contentVersion: snapshot.contentVersion } : {}),
      content,
    })
  })
  const pluginReferences = context.injection.plugins?.map((plugin, index): AgentMaterialPlugin => {
    const runtimeSpecifier = plugin.runtimeSpecifier
    const locator =
      runtimeSpecifier === undefined ? { cachedPath: plugin.cachedPath! } : { runtimeSpecifier }
    const snapshot: RuntimePlugin = {
      id: plugin.id,
      name: plugin.name,
      options: plugin.options,
      enabled: plugin.enabled,
      ...locator,
    }
    const content = reference('resource-catalog', `plugin:${index}`)
    plugins.set(referenceKey(content), snapshot)
    return Object.freeze({
      declaration: Object.freeze({
        id: snapshot.id,
        name: snapshot.name,
        options: frozenDeclaration(snapshot.options),
        enabled: snapshot.enabled,
      }),
      content,
    })
  })
  const runtimeBinary = context.runtimeBinary
  const intent: AgentMaterialIntent = Object.freeze({
    protocol,
    injection: Object.freeze({
      mcps: frozenDeclaration(context.injection.mcps),
      ...('agent' in context.injection
        ? { agent: frozenDeclaration(context.injection.agent) }
        : {}),
      ...('dependents' in context.injection
        ? { dependents: frozenDeclaration(context.injection.dependents) }
        : {}),
      ...('profile' in context.injection
        ? {
            profile:
              context.injection.profile === undefined
                ? undefined
                : frozenDeclaration(context.injection.profile),
          }
        : {}),
      ...('skills' in context.injection
        ? { skills: skillReferences === undefined ? undefined : Object.freeze(skillReferences) }
        : {}),
      ...('plugins' in context.injection
        ? { plugins: pluginReferences === undefined ? undefined : Object.freeze(pluginReferences) }
        : {}),
    }),
    prompt: context.prompt,
    agentName: context.agentName,
    systemPrompt: context.systemPrompt,
    ...('injectedMemoryBlock' in context
      ? { injectedMemoryBlock: context.injectedMemoryBlock }
      : {}),
    resolvedProfiles: Object.freeze(
      [...context.resolvedParamsByAgent].map(([name, profile]) =>
        Object.freeze([name, frozenDeclaration(profile)] as const),
      ),
    ),
    workspace: pathReference('source-control', 'workspace', context.cwd),
    runContent: pathReference('runtime-management', 'run-content', context.runRoot),
    ...('taskMounts' in context
      ? {
          taskMounts:
            context.taskMounts === undefined
              ? undefined
              : Object.freeze(
                  context.taskMounts.map((mount, index) =>
                    pathReference('source-control', `mount:${index}`, mount),
                  ),
                ),
        }
      : {}),
    ...('configDir' in context ? { configDir: frozenDeclaration(context.configDir) } : {}),
    ...('runtimeBinary' in context
      ? {
          runtimeBinding:
            runtimeBinary == null
              ? runtimeBinary
              : pathReference('runtime-management', 'runtime', runtimeBinary),
        }
      : {}),
    ...('extraArgs' in context ? { extraArgs: frozenDeclaration(context.extraArgs) } : {}),
    freshAgentRun: context.freshAgentRun,
    ...('nativeSessionId' in context ? { nativeSessionId: context.nativeSessionId } : {}),
    ...('resumeSessionId' in context ? { resumeSessionId: context.resumeSessionId } : {}),
    ...('gitUserName' in context ? { gitUserName: context.gitUserName } : {}),
    ...('gitUserEmail' in context ? { gitUserEmail: context.gitUserEmail } : {}),
    nodeRunId: context.nodeRunId,
    log: context.log,
  })
  const contents: NativeAgentMaterialContents = {
    workspace: readPath,
    runContent: readPath,
    runtimeBinary: readPath,
    skill(ref) {
      const value = skills.get(referenceKey(ref.content))
      if (value === undefined) throw new Error('agent-material-skill-reference-unavailable')
      return value
    },
    plugin(ref) {
      const value = plugins.get(referenceKey(ref.content))
      if (value === undefined) throw new Error('agent-material-plugin-reference-unavailable')
      return value
    },
  }
  const fixture: NativeAgentMaterialFixture = {
    ...(context.binaryOverride !== undefined ? { binaryOverride: context.binaryOverride } : {}),
    ...(context.boundaryHostProbe !== undefined
      ? { boundaryHostProbe: context.boundaryHostProbe }
      : {}),
  }
  return { intent, contents, fixture }
}

/** Raw native callers may supply declaration getters. Snapshotting those
 * before the native render would move their errors out of its original catch,
 * or consume a one-shot getter twice. Inspect descriptors without reading
 * values through accessors; these contexts stay with the same selected native
 * body. The neutral compiler never consults this compatibility decision. */
function hasLegacyAccessor(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  for (
    let current: object | null = value;
    current !== null &&
    current !== Object.prototype &&
    current !== Array.prototype &&
    current !== Map.prototype &&
    current !== Set.prototype;
    current = Object.getPrototypeOf(current) as object | null
  ) {
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor === undefined) continue
      if (descriptor.get !== undefined || descriptor.set !== undefined) return true
      if (hasLegacyAccessor(descriptor.value, seen)) return true
    }
  }
  if (value instanceof Map) {
    for (const item of Map.prototype.values.call(value)) {
      if (hasLegacyAccessor(item, seen)) return true
    }
  }
  return false
}

/** The old driver API is retained only at this native compatibility boundary.
 * Normal neutral consumers retain the material reference instead of this plan. */
export async function compileLegacyNativeAgentMaterial(input: {
  readonly protocol: RuntimeKind
  readonly context: AgentSpawnContext
  readonly buildNative: (context: AgentSpawnContext) => Promise<AgentSpawnPlan>
  readonly evidenceCapabilities: AgentMaterialEvidenceCapabilities
}): Promise<AgentSpawnPlan> {
  let rawNativeAccessors: boolean
  try {
    rawNativeAccessors = hasLegacyAccessor(input.context)
  } catch {
    // Descriptor traps on a raw caller's object must not create a new error
    // before the original native read and its existing error boundaries.
    rawNativeAccessors = true
  }
  if (rawNativeAccessors) return input.buildNative(input.context)
  const binding = bindLegacyNativeAgentMaterial(input.protocol, input.context)
  const selected = createLocalAgentMaterialCompiler({ ...input, ...binding })
  const prepared = await selected.compiler.compile(binding.intent)
  return selected.nativePlan(prepared.materialRef)
}
