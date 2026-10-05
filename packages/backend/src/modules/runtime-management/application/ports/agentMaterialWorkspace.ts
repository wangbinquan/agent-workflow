import type { AgentMaterialContentReference } from './agentMaterial'

/** Seed names are relative to the selected working content, not host paths. */
export interface AgentMaterialSeedFile {
  readonly path: string
  readonly content: string
}

/** Invocation-owned content lifecycle. The caller decides when removal is
 * permitted, preserving its original capture, reap and retention policy.
 * Implementations interpret these references without exposing host locations. */
export interface AgentMaterialWorkspace {
  readonly workspace: AgentMaterialContentReference
  readonly runContent: AgentMaterialContentReference
  readonly retainedRef: string
  prepare(seeds?: readonly AgentMaterialSeedFile[]): void | Promise<void>
  discard(): void | Promise<void>
}
