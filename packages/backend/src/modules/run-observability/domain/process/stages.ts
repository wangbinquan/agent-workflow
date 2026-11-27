// RFC-616 §5.1 — the stage catalogue of a workflow.
//
// Canvas nodes are stages; loop, fan-out and git wrappers are parent stages.
// Three kinds of node ids are not on the canvas and must not be mistaken for
// one another:
//   - platform work with a synthetic id (`__repo_prep__`, `__commit_push__:x`,
//     …) belongs to a fixed system stage;
//   - an ordinary id missing from the newest definition was removed from the
//     workflow and stays visible, marked as removed;
//   - anything else that cannot be placed is "unattributed".

import {
  PROCESS_UNATTRIBUTED_STAGE,
  buildWorkflowScopeParentMap,
  clarifyCategoryPaths,
  type ProcessSystemStage,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import type { ProcessLabel, ProcessStage } from './model'

/** Synthetic node id prefixes and the system stage they belong to; first match wins. */
const SYSTEM_PREFIXES: readonly (readonly [string, ProcessSystemStage])[] = [
  ['__repo_prep__', 'system:repo-prep'],
  ['__commit_push__', 'system:commit-push'],
  ['__merge_resolve__', 'system:merge-resolve'],
  ['__dw_orchestrator__', 'system:orchestrator'],
]

const SYSTEM_ORDER: Readonly<Record<ProcessSystemStage, number>> = {
  'system:repo-prep': 0,
  'system:orchestrator': 1,
  'system:commit-push': 2,
  'system:merge-resolve': 3,
  'system:other': 4,
}

/** The system stage of a synthetic node id; null for an ordinary node id. */
export function systemStageOf(nodeId: string): ProcessSystemStage | null {
  if (!nodeId.startsWith('__')) return null
  for (const [prefix, stage] of SYSTEM_PREFIXES) if (nodeId.startsWith(prefix)) return stage
  return 'system:other'
}

export interface WorkflowStageCatalog {
  /** Definition order first, then system stages, then removed nodes. */
  readonly stages: readonly ProcessStage[]
  /** The stage of any node id, known or not. */
  stageOf(nodeId: string): string
  /** Loop settings by wrapper stage. */
  readonly loops: ReadonlyMap<
    string,
    { readonly maxIterations: number | null; readonly continuesAtCap: boolean }
  >
  /** Top-level mindmap categories configured per clarify stage, by name. */
  readonly mindmapCategories: ReadonlyMap<string, ReadonlySet<string>>
}

function field(node: object, name: string): unknown {
  return (node as Readonly<Record<string, unknown>>)[name]
}

function labelOf(node: { readonly id: string; readonly title?: string }): string {
  const title = node.title?.trim()
  if (title) return title
  const agentName = field(node, 'agentName')
  return typeof agentName === 'string' && agentName.trim() ? agentName.trim() : node.id
}

/**
 * Build the catalogue from the newest definition plus every node id the units
 * actually executed. `definition` may be null (unreadable snapshot): the
 * catalogue then degrades to a flat list of the executed ids. Those are not
 * "removed from the workflow" — nothing says so; only an id missing from a
 * definition that was read is.
 */
export function workflowStageCatalog(
  definition: WorkflowDefinition | null,
  executedNodeIds: Iterable<string>,
): WorkflowStageCatalog {
  const stages: ProcessStage[] = []
  const known = new Set<string>()
  const loops = new Map<string, { maxIterations: number | null; continuesAtCap: boolean }>()
  const mindmapCategories = new Map<string, ReadonlySet<string>>()

  if (definition !== null) {
    const parents = buildWorkflowScopeParentMap(definition)
    definition.nodes.forEach((node, index) => {
      known.add(node.id)
      stages.push({
        key: node.id,
        label: labelOf(node),
        kind: node.kind,
        parentKey: parents.get(node.id) ?? null,
        order: index,
        removed: false,
      })
      if (node.kind === 'wrapper-loop') {
        const max = field(node, 'maxIterations')
        loops.set(node.id, {
          maxIterations: typeof max === 'number' && Number.isFinite(max) ? max : null,
          continuesAtCap: field(node, 'continueOnMaxIterations') === true,
        })
      }
      if (node.kind === 'clarify' || node.kind === 'clarify-cross-agent') {
        const mindmap = field(node, 'mindmap')
        const categories =
          mindmap !== null && typeof mindmap === 'object' ? field(mindmap, 'categories') : null
        if (Array.isArray(categories) && field(node, 'interactionMode') === 'mindmap') {
          const top = new Set(
            clarifyCategoryPaths(categories as (string | string[])[])
              .map((path) => path[0])
              .filter((name): name is string => typeof name === 'string' && name !== ''),
          )
          mindmapCategories.set(node.id, top)
        }
      }
    })
  }

  const systems = new Set<ProcessSystemStage>()
  const removed: string[] = []
  for (const nodeId of executedNodeIds) {
    if (known.has(nodeId)) continue
    const system = systemStageOf(nodeId)
    if (system !== null) systems.add(system)
    else if (!removed.includes(nodeId)) removed.push(nodeId)
  }
  const base = stages.length
  for (const system of [...systems].sort((a, b) => SYSTEM_ORDER[a] - SYSTEM_ORDER[b])) {
    stages.push(systemStage(system, base + SYSTEM_ORDER[system]))
  }
  removed.sort().forEach((nodeId, index) => {
    stages.push({
      key: nodeId,
      label: nodeId,
      kind: 'unattributed',
      parentKey: null,
      order: base + 10 + index,
      removed: definition !== null,
    })
  })

  return {
    stages,
    stageOf: (nodeId) => (known.has(nodeId) ? nodeId : (systemStageOf(nodeId) ?? nodeId)),
    loops,
    mindmapCategories,
  }
}

export function systemStage(key: ProcessSystemStage, order: number): ProcessStage {
  return { key, label: key, kind: 'system', parentKey: null, order, removed: false }
}

export function unattributedStage(order: number): ProcessStage {
  return {
    key: PROCESS_UNATTRIBUTED_STAGE,
    label: PROCESS_UNATTRIBUTED_STAGE,
    kind: 'unattributed',
    parentKey: null,
    order,
    removed: false,
  }
}

/**
 * Make sure every referenced stage key has a row, so nothing computed is ever dropped.
 * `definitionRead: false` says the catalogue was built without a definition: an unknown key
 * is then just an id, not a node somebody removed.
 */
export function completeStages(
  stages: readonly ProcessStage[],
  referenced: Iterable<string>,
  definitionRead = true,
): ProcessStage[] {
  const result = [...stages]
  const known = new Set(stages.map((stage) => stage.key))
  let order = result.reduce((max, stage) => Math.max(max, stage.order), -1) + 1
  for (const key of referenced) {
    if (known.has(key)) continue
    known.add(key)
    const system = key.startsWith('system:') ? (key as ProcessSystemStage) : null
    result.push(
      system !== null
        ? systemStage(system, order++)
        : key === PROCESS_UNATTRIBUTED_STAGE
          ? unattributedStage(order++)
          : {
              key,
              label: key,
              kind: 'unattributed',
              parentKey: null,
              order: order++,
              removed: definitionRead,
            },
    )
  }
  return result
}

export function stageLabels(stages: readonly ProcessStage[]): Record<string, ProcessLabel> {
  return Object.fromEntries(stages.map((stage) => [stage.key, stage.label]))
}
