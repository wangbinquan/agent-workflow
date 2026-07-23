// RFC-022: pure helper that converts a flat BFS-ordered list of closure
// agents into the nested `DependencyTreeNode` the `<DependencyTree>` renders.
//
// The flat list comes from `GET /api/agents/:id/closure` or
// `POST /api/agents/closure-preview` — both endpoints return `agents` in BFS
// order with the root at index 0. This helper:
//
//   1. walks the flat list once to index agents by immutable id,
//   2. recursively expands children from each agent's `dependsOn`,
//   3. collapses any id seen earlier on the recursion path AND/OR already
//      expanded elsewhere in the tree into `duplicateRef: true` leaves whose
//      `children` stay empty — visual de-dup so diamonds (A → B, C → B; root
//      sees B once expanded, the other path renders `↑ see above`) don't
//      blow up the rendered tree.
//
// Pure: no fetch, no React state. Tested directly so the rendering layer can
// stay dumb.

export interface DependencyTreeAgent {
  id: string
  name: string
  ownerUserId?: string | null
  description: string
  /** Skill names this agent itself references. Empty → no skill chip. */
  skills: readonly string[]
  /** RFC-030 follow-up: MCP server names this agent itself references
   *  (NOT the closure union — that's recomputed downstream). Empty →
   *  no MCP chip. */
  mcps: readonly string[]
  /** RFC-031: plugin names this agent itself references. Empty → no
   *  plugin chip. */
  plugins: readonly string[]
  dependsOn: readonly string[]
  /** True only for an explicit backend placeholder; empty metadata is valid. */
  missing?: boolean
}

export interface DependencyTreeNode {
  id: string
  name: string
  ownerUserId?: string | null
  description: string
  skills: readonly string[]
  mcps: readonly string[]
  plugins: readonly string[]
  missing: boolean
  /** True when an earlier sighting of this id already expanded its
   *  children; the rendering layer shows `↑ see above` and stops. */
  duplicateRef: boolean
  children: DependencyTreeNode[]
}

/**
 * Build the nested tree starting at `rootId`. IDs referenced in
 * `dependsOn` but not present in `flat` render as `<missing>` placeholder
 * leaves so users notice externally-broken closures (matches the API's
 * placeholder behavior, design.md §5.6).
 */
export function buildDependencyTree(
  flat: readonly DependencyTreeAgent[],
  rootId: string,
): DependencyTreeNode {
  const byId = new Map(flat.map((a) => [a.id, a]))
  const expanded = new Set<string>()

  function walk(id: string, path: readonly string[]): DependencyTreeNode {
    const agent = byId.get(id)
    if (agent === undefined) {
      // Missing — the opaque id is the only safe display identity available.
      return {
        id,
        name: id,
        ownerUserId: null,
        description: '',
        skills: [],
        mcps: [],
        plugins: [],
        missing: true,
        duplicateRef: false,
        children: [],
      }
    }
    const isDuplicate = path.includes(id) || expanded.has(id)
    if (isDuplicate) {
      return {
        id: agent.id,
        name: agent.name,
        ownerUserId: agent.ownerUserId,
        description: agent.description,
        skills: agent.skills,
        mcps: agent.mcps,
        plugins: agent.plugins,
        missing: agent.missing ?? false,
        duplicateRef: true,
        children: [],
      }
    }
    expanded.add(id)
    const nextPath = [...path, id]
    return {
      id: agent.id,
      name: agent.name,
      ownerUserId: agent.ownerUserId,
      description: agent.description,
      skills: agent.skills,
      mcps: agent.mcps,
      plugins: agent.plugins,
      missing: agent.missing ?? false,
      duplicateRef: false,
      children: agent.dependsOn.map((child) => walk(child, nextPath)),
    }
  }

  return walk(rootId, [])
}
