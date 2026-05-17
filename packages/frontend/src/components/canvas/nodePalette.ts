// Catalog of "things you can drag onto the canvas" plus a factory that
// turns a palette item into a fresh WorkflowNode (used by P-2-05).
// Lives outside the React tree so the sidebar and the canvas can both
// reach it without a context provider.

import type { Agent, WorkflowNode } from '@agent-workflow/shared'
import { ulid } from 'ulid'

export type PaletteItem =
  | { kind: 'agent-single'; agentName: string }
  | { kind: 'agent-multi'; agentName: string }
  | { kind: 'input' }
  | { kind: 'output' }
  | { kind: 'wrapper-git' }
  | { kind: 'wrapper-loop' }
  | { kind: 'review' }
  | { kind: 'clarify' }

/** mime carried in HTML5 dataTransfer. Custom to avoid colliding with files. */
export const PALETTE_MIME = 'application/x-agent-workflow-node'

export function serialize(item: PaletteItem): string {
  return JSON.stringify(item)
}

export function deserialize(raw: string): PaletteItem | null {
  try {
    const v = JSON.parse(raw) as unknown
    if (typeof v !== 'object' || v === null) return null
    const rec = v as Record<string, unknown>
    if (typeof rec.kind !== 'string') return null
    switch (rec.kind) {
      case 'agent-single':
      case 'agent-multi':
        return typeof rec.agentName === 'string'
          ? ({ kind: rec.kind, agentName: rec.agentName } as PaletteItem)
          : null
      case 'input':
      case 'output':
      case 'wrapper-git':
      case 'wrapper-loop':
      case 'review':
      case 'clarify':
        return { kind: rec.kind } as PaletteItem
      default:
        return null
    }
  } catch {
    return null
  }
}

/** Default field values for new nodes, keyed by kind. */
export function makeNode(
  item: PaletteItem,
  position: { x: number; y: number },
  ctx: { agents?: Agent[]; existingIds: Set<string> } = { existingIds: new Set() },
): WorkflowNode {
  const id = nextId(item.kind, ctx.existingIds)
  const pos = { x: Math.round(position.x), y: Math.round(position.y) }
  switch (item.kind) {
    case 'agent-single':
    case 'agent-multi': {
      const node: WorkflowNode = {
        id,
        kind: item.kind,
        position: pos,
      }
      ;(node as Record<string, unknown>).agentName = item.agentName
      return node
    }
    case 'input':
      return {
        id,
        kind: 'input',
        position: pos,
        // Use a unique default key so duplicate input nodes don't collide
        // with rule 4 (input-key-duplicate).
        inputKey: uniqueInputKey(ctx.existingIds),
      } as WorkflowNode
    case 'output':
      return { id, kind: 'output', position: pos, ports: [] } as WorkflowNode
    case 'wrapper-git':
      return { id, kind: 'wrapper-git', position: pos, nodeIds: [] } as WorkflowNode
    case 'wrapper-loop':
      return {
        id,
        kind: 'wrapper-loop',
        position: pos,
        nodeIds: [],
        maxIterations: 3,
        exitCondition: { kind: 'port-empty' },
      } as WorkflowNode
    case 'review':
      return {
        id,
        kind: 'review',
        position: pos,
        // inputSource is unset on drop — the user wires it up in
        // NodeInspector. Validator catches the missing-inputSource case
        // before Launch.
        inputSource: { nodeId: '', portName: '' },
        title: '',
        description: '',
        rerunnableOnReject: [],
        rerunnableOnIterate: [],
        rollbackFilesOnReject: true,
        rollbackFilesOnIterate: false,
      } as unknown as WorkflowNode
    case 'clarify':
      // RFC-023 — a fresh clarify node has no wiring; the asking agent gets
      // linked via reverse-drag (clarifyDragHelper.applyClarifyReverseDrag).
      // The validator's `clarify-input-source-missing` / `clarify-questions-port-missing`
      // rules catch the user dropping one and never wiring it.
      return {
        id,
        kind: 'clarify',
        position: pos,
        title: '',
        description: '',
      } as unknown as WorkflowNode
  }
}

function nextId(kind: PaletteItem['kind'], existing: Set<string>): string {
  // Short stable prefix per kind + ULID tail so multi drops don't collide
  // even within the same millisecond.
  const prefix = SHORT[kind]
  const candidate = `${prefix}_${ulid().slice(-6).toLowerCase()}`
  if (!existing.has(candidate)) return candidate
  // Extremely unlikely collision; suffix-bump.
  let i = 2
  while (existing.has(`${candidate}-${i}`)) i++
  return `${candidate}-${i}`
}

const SHORT: Record<PaletteItem['kind'], string> = {
  'agent-single': 'agent',
  'agent-multi': 'fan',
  input: 'in',
  output: 'out',
  'wrapper-git': 'wrap_git',
  'wrapper-loop': 'wrap_loop',
  review: 'rev',
  clarify: 'clarify',
}

function uniqueInputKey(existing: Set<string>): string {
  // existing here is node ids, not input keys — fall back to a numeric
  // suffix from the id set (best-effort).
  let i = 1
  while (existing.has(`requirement_${i}`)) i++
  return i === 1 ? 'requirement' : `requirement_${i}`
}

/** A flat list of palette entries used by the sidebar UI. */
export interface PaletteSection {
  label: string
  items: Array<{
    item: PaletteItem
    label: string
    description: string
  }>
}

/**
 * Translator surface used here: just (key) → string. Tests pass an identity
 * stub; the real sidebar passes react-i18next's `t`. Section + non-agent
 * entry labels go through it; agent labels/descriptions are user-supplied
 * literals and stay verbatim.
 */
export type PaletteTranslator = (key: string) => string

export function buildPalette(agents: Agent[], t: PaletteTranslator): PaletteSection[] {
  return [
    {
      label: t('editor.paletteAgents'),
      items: agents.map((a) => ({
        item: { kind: 'agent-single', agentName: a.name } as PaletteItem,
        label: a.name,
        description: a.description || t('editor.paletteAgentFallbackDesc'),
      })),
    },
    {
      label: t('editor.paletteFanOut'),
      items: agents.map((a) => ({
        item: { kind: 'agent-multi', agentName: a.name } as PaletteItem,
        label: `🔀 ${a.name}`,
        description: t('editor.paletteFanOutDesc'),
      })),
    },
    {
      label: t('editor.paletteWrappers'),
      items: [
        {
          item: { kind: 'wrapper-git' } as PaletteItem,
          label: t('editor.paletteWrapperGitLabel'),
          description: t('editor.paletteWrapperGitDesc'),
        },
        {
          item: { kind: 'wrapper-loop' } as PaletteItem,
          label: t('editor.paletteWrapperLoopLabel'),
          description: t('editor.paletteWrapperLoopDesc'),
        },
      ],
    },
    {
      label: t('editor.paletteIo'),
      items: [
        {
          item: { kind: 'input' } as PaletteItem,
          label: t('editor.paletteInputLabel'),
          description: t('editor.paletteInputDesc'),
        },
        {
          item: { kind: 'output' } as PaletteItem,
          label: t('editor.paletteOutputLabel'),
          description: t('editor.paletteOutputDesc'),
        },
      ],
    },
    {
      label: t('editor.paletteHuman'),
      items: [
        {
          item: { kind: 'review' } as PaletteItem,
          label: t('editor.paletteReviewLabel'),
          description: t('editor.paletteReviewDesc'),
        },
        {
          item: { kind: 'clarify' } as PaletteItem,
          label: t('editor.paletteClarifyLabel'),
          description: t('editor.paletteClarifyDesc'),
        },
      ],
    },
  ]
}
