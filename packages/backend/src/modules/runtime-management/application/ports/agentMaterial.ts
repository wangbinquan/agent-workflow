import type {
  Agent,
  DeclaredInjectionManifest,
  Mcp,
  Plugin,
  RuntimeConfigDirProfile,
} from '@agent-workflow/shared'
import type { RuntimeKind, RuntimeProfile } from '../../public/types'
import type { Logger } from '@/util/log'

/** The selected content owner interprets these references; callers do not. */
export interface AgentMaterialContentReference {
  readonly owner: 'source-control' | 'resource-catalog' | 'runtime-management'
  readonly reference: string
  readonly version: string | number | null
}

export interface AgentMaterialSkill {
  readonly name: string
  readonly sourceKind: 'managed' | 'project'
  readonly skillId?: string
  readonly contentVersion?: number
  readonly content: AgentMaterialContentReference
}

export interface AgentMaterialPlugin {
  readonly declaration: Readonly<Pick<Plugin, 'id' | 'name' | 'options' | 'enabled'>>
  readonly content: AgentMaterialContentReference
}

/** AW owns the complete, ordered declaration and the already-resolved profiles.
 * Paths, material locators, lazy content readers and fixture command overrides
 * remain in the selected implementation's binding. */
export interface AgentMaterialIntent {
  readonly protocol: RuntimeKind
  readonly injection: {
    readonly mcps: readonly Mcp[]
    readonly agent?: Agent
    readonly dependents?: readonly Agent[]
    readonly profile?: Readonly<RuntimeProfile>
    readonly skills?: readonly AgentMaterialSkill[]
    readonly plugins?: readonly AgentMaterialPlugin[]
  }
  readonly prompt: string
  readonly agentName: string
  readonly systemPrompt: string
  readonly injectedMemoryBlock?: string | null
  readonly resolvedProfiles: readonly (readonly [string, Readonly<RuntimeProfile>])[]
  readonly workspace: AgentMaterialContentReference
  readonly runContent: AgentMaterialContentReference
  readonly taskMounts?: readonly AgentMaterialContentReference[]
  readonly configDir?: Readonly<RuntimeConfigDirProfile>
  readonly runtimeBinding?: AgentMaterialContentReference | null
  readonly extraArgs?: readonly string[]
  readonly freshAgentRun: boolean
  readonly nativeSessionId?: string | null
  readonly resumeSessionId?: string | null
  readonly gitUserName?: string | null
  readonly gitUserEmail?: string | null
  readonly nodeRunId: string
  readonly log: Logger
}

export interface AgentMaterialEvidenceCapabilities {
  readonly usageNormalizer: boolean
  readonly nativeUsageCapture: boolean
  readonly spanCapture: boolean
  readonly sessionCapture: boolean
  readonly inventory: boolean
  readonly finalEvents: boolean
  readonly liveCapture: boolean
  readonly sessionSinkCapture: boolean
}

/** The declaration comes from the same compilation as the material reference. */
export interface PreparedAgentMaterial {
  readonly materialRef: string
  readonly declared: DeclaredInjectionManifest
  readonly evidenceCapabilities: AgentMaterialEvidenceCapabilities
}

export interface AgentMaterialCompiler {
  compile(intent: AgentMaterialIntent): Promise<PreparedAgentMaterial>
}
