import type { RuntimeKind } from '../../public/types'
import type {
  DeclaredInjectionManifest,
  FaceSupport,
  InventoryDeclaration,
  StartupObservationSource,
} from '@agent-workflow/shared'
import type { NormalizedEvent, SystemEventObservation } from './agentObservations'
import type { RuntimeUsageMeter, RuntimeUsageMeterInput } from '../../domain/usageMeter'

/** Pure protocol behavior; selecting it does not select an execution target. */
export interface AgentInvocationProtocol {
  readonly kind: RuntimeKind
  readonly capabilities: RuntimeDriverCapabilities
  parseEvent(line: string): NormalizedEvent | null
  /** RFC-371 v2: stream-only usage meter (material evidence adds the native store). */
  usageMeter?(input: RuntimeUsageMeterInput): RuntimeUsageMeter
  observeSystemEvent?(line: string): SystemEventObservation
  parseTerminalResultError?(line: string): string | null
}

// RFC-462 (RFC-294 W9-D): the driver's static capability declaration, moved verbatim from
// `services/runtime/types.ts` to sit with the protocol that carries it.

/**
 * RFC-282 A3 — the faces of `DeclaredManifestV1` a driver must take a stance
 * on. Derived with `keyof`, so ADDING a manifest face is a compile error in
 * every driver's `declarationFaces` record until it states support (§4.4-2).
 */
// RFC-462: `DeclaredManifestV1` (services/execution/agentInjection) is an alias of shared `DeclaredInjectionManifest`.
export type DeclarationFace = keyof DeclaredInjectionManifest

/**
 * RFC-282 A3 — a driver's STATIC self-declaration, consumed by the boot
 * self-check (every registered driver must cover every face) and later (C2)
 * by the runner's observation switch.
 *
 * 命名注意（设计门 P2-4）：**不叫 `RuntimeCapabilities`** —— 本文件已有
 * `DeclaredRuntimeCapabilities`，语义是「运行时启动清单里**观测到**的能力」，
 * 与这里「driver **静态声明**的能力」完全不同却只差一个词。
 *
 * A3 deliberately carries ONLY the three new dimensions. The existing
 * per-driver scalars (`minVersion` / `acceptsExtraArgs` /
 * `acceptsSandboxCompatibilityMarker`) stay where they are — folding them in
 * here while their consumers still read the driver fields would be a second
 * copy of each value, which is exactly what this RFC exists to kill.
 */
export interface RuntimeDriverCapabilities {
  /**
   * Where this runtime's startup inventory comes from. The runner switches on
   * this (C2) instead of the `readInventory !== undefined` proxy; a third
   * runtime must state its source explicitly instead of falling into an
   * if-opencode-else-claude branch.
   */
  readonly startupObservation: StartupObservationSource
  /**
   * 设计门 P1-7 — whether the observation exists only when THIS run produced
   * a fresh inventory. opencode's dump plugin writes the file per fresh run;
   * a followup (reused session, plugin not re-run) has nothing to read, and
   * verifying anyway would hang an "unverifiable" banner on every followup
   * (RFC-280 实现门 P2-E). claude's init event fires every run.
   */
  readonly observationRequiresFreshRun: boolean
  /** Per-face stance; the boot self-check refuses to start on a missing face. */
  readonly declarationFaces: Readonly<Record<DeclarationFace, FaceSupport>>
  /**
   * RFC-297 T5 — what this runtime can report on each inventory face, and on
   * each rich field within a face. Drives the unified inventory read end and
   * the frontend's column selection, so "this runtime has no such concept"
   * (`unsupported`, e.g. claude × plugin) stays distinguishable from "it has
   * the concept and loaded zero of them".
   *
   * Same ratchet as `declarationFaces` above: the type is derived with mapped
   * types over the closed face/field unions, so adding a face — or adding a
   * rich field to an existing face — is a compile error in every driver until
   * it states a stance.
   */
  readonly inventory: InventoryDeclaration
}
