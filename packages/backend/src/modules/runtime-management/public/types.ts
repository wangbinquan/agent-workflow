/** Runtime protocol identity shared by provider-neutral module contracts. */
export type RuntimeKind = 'opencode' | 'claude-code'

/** The existing diagnostic wire, independent of the process adapter's options. */
export interface RuntimeSmokeResult {
  readonly outcome:
    | 'conforms'
    | 'spawn-failed'
    | 'auth-missing'
    | 'network-blocked'
    | 'model-call-failed'
    | 'stream-nonconforming'
  readonly conforms: boolean
  readonly detail: string
  readonly capturedSessionId?: string
  readonly sawNonce: boolean
  readonly sawEnvelope: boolean
  readonly exitCode: number | null
}

/** Durable marker emitted when a distillation runtime transcript cannot be captured. */
export const DISTILL_CAPTURE_FAILED_KIND = 'rfc043/distill-capture-failed'

export type RuntimeProtocol = RuntimeKind

/**
 * RFC-113: the execution params a runtime spawns with (agents only SELECT a
 * runtime). variant/temperature/steps/maxSteps are opencode-only. NULL model =
 * "omit model" (a distinct profile from an explicit model).
 */
export interface RuntimeProfile {
  model: string | null
  variant: string | null
  temperature: number | null
  steps: number | null
  maxSteps: number | null
  /**
   * RFC-276 — opt-in Claude CLI compatibility marker. true injects
   * IS_SANDBOX=1 into that runtime's child process; it does not enable or
   * attest an OS sandbox. Legacy frozen runtime_params_json is normalized to
   * false by parseFrozenParams before it becomes a RuntimeProfile.
   */
  isSandbox: boolean
  /**
   * 2026-08-04 — extra argv tokens appended to every spawn (claude-code
   * protocol only; fork-private flags like CodeAgent's `--skip-safe-check`).
   * Optional so historical frozen-params JSON and profile literals stay valid;
   * absent ≡ null ≡ none. Platform-owned flags are rejected at write time.
   */
  extraArgs?: readonly string[] | null
}

export interface RuntimeView extends RuntimeProfile {
  name: string
  protocol: RuntimeProtocol
  binaryPath: string | null
  /** RFC-118: false = disabled (filtered from agent/default pickers, kept in list). */
  enabled: boolean
  isSandbox: boolean
  /** RFC-113: this row is the global default (name === config.defaultRuntime). */
  isDefault: boolean
  /** RFC-154: raw config-dir overrides (NULL = protocol default) — edit-form prefill. */
  configDirEnv: string | null
  configDirName: string | null
  lastProbe: unknown
  createdAt: number
  updatedAt: number
}

// --- CRUD ------------------------------------------------------------------

/** RFC-113: optional per-field profile params on create/update. */
export interface RuntimeProfileInput {
  model?: string | null
  variant?: string | null
  temperature?: number | null
  steps?: number | null
  maxSteps?: number | null
  /** RFC-276: inject IS_SANDBOX=1 for claude-code compatibility; default false. */
  isSandbox?: boolean
  /** 2026-08-04 — extra argv tokens; validated against the protocol in
   *  create/update (NOT in profilePatch, which has no protocol context). */
  extraArgs?: readonly string[] | null
}

export interface CreateRuntimeInput extends RuntimeProfileInput {
  name: string
  protocol: string
  binaryPath?: string | null
  /** RFC-154: config-dir injection overrides (validated; empty → NULL = default). */
  configDirEnv?: string | null
  configDirName?: string | null
  lastProbeJson?: string | null
  createdBy?: string | null
}

export interface UpdateRuntimeInput extends RuntimeProfileInput {
  binaryPath?: string | null
  /** RFC-154: config-dir injection overrides (validated; empty → NULL = default). */
  configDirEnv?: string | null
  configDirName?: string | null
  lastProbeJson?: string | null
}

/** Immutable profile facts required by execution mechanisms and dependent-agent injection. */
export interface ResolvedRuntimeProfile extends RuntimeProfile {
  readonly name: string
  readonly protocol: RuntimeProtocol
  readonly binaryPath: string | null
  readonly configDir: { readonly env: string; readonly name: string }
}

/** Purpose-specific projection for catalog references and MCP test target identity. */
export interface RuntimeProfileInspection extends RuntimeProfile {
  readonly id: string
  readonly name: string
  readonly protocol: RuntimeProtocol
  readonly binaryPath: string | null
  readonly enabled: boolean
  readonly configDirEnv: string | null
  readonly configDirName: string | null
  readonly probeFence: number
}
