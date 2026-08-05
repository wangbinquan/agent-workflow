// RFC-085 — call-chain view model (pure). The chain is fetched LAZILY one level
// at a time (GET /call-targets per method); this module holds the small decision
// helpers — whether a node can expand, given cycle + depth guards — so they get
// unit coverage independent of the React tree.

import type { CallTarget } from '@agent-workflow/shared'
import type { SeqCallNode } from './sequence'

export type { CallTarget }

/** Bounds for the eager sequence-diagram walk (the tree view stays lazy). */
export const SEQ_MAX_NODES = 80
export const SEQ_MAX_DEPTH = 8

/** Eagerly (but bounded) walk a method's forward chain into a SeqCallNode tree.
 *  `fetcher(ref)` returns one method's direct callees. Recurses only into resolved
 *  callees; sets `truncated` when a resolved subtree is dropped for the node cap,
 *  a cycle (ref already an ancestor) OR the depth cap — so the diagram can flag
 *  that it's incomplete. PURE given `fetcher` (injectable → unit-testable). */
export async function walkChainTree(
  rootRef: string,
  fetcher: (ref: string) => Promise<CallTarget[]>,
  opts: { maxNodes: number; maxDepth: number } = {
    maxNodes: SEQ_MAX_NODES,
    maxDepth: SEQ_MAX_DEPTH,
  },
): Promise<{ tree: SeqCallNode[]; truncated: boolean }> {
  let count = 0
  let truncated = false
  const visit = async (
    ref: string,
    ancestors: ReadonlySet<string>,
    depth: number,
  ): Promise<SeqCallNode[]> => {
    const targets = (await fetcher(ref)).slice().sort((a, b) => a.order - b.order)
    const out: SeqCallNode[] = []
    for (const tg of targets) {
      if (count >= opts.maxNodes) {
        truncated = true
        break
      }
      count += 1
      let children: SeqCallNode[] = []
      if (tg.resolution === 'resolved' && tg.ref !== undefined) {
        if (ancestors.has(tg.ref) || depth >= opts.maxDepth) truncated = true
        else children = await visit(tg.ref, new Set([...ancestors, tg.ref]), depth + 1)
      }
      out.push({
        ownerClass: tg.ownerClass ?? null,
        method: tg.label,
        resolution: tg.resolution,
        ...(tg.ref !== undefined ? { ref: tg.ref } : {}),
        children,
      })
    }
    return out
  }
  const tree = await visit(rootRef, new Set([rootRef]), 0)
  return { tree, truncated }
}

/** Max chain depth (root = 0); deeper expands are blocked + marked truncated so a
 *  pathological recursion can't open an unbounded tree. */
export const MAX_CHAIN_DEPTH = 12

export type ExpandState =
  | 'expandable' // resolved, not on the path, within depth — has a ▸
  | 'cycle' // its ref is already an ancestor — stop (would recurse forever)
  | 'too-deep' // depth cap reached — stop
  | 'leaf' // external/unresolved (no ref) — nothing to expand

/** Whether a target can be expanded into its own callees. `ancestorRefs` is the
 *  set of method refs from the root down to (and excluding) this node. */
export function expandState(
  target: Pick<CallTarget, 'ref' | 'resolution'>,
  ancestorRefs: ReadonlySet<string>,
  depth: number,
): ExpandState {
  if (target.ref === undefined || target.resolution !== 'resolved') return 'leaf'
  if (ancestorRefs.has(target.ref)) return 'cycle'
  if (depth >= MAX_CHAIN_DEPTH) return 'too-deep'
  return 'expandable'
}

/** The readable method name from a call ref (`file#Qualified.name`). Splits on the
 *  FIRST '#' only — a qualifiedName can itself contain '#' (JS/TS hard `#private`
 *  members, e.g. `Svc.#secret`), so `split('#')[1]` would corrupt it. */
export function refLabel(ref: string): string {
  const i = ref.indexOf('#')
  const qn = i >= 0 ? ref.slice(i + 1) : ref
  const leaf = qn.split('.').pop() ?? qn
  return `${leaf}()`
}

/** The backend methodRef (`file#qualifiedName`) for a member, decoded from its
 *  encoded symbol id (`file#qualifiedName:kind:row`). Strips ONLY the trailing
 *  `:kind:row` from the end — never splits on '#', because a `#private`
 *  qualifiedName contains a literal '#' (RFC-087) that `id.split('#')[1]` breaks. */
export function refFromMemberId(id: string): string {
  return id.replace(/:[^:]+:[^:]+$/, '')
}
