// Catalog of "things you can drag onto the canvas" plus a factory that
// turns a palette item into a fresh WorkflowNode (used by P-2-05).
// Lives outside the React tree so the sidebar and the canvas can both
// reach it without a context provider.
//
// RFC-146 T4: everything kind-specific in this module — palette section,
// leading glyph, i18n label/description keys, node-id prefix, fresh-node
// default fields — lives in ONE `PALETTE_DESCRIPTORS` table
// (`satisfies Record<NodeKind, …>`, so a new NodeKind fails to compile until
// it declares its palette presence). deserialize / makeNode / buildPalette
// are projections of that table; the canvas chip glyphs (`NODE_GLYPHS`) come
// from the same rows instead of per-component hardcodes.

import type { Agent, NodeKind, WorkflowNode } from '@agent-workflow/shared'
import { NODE_KIND } from '@agent-workflow/shared'
import { resourceOptionLabel } from '@/lib/resource-option-label'
import { ulid } from 'ulid'

// RFC-060 PR-E: agent-multi removed from the palette — fan-out is now done
// via wrapper-fanout (which lives in the Wrappers section).
export type PaletteItem =
  // RFC-223 (PR-2): agentId is the canonical reference stamped onto the fresh
  // node (agentName is retained for display). Optional so a legacy drag payload
  // without it still deserializes; buildPalette always supplies it.
  | { kind: 'agent-single'; agentName: string; agentId?: string }
  | { kind: 'input' }
  | { kind: 'output' }
  | { kind: 'wrapper-git' }
  | { kind: 'wrapper-loop' }
  | { kind: 'wrapper-fanout' }
  | { kind: 'review' }
  | { kind: 'clarify' }
  | { kind: 'clarify-cross-agent' }

/** mime carried in HTML5 dataTransfer. Custom to avoid colliding with files. */
export const PALETTE_MIME = 'application/x-agent-workflow-node'

/** Sidebar section a kind's palette entry renders under. */
export type PaletteSectionKey = 'agents' | 'wrappers' | 'io' | 'human'

interface PaletteDescriptor {
  section: PaletteSectionKey
  /** Leading kind icon — palette rows AND canvas chips (2026-05-24
   *  chip-alignment fix made these one column; RFC-146 made them one table). */
  glyph: string
  /** i18n keys for the sidebar entry. null for agent-single: its rows are
   *  one-per-registered-agent with user-supplied name/description. */
  labelKey: string | null
  descKey: string | null
  /** Node-id prefix for fresh drops (`<prefix>_<ulid tail>`). */
  idPrefix: string
  /** Kind-specific default fields for a fresh node (id/kind/position are
   *  stamped by makeNode). */
  makeDefaults: (ctx: { existingIds: Set<string> }) => Record<string, unknown>
}

export const PALETTE_DESCRIPTORS = {
  'agent-single': {
    section: 'agents',
    glyph: '⚙',
    labelKey: null,
    descKey: null,
    idPrefix: 'agent',
    // agentName is stamped from the PaletteItem in makeNode.
    makeDefaults: () => ({}),
  },
  input: {
    section: 'io',
    glyph: '↳',
    labelKey: 'editor.paletteInputLabel',
    descKey: 'editor.paletteInputDesc',
    idPrefix: 'in',
    // Use a unique default key so duplicate input nodes don't collide
    // with rule 4 (input-key-duplicate).
    makeDefaults: ({ existingIds }) => ({ inputKey: uniqueInputKey(existingIds) }),
  },
  output: {
    section: 'io',
    glyph: '⤴',
    labelKey: 'editor.paletteOutputLabel',
    descKey: 'editor.paletteOutputDesc',
    idPrefix: 'out',
    makeDefaults: () => ({ ports: [] }),
  },
  'wrapper-git': {
    section: 'wrappers',
    glyph: '⎈',
    labelKey: 'editor.paletteWrapperGitLabel',
    descKey: 'editor.paletteWrapperGitDesc',
    idPrefix: 'wrap_git',
    makeDefaults: () => ({ nodeIds: [] }),
  },
  'wrapper-loop': {
    section: 'wrappers',
    glyph: '⟳',
    labelKey: 'editor.paletteWrapperLoopLabel',
    descKey: 'editor.paletteWrapperLoopDesc',
    idPrefix: 'wrap_loop',
    makeDefaults: () => ({
      nodeIds: [],
      maxIterations: 3,
      exitCondition: { kind: 'port-empty' },
    }),
  },
  'wrapper-fanout': {
    section: 'wrappers',
    glyph: '⫶',
    labelKey: 'editor.paletteWrapperFanoutLabel',
    descKey: 'editor.paletteWrapperFanoutDesc',
    idPrefix: 'wrap_fan',
    // RFC-060 — fresh wrapper-fanout. Author must wire the shardSource
    // upstream + populate inner subgraph before launch (validator rules
    // `wrapper-empty` + `wrapper-fanout-shard-source-missing` catch the
    // unfinished case). Default shape ships a single shardSource input
    // pre-named `docs` with `list<path<md>>` kind — that's the most
    // common case (markdown documents per shard). Users free to change.
    makeDefaults: () => ({
      nodeIds: [],
      inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
    }),
  },
  review: {
    section: 'human',
    glyph: '⚖',
    labelKey: 'editor.paletteReviewLabel',
    descKey: 'editor.paletteReviewDesc',
    idPrefix: 'rev',
    // inputSource is unset on drop — the user wires it up in
    // NodeInspector. Validator catches the missing-inputSource case
    // before Launch.
    makeDefaults: () => ({
      inputSource: { nodeId: '', portName: '' },
      title: '',
      description: '',
      rerunnableOnReject: [],
      rerunnableOnIterate: [],
      rollbackFilesOnReject: true,
      rollbackFilesOnIterate: false,
    }),
  },
  clarify: {
    section: 'human',
    glyph: '⚡',
    labelKey: 'editor.paletteClarifyLabel',
    descKey: 'editor.paletteClarifyDesc',
    idPrefix: 'clarify',
    // RFC-023 — a fresh clarify node has no wiring; the asking agent gets
    // linked via reverse-drag (clarifyDragHelper.applyClarifyReverseDrag).
    // The validator's `clarify-input-source-missing` / `clarify-questions-port-missing`
    // rules catch the user dropping one and never wiring it.
    makeDefaults: () => ({ title: '', description: '' }),
  },
  'clarify-cross-agent': {
    section: 'human',
    glyph: '⚡',
    // RFC-056 cross-clarify node — questioner reverse-drag + manual
    // to_designer wire. i18n labels live under `crossClarify.canvas.*`.
    labelKey: 'crossClarify.canvas.paletteLabel',
    descKey: 'crossClarify.canvas.paletteHint',
    idPrefix: 'cross_clarify',
    // RFC-056 — fresh cross-clarify node has no wiring; user reverse-drags
    // questioner side (auto 2 edges) + manually drags to_designer →
    // designer. Validator rules `cross-clarify-input-source-missing` and
    // `cross-clarify-manual-edge-missing` cover the gap.
    makeDefaults: () => ({ title: '', description: '' }),
  },
} as const satisfies Record<NodeKind, PaletteDescriptor>

/** Canvas chip / palette leading icon per kind — one projection of the
 *  descriptor table (node components import this instead of hardcoding). */
export const NODE_GLYPHS: Record<NodeKind, string> = Object.fromEntries(
  NODE_KIND.map((k) => [k, PALETTE_DESCRIPTORS[k].glyph]),
) as Record<NodeKind, string>

export function serialize(item: PaletteItem): string {
  return JSON.stringify(item)
}

export function deserialize(raw: string): PaletteItem | null {
  try {
    const v = JSON.parse(raw) as unknown
    if (typeof v !== 'object' || v === null) return null
    const rec = v as Record<string, unknown>
    // Object.hasOwn (not `in`): dataTransfer payloads are untrusted text —
    // `'constructor' in PALETTE_DESCRIPTORS` is true via the prototype
    // chain, and indexing the table with such a key hands makeNode a
    // non-descriptor value (editor crash). RFC-146 impl-gate fix.
    if (typeof rec.kind !== 'string' || !Object.hasOwn(PALETTE_DESCRIPTORS, rec.kind)) return null
    if (rec.kind === 'agent-single') {
      return typeof rec.agentName === 'string'
        ? ({
            kind: rec.kind,
            agentName: rec.agentName,
            // RFC-223 (PR-2): carry the canonical id when the drag payload has it.
            ...(typeof rec.agentId === 'string' && rec.agentId.length > 0
              ? { agentId: rec.agentId }
              : {}),
          } as PaletteItem)
        : null
    }
    return { kind: rec.kind } as PaletteItem
  } catch {
    return null
  }
}

/** Default field values for new nodes, keyed by kind (descriptor table). */
export function makeNode(
  item: PaletteItem,
  position: { x: number; y: number },
  ctx: { agents?: Agent[]; existingIds: Set<string> } = { existingIds: new Set() },
): WorkflowNode {
  const id = nextId(item.kind, ctx.existingIds)
  const pos = { x: Math.round(position.x), y: Math.round(position.y) }
  const node: Record<string, unknown> = {
    id,
    kind: item.kind,
    position: pos,
    ...PALETTE_DESCRIPTORS[item.kind].makeDefaults({ existingIds: ctx.existingIds }),
  }
  if (item.kind === 'agent-single') {
    node.agentName = item.agentName
    // RFC-223 (PR-2): stamp the canonical agent id onto the fresh node so the
    // runtime dispatches by id (rename-safe). agentName stays for display.
    if (item.agentId !== undefined) node.agentId = item.agentId
  }
  return node as unknown as WorkflowNode
}

function nextId(kind: PaletteItem['kind'], existing: Set<string>): string {
  // Short stable prefix per kind + ULID tail so multi drops don't collide
  // even within the same millisecond.
  const prefix = PALETTE_DESCRIPTORS[kind].idPrefix
  const candidate = `${prefix}_${ulid().slice(-6).toLowerCase()}`
  if (!existing.has(candidate)) return candidate
  // Extremely unlikely collision; suffix-bump.
  let i = 2
  while (existing.has(`${candidate}-${i}`)) i++
  return `${candidate}-${i}`
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
  key: PaletteSectionKey
  label: string
  items: PaletteSectionItem[]
}

export interface PaletteSectionItem {
  item: PaletteItem
  label: string
  description: string
}

/**
 * Translator surface used here: just (key) → string. Tests pass an identity
 * stub; the real sidebar passes react-i18next's `t`. Section + non-agent
 * entry labels go through it; agent labels/descriptions are user-supplied
 * literals and stay verbatim.
 */
export type PaletteTranslator = (key: string) => string

export const PALETTE_SECTIONS = [
  { key: 'agents', labelKey: 'editor.paletteAgents' },
  // RFC-060 PR-E: removed the "agent-multi fanout" palette section —
  // fan-out is now done via wrapper-fanout (a Wrappers entry). Drop a
  // wrapper-fanout, then drag the agent-single nodes you want into it.
  { key: 'wrappers', labelKey: 'editor.paletteWrappers' },
  { key: 'io', labelKey: 'editor.paletteIo' },
  { key: 'human', labelKey: 'editor.paletteHuman' },
] as const satisfies ReadonlyArray<{ key: PaletteSectionKey; labelKey: string }>

export function buildPalette(
  agents: Agent[],
  t: PaletteTranslator,
  ownerLabel?: (ownerUserId: string | null | undefined) => string | undefined,
): PaletteSection[] {
  return PALETTE_SECTIONS.map(({ key, labelKey }) => {
    if (key === 'agents') {
      return {
        key,
        label: t(labelKey),
        items: agents.map((a) => ({
          item: { kind: 'agent-single', agentName: a.name, agentId: a.id } as PaletteItem,
          // Prefix with the agent kind icon so each row in the palette starts
          // with a glyph that mirrors the canvas chip (⚙ for agent). This
          // keeps the leading-icon column consistent across Agents / Wrappers
          // / IO / Human sections — see 2026-05-24 chip-alignment fix.
          label: `${PALETTE_DESCRIPTORS['agent-single'].glyph} ${resourceOptionLabel(
            a.name,
            ownerLabel?.(a.ownerUserId) ?? a.ownerUserId ?? undefined,
          )}`,
          description: a.description || t('editor.paletteAgentFallbackDesc'),
        })),
      }
    }
    return {
      key,
      label: t(labelKey),
      // NODE_KIND declaration order fixes the within-section order
      // (wrappers: git → loop → fanout; io: input → output;
      //  human: review → clarify → cross), matching the historical layout.
      items: NODE_KIND.filter((k) => PALETTE_DESCRIPTORS[k].section === key).map((k) => {
        const d = PALETTE_DESCRIPTORS[k]
        return {
          item: { kind: k } as PaletteItem,
          // Glyph lives in the descriptor table (code), not in every locale
          // string — RFC-146 stripped the embedded icons from the i18n
          // values so the icon column can't drift per locale.
          label: `${d.glyph} ${t(d.labelKey ?? '')}`,
          description: t(d.descKey ?? ''),
        }
      }),
    }
  })
}
