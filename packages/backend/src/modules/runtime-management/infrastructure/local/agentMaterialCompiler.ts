import { ulid } from 'ulid'
import type {
  AgentMaterialCompiler,
  AgentMaterialContentReference,
  AgentMaterialEvidenceCapabilities,
  AgentMaterialPlugin,
  AgentMaterialSkill,
} from '../../application/ports/agentMaterial'
import type { RuntimeKind } from '../../public/types'
import type {
  AgentSpawnContext,
  AgentSpawnPlan,
  BoundaryHostProbe,
  ResolvedSkill,
} from '@/services/runtime/types'
import type { RuntimePlugin } from '@/services/execution/agentInjection'

// Native compatibility plans keep the reference from their actual compilation.
// A fixture/legacy raw plan gets an opaque binding to that explicit object;
// this map never resolves an execution target or reads a registry/Paths.
const nativeMaterialReferences = new WeakMap<object, string>()

export function bindNativeAgentMaterialReference(plan: object, sourcePlan?: object): string {
  const existing = nativeMaterialReferences.get(plan)
  if (existing !== undefined) return existing
  const materialRef =
    (sourcePlan === undefined ? undefined : nativeMaterialReferences.get(sourcePlan)) ??
    `aw-agent-material:${ulid()}`
  nativeMaterialReferences.set(plan, materialRef)
  return materialRef
}

/** Native-only H6 binding. A hosted compiler has its own content binding and
 * never implements this physical projection. Skill readers are obtained here
 * without invoking them; the original staging operation keeps its read timing. */
export interface NativeAgentMaterialContents {
  workspace(reference: AgentMaterialContentReference): string
  runContent(reference: AgentMaterialContentReference): string
  runtimeBinary(reference: AgentMaterialContentReference): string
  skill(reference: AgentMaterialSkill): ResolvedSkill
  plugin(reference: AgentMaterialPlugin): RuntimePlugin
}

/** Fixture fields are native composition facts, never material-intent fields. */
export interface NativeAgentMaterialFixture {
  readonly binaryOverride?: readonly string[]
  readonly boundaryHostProbe?: BoundaryHostProbe
}

export function createLocalAgentMaterialCompiler(input: {
  readonly protocol: RuntimeKind
  readonly contents: NativeAgentMaterialContents
  readonly buildNative: (context: AgentSpawnContext) => Promise<AgentSpawnPlan>
  readonly evidenceCapabilities: AgentMaterialEvidenceCapabilities
  readonly fixture?: NativeAgentMaterialFixture
}) {
  const plans = new Map<string, AgentSpawnPlan>()
  const compiler: AgentMaterialCompiler = {
    async compile(intent) {
      if (intent.protocol !== input.protocol) {
        throw new Error(`agent-material-protocol-mismatch: ${intent.protocol}`)
      }
      // Resolve only the selected binding. No registry, Paths or global driver
      // fallback exists here. Optional presence keeps persona/business and
      // omitted config-dir behavior distinct.
      const context: AgentSpawnContext = {
        injection: {
          mcps: intent.injection.mcps,
          ...('agent' in intent.injection ? { agent: intent.injection.agent } : {}),
          ...('dependents' in intent.injection ? { dependents: intent.injection.dependents } : {}),
          ...('profile' in intent.injection ? { profile: intent.injection.profile } : {}),
          ...('skills' in intent.injection
            ? {
                skills: intent.injection.skills?.map((skill) => {
                  const material = input.contents.skill(skill)
                  const reader = material.readContentVersion
                  return {
                    name: skill.name,
                    sourceKind: skill.sourceKind,
                    ...('skillId' in skill ? { skillId: skill.skillId } : {}),
                    ...('contentVersion' in skill ? { contentVersion: skill.contentVersion } : {}),
                    ...('sourcePath' in material ? { sourcePath: material.sourcePath } : {}),
                    ...('readContentVersion' in material
                      ? {
                          readContentVersion:
                            reader === undefined ? undefined : () => reader.call(material),
                        }
                      : {}),
                  }
                }),
              }
            : {}),
          ...('plugins' in intent.injection
            ? {
                plugins: intent.injection.plugins?.map((plugin) => {
                  const material = input.contents.plugin(plugin)
                  const runtimeSpecifier = material.runtimeSpecifier
                  const locator =
                    runtimeSpecifier === undefined
                      ? { cachedPath: material.cachedPath! }
                      : { runtimeSpecifier }
                  return { ...plugin.declaration, ...locator }
                }),
              }
            : {}),
        },
        prompt: intent.prompt,
        agentName: intent.agentName,
        systemPrompt: intent.systemPrompt,
        resolvedParamsByAgent: new Map(intent.resolvedProfiles),
        cwd: input.contents.workspace(intent.workspace),
        runRoot: input.contents.runContent(intent.runContent),
        freshAgentRun: intent.freshAgentRun,
        nodeRunId: intent.nodeRunId,
        log: intent.log,
        ...('injectedMemoryBlock' in intent
          ? { injectedMemoryBlock: intent.injectedMemoryBlock }
          : {}),
        ...('taskMounts' in intent
          ? { taskMounts: intent.taskMounts?.map((mount) => input.contents.workspace(mount)) }
          : {}),
        ...('configDir' in intent ? { configDir: intent.configDir } : {}),
        ...('runtimeBinding' in intent
          ? {
              runtimeBinary:
                intent.runtimeBinding == null
                  ? intent.runtimeBinding
                  : input.contents.runtimeBinary(intent.runtimeBinding),
            }
          : {}),
        ...('extraArgs' in intent ? { extraArgs: intent.extraArgs } : {}),
        ...('nativeSessionId' in intent ? { nativeSessionId: intent.nativeSessionId } : {}),
        ...('resumeSessionId' in intent ? { resumeSessionId: intent.resumeSessionId } : {}),
        ...('gitUserName' in intent ? { gitUserName: intent.gitUserName } : {}),
        ...('gitUserEmail' in intent ? { gitUserEmail: intent.gitUserEmail } : {}),
        ...(input.fixture?.binaryOverride !== undefined
          ? { binaryOverride: input.fixture.binaryOverride }
          : {}),
        ...(input.fixture?.boundaryHostProbe !== undefined
          ? { boundaryHostProbe: input.fixture.boundaryHostProbe }
          : {}),
      }
      const plan = await input.buildNative(context)
      const materialRef = `aw-agent-material:${ulid()}`
      plans.set(materialRef, plan)
      nativeMaterialReferences.set(plan, materialRef)
      return {
        materialRef,
        declared: plan.declared,
        evidenceCapabilities: input.evidenceCapabilities,
      }
    },
  }
  return {
    compiler,
    /** Private native bridge for the existing buildSpawn compatibility API. */
    nativePlan(materialRef: string): AgentSpawnPlan {
      const plan = plans.get(materialRef)
      if (plan === undefined) throw new Error('agent-material-reference-unavailable')
      return plan
    },
  }
}
