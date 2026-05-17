// RFC-022: pure helper that converts a flat BFS-ordered list of closure
// agents into the nested `DependencyTreeNode` the `<DependencyTree>` renders.
//
// The flat list comes from `GET /api/agents/:name/closure` or
// `POST /api/agents/closure-preview` — both endpoints return `agents` in BFS
// order with the root at index 0. This helper:
//
//   1. walks the flat list once to index agents by name,
//   2. recursively expands children from each agent's `dependsOn`,
//   3. collapses any name seen earlier on the recursion path AND/OR already
//      expanded elsewhere in the tree into `duplicateRef: true` leaves whose
//      `children` stay empty — visual de-dup so diamonds (A → B, C → B; root
//      sees B once expanded, the other path renders `↑ see above`) don't
//      blow up the rendered tree.
//
// Pure: no fetch, no React state. Tested directly so the rendering layer can
// stay dumb.

export interface DependencyTreeAgent {
  name: string
  description: string
  skillCount: number
  /** RFC-030 follow-up: number of MCP servers this agent itself references
   *  (NOT the closure union — that's recomputed downstream). Drives the
   *  per-row MCP chip in <DependencyTree> so users can see at a glance
   *  which closure members bring in MCPs. */
  mcpCount: number
  readonly: boolean
  dependsOn: readonly string[]
}

export interface DependencyTreeNode {
  name: string
  description: string
  skillCount: number
  mcpCount: number
  readonly: boolean
  /** True when an earlier sighting of this name already expanded its
   *  children; the rendering layer shows `↑ see above` and stops. */
  duplicateRef: boolean
  children: DependencyTreeNode[]
}

/**
 * Build the nested tree starting at `rootName`. Names referenced in
 * `dependsOn` but not present in `flat` render as `<missing>` placeholder
 * leaves so users notice externally-broken closures (matches the API's
 * placeholder behavior, design.md §5.6).
 */
export function buildDependencyTree(
  flat: readonly DependencyTreeAgent[],
  rootName: string,
): DependencyTreeNode {
  const byName = new Map(flat.map((a) => [a.name, a]))
  const expanded = new Set<string>()

  function walk(name: string, path: readonly string[]): DependencyTreeNode {
    const agent = byName.get(name)
    if (agent === undefined) {
      // Missing — placeholder so users see "<missing> someAgent" in the UI.
      return {
        name,
        description: '',
        skillCount: 0,
        mcpCount: 0,
        readonly: false,
        duplicateRef: false,
        children: [],
      }
    }
    const isDuplicate = path.includes(name) || expanded.has(name)
    if (isDuplicate) {
      return {
        name: agent.name,
        description: agent.description,
        skillCount: agent.skillCount,
        mcpCount: agent.mcpCount,
        readonly: agent.readonly,
        duplicateRef: true,
        children: [],
      }
    }
    expanded.add(name)
    const nextPath = [...path, name]
    return {
      name: agent.name,
      description: agent.description,
      skillCount: agent.skillCount,
      mcpCount: agent.mcpCount,
      readonly: agent.readonly,
      duplicateRef: false,
      children: agent.dependsOn.map((child) => walk(child, nextPath)),
    }
  }

  return walk(rootName, [])
}
