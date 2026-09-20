import type {
  CreateRuntimeInput,
  RuntimeView,
  UpdateRuntimeInput,
} from '@/platform/runtime-registry/application/runtimeRegistryOperations'
import type { RuntimeKind, RuntimeSmokeResult } from './types'

export interface RegisterRuntimeInput extends CreateRuntimeInput {
  readonly protocol: RuntimeKind
  readonly probe?: boolean
}

export type RuntimeProbeInput =
  | { readonly kind: 'registered'; readonly name: string }
  | {
      readonly kind: 'unsaved'
      readonly protocol: RuntimeKind
      readonly binaryPath: string
      readonly model?: string
      readonly isSandbox?: boolean
      readonly extraArgs?: readonly string[]
    }

/** Management use cases shared by inbound adapters; profile rows stay internal. */
export interface RuntimeProfileCommands {
  create(input: RegisterRuntimeInput): Promise<{
    readonly runtime: RuntimeView
    readonly smoke?: RuntimeSmokeResult
  }>
  update(name: string, input: UpdateRuntimeInput): Promise<{ readonly runtime: RuntimeView }>
  setEnabled(name: string, enabled: boolean): Promise<{ readonly runtime: RuntimeView }>
  remove(name: string): Promise<{ readonly ok: true }>
}

export interface RuntimeDiagnosticCommands {
  probe(input: RuntimeProbeInput): Promise<{ readonly smoke: RuntimeSmokeResult }>
}
