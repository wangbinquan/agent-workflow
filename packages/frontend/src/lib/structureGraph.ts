// RFC-083 PR-F — pure model for the structural-diff graph, redesigned as a
// CLASS-COLLABORATION DIAGRAM (not scattered one-box-per-symbol). The unit is a
// CARD = a class / file (container). Each card lists:
//   - its CHANGED members (methods/fields), colored + badged by change type;
//   - its CALLER members (methods that call changed code elsewhere), neutral.
// Edges run card → card when a method in one card calls a changed member in
// another (call direction). So at a glance you read: which classes changed, what
// changed inside each, and how the classes depend on each other. Containment
// comes from `qualifiedName` (`OrderService.charge` → class `OrderService`); no
// backend change needed. Manual layout (no dagre/elk dep); logic here so the
// xyflow component stays a thin adapter.

import type { StructuralDiff, SymbolKind, ChangeType } from '@agent-workflow/shared'

const CONTAINER_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  'class',
  'interface',
  'trait',
  'struct',
  'enum',
  'object',
  'namespace',
  'module',
])
const MEMBER_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  'method',
  'function',
  'constructor',
  'field',
  'property',
  'constant',
])

export type MemberRole = 'changed' | 'caller'
export interface GraphMember {
  id: string
  label: string
  kind: SymbolKind
  /** set for role 'changed' */
  changeType?: ChangeType
  role: MemberRole
}
export type CardKind = SymbolKind | 'file'
export interface GraphCard {
  id: string
  title: string
  file: string
  kind: CardKind
  /** set when the container symbol itself was added/modified/removed/renamed */
  changeType?: ChangeType
  /** true when the card holds changed members or itself changed (vs caller-only) */
  isChanged: boolean
  members: GraphMember[]
  x: number
  y: number
  w: number
  h: number
}
export interface GraphCardEdge {
  id: string
  source: string
  target: string
}
export interface StructureGraph {
  cards: GraphCard[]
  edges: GraphCardEdge[]
}

// ---- id / name parsing (`${filePath}#${qualifiedName}:${kind}:${line}`) ----
export function fileBase(p: string): string {
  return p.split('/').pop() ?? p
}
function qnFromId(id: string): string {
  const afterHash = id.split('#')[1]
  if (afterHash === undefined) return id
  return afterHash.split(':')[0] ?? id
}
function fileFromId(id: string): string {
  return id.split('#')[0] ?? id
}
function leafOf(qualifiedName: string): string {
  const idx = qualifiedName.lastIndexOf('.')
  return idx >= 0 ? qualifiedName.slice(idx + 1) : qualifiedName
}

/** The card a member belongs to: its enclosing class, or the file if top-level. */
function memberContainer(
  filePath: string,
  qualifiedName: string,
): { key: string; title: string; kind: CardKind } {
  const idx = qualifiedName.lastIndexOf('.')
  if (idx > 0) {
    const container = qualifiedName.slice(0, idx)
    return { key: `${filePath}::${container}`, title: container, kind: 'class' }
  }
  return { key: `${filePath}::<file>`, title: fileBase(filePath), kind: 'file' }
}

// ---- layout ----
const CARD_W = 240
const GAP_X = 56
const GAP_Y = 28
const HEADER_H = 34
const ROW_H = 22
const PAD_V = 12

function layoutCards(cards: GraphCard[]): void {
  for (const c of cards) {
    c.w = CARD_W
    c.h = HEADER_H + c.members.length * ROW_H + PAD_V
  }
  // Balanced MASONRY across an adaptive number of columns, biased WIDE so a big
  // canvas is actually used (not 1–2 tall columns). Cards come in changed-first
  // (see the sort in buildStructureGraph), so changed cards fill the top rows.
  const n = cards.length
  const cols = Math.min(5, Math.max(1, Math.ceil(Math.sqrt(n * 1.8))))
  const colY = new Array<number>(cols).fill(0)
  for (const c of cards) {
    // place in the currently shortest column
    let col = 0
    for (let i = 1; i < cols; i += 1) if ((colY[i] ?? 0) < (colY[col] ?? 0)) col = i
    c.x = col * (CARD_W + GAP_X)
    c.y = colY[col] ?? 0
    colY[col] = (colY[col] ?? 0) + c.h + GAP_Y
  }
}

export function buildStructureGraph(diff: StructuralDiff): StructureGraph {
  const cards = new Map<string, GraphCard>()
  const ensureCard = (key: string, title: string, file: string, kind: CardKind): GraphCard => {
    let c = cards.get(key)
    if (c === undefined) {
      c = { id: key, title, file, kind, isChanged: false, members: [], x: 0, y: 0, w: 0, h: 0 }
      cards.set(key, c)
    }
    return c
  }

  // 1) changed symbols → cards + changed member rows.
  const changedSymbolCard = new Map<string, string>() // changed symbol id → card id
  for (const f of diff.files) {
    for (const ch of f.changes) {
      const sym = ch.after ?? ch.before
      if (sym === undefined) continue
      if (CONTAINER_KINDS.has(sym.kind)) {
        const card = ensureCard(
          `${sym.filePath}::${sym.qualifiedName}`,
          sym.qualifiedName,
          sym.filePath,
          sym.kind,
        )
        card.changeType = ch.changeType
        card.isChanged = true
        changedSymbolCard.set(sym.id, card.id)
      } else if (MEMBER_KINDS.has(sym.kind)) {
        const c = memberContainer(sym.filePath, sym.qualifiedName)
        const card = ensureCard(c.key, c.title, sym.filePath, c.kind)
        card.isChanged = true
        card.members.push({
          id: sym.id,
          label: sym.name,
          kind: sym.kind,
          changeType: ch.changeType,
          role: 'changed',
        })
        changedSymbolCard.set(sym.id, card.id)
      }
    }
  }

  // 2) impact → caller cards (+ caller member rows) + card→card edges.
  const edgeKeys = new Set<string>()
  const edges: GraphCardEdge[] = []
  for (const item of diff.impact) {
    const targetCardId = changedSymbolCard.get(item.changedSymbolId)
    if (targetCardId === undefined) continue
    for (const caller of item.callers) {
      let callerKey: string
      let callerTitle: string
      let callerFile: string
      let callerKind: CardKind
      let callerLabel: string | null
      if (caller.symbolId !== undefined) {
        const file = fileFromId(caller.symbolId)
        const qn = qnFromId(caller.symbolId)
        const c = memberContainer(file, qn)
        callerKey = c.key
        callerTitle = c.title
        callerFile = file
        callerKind = c.kind
        callerLabel = leafOf(qn)
      } else {
        callerKey = `${caller.filePath}::<file>`
        callerTitle = fileBase(caller.filePath)
        callerFile = caller.filePath
        callerKind = 'file'
        callerLabel = null
      }
      if (callerKey === targetCardId) continue // call within the same card — skip

      const callerCard = ensureCard(callerKey, callerTitle, callerFile, callerKind)
      if (callerLabel !== null && !callerCard.members.some((m) => m.label === callerLabel)) {
        callerCard.members.push({
          id: `${callerKey}::${callerLabel}`,
          label: callerLabel,
          kind: 'method',
          role: 'caller',
        })
      }
      const ek = `${callerKey}->${targetCardId}`
      if (!edgeKeys.has(ek)) {
        edgeKeys.add(ek)
        edges.push({ id: ek, source: callerKey, target: targetCardId })
      }
    }
  }

  const list = [...cards.values()]
  // changed cards first (more important), then by title — stable + readable.
  list.sort((a, b) => Number(b.isChanged) - Number(a.isChanged) || a.title.localeCompare(b.title))
  layoutCards(list)
  return { cards: list, edges }
}
