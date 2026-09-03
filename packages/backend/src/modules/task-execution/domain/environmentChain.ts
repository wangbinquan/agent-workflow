// RFC-354 — lexical-environment frame arithmetic (PURE).
//
// A wrapper body is a function body: an edge whose source sits OUTSIDE the
// body is a closure capture (free variable) or a parameter, and the value it
// reads must come from the frame that directly contains the source — never
// from "some row whose iteration happens to be ≤ ours" (the numeric window
// this module retires, `services/freshness.ts` pickUpstreamSourceRun).
//
// A frame is `(containerRunId, iteration)`: the wrapper GENERATION row the
// consumer hangs off (null at the top scope) plus the round inside it. The
// generation row itself carries the coordinate of its own enclosing frame, so
// walking outward is one row lookup per hop — no scope path string needed.
//
// Locks: tests/rfc354-environment-chain.test.ts.

import { workflowScopeOf } from '@agent-workflow/shared'

export interface FrameCoordinate {
  readonly containerRunId: string | null
  readonly iteration: number
}

/** The wrapper generation row shape the walk reads (a `node_runs` projection). */
export interface ContainerRunRow {
  readonly id: string
  readonly nodeId: string
  readonly containerRunId: string | null
  readonly iteration: number
}

export const TOP_FRAME: FrameCoordinate = Object.freeze({ containerRunId: null, iteration: 0 })

export function frameKey(frame: FrameCoordinate): string {
  return `${frame.containerRunId ?? ''}#${frame.iteration}`
}

export function sameFrame(a: FrameCoordinate, b: FrameCoordinate): boolean {
  return a.containerRunId === b.containerRunId && a.iteration === b.iteration
}

/**
 * The derived `scope_path` breadcrumb of a row minted inside the frame whose
 * generation row is (`containerNodeId`, `containerScopePath`) at round
 * `iteration`: `outer:1/inner:0`, `''` at the top scope. Write-once; a UI /
 * diagnostics convenience derived from `container_run_id`, never read by
 * scheduling.
 */
export function childScopePath(
  containerScopePath: string,
  containerNodeId: string,
  iteration: number,
): string {
  const segment = `${containerNodeId}:${iteration}`
  return containerScopePath === '' ? segment : `${containerScopePath}/${segment}`
}

export type SourceFrameResolution =
  | { readonly ok: true; readonly frame: FrameCoordinate; readonly hops: number }
  | {
      readonly ok: false
      readonly reason: 'container-row-missing' | 'scope-not-enclosing' | 'containment-cycle'
      readonly scopeId: string | null
    }

/**
 * One hop outward: the frame that encloses `frame`. Reads the generation row
 * `frame.containerRunId` points at; its own coordinate IS the parent frame.
 */
export function parentFrameOf(
  frame: FrameCoordinate,
  containerRowById: (id: string) => ContainerRunRow | undefined,
): FrameCoordinate | null {
  if (frame.containerRunId === null) return null
  const row = containerRowById(frame.containerRunId)
  if (row === undefined) return null
  return { containerRunId: row.containerRunId, iteration: row.iteration }
}

/**
 * Resolve the frame in which `sourceNodeId` must be read by a consumer
 * running at `frame` inside the scope of `targetNodeId`.
 *
 *   - same scope → the consumer's own frame (a local variable);
 *   - source in an enclosing scope → walk outward one generation row per
 *     wrapper until the scope that directly contains the source (a captured
 *     free variable, or a wrapper parameter resolved at the wrapper's frame);
 *   - anything else fails closed: the source is not lexically visible.
 *
 * Deliberately never falls back to another frame — a value that is not in the
 * environment is `closure-binding-unresolved`, not `''`.
 */
export function resolveSourceFrame(args: {
  readonly sourceNodeId: string
  readonly targetNodeId: string
  readonly parents: ReadonlyMap<string, string>
  readonly frame: FrameCoordinate
  readonly containerRowById: (id: string) => ContainerRunRow | undefined
}): SourceFrameResolution {
  return resolveSourceFrameInScope({
    sourceNodeId: args.sourceNodeId,
    scope: workflowScopeOf(args.targetNodeId, args.parents),
    parents: args.parents,
    frame: args.frame,
    containerRowById: args.containerRowById,
  })
}

/**
 * Same walk, but the reader is a SCOPE rather than a node: `scope` is the
 * wrapper whose body frame `frame` is (null = the top scope). This is how a
 * wrapper reads on behalf of its body — a loop's exit condition / output
 * binding evaluated at `(generation, round)` reads a body node locally and a
 * node outside the loop as a captured free variable.
 */
export function resolveSourceFrameInScope(args: {
  readonly sourceNodeId: string
  readonly scope: string | null
  readonly parents: ReadonlyMap<string, string>
  readonly frame: FrameCoordinate
  readonly containerRowById: (id: string) => ContainerRunRow | undefined
}): SourceFrameResolution {
  const sourceScope = workflowScopeOf(args.sourceNodeId, args.parents)
  let scope = args.scope
  let frame = args.frame
  let hops = 0
  const seen = new Set<string>()
  while (scope !== sourceScope) {
    if (scope === null) return { ok: false, reason: 'scope-not-enclosing', scopeId: sourceScope }
    if (seen.has(scope)) return { ok: false, reason: 'containment-cycle', scopeId: scope }
    seen.add(scope)
    if (frame.containerRunId === null) {
      return { ok: false, reason: 'container-row-missing', scopeId: scope }
    }
    const row = args.containerRowById(frame.containerRunId)
    if (row === undefined || row.nodeId !== scope) {
      return { ok: false, reason: 'container-row-missing', scopeId: scope }
    }
    frame = { containerRunId: row.containerRunId, iteration: row.iteration }
    scope = workflowScopeOf(scope, args.parents)
    hops += 1
  }
  return { ok: true, frame, hops }
}
