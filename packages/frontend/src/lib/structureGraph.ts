// RFC-083 PR-F/PR-G — pure model for the structural-diff graph as a CLASS
// COLLABORATION DIAGRAM with a HIERARCHICAL (dagre) layout. A node is a CARD (a
// class / file) listing its changed members + the members that call changed code
// elsewhere. EDGES are the real relationships among changed classes:
//   - 'inherits'   : extends / implements           (from backend classEdges)
//   - 'references' : constructs / holds / uses       (from backend classEdges)
//   - 'calls'      : a method calls a changed method (from impact)
// dagre ranks the cards top→down by these edges so the architecture/hierarchy
// reads at a glance. All logic here so the xyflow component stays a thin adapter.

import dagre from '@dagrejs/dagre'
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
export type EdgeKind = 'inherits' | 'references' | 'calls'

export interface GraphMember {
  id: string
  label: string
  kind: SymbolKind
  changeType?: ChangeType
  role: MemberRole
}
export type CardKind = SymbolKind | 'file'
export interface GraphCard {
  id: string
  title: string
  file: string
  /** package = the file's directory; cards in the same package are grouped. */
  pkg: string
  kind: CardKind
  changeType?: ChangeType
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
  kind: EdgeKind
  /** for 'calls' edges: the specific member rows involved (caller → callee), so
   *  highlighting the edge can also highlight the related methods. */
  memberLinks?: Array<{ source?: string; target?: string }>
}
/** A package container (a directory); its box wraps the cards inside it. */
export interface GraphPackage {
  id: string
  label: string
  x: number
  y: number
  w: number
  h: number
}
export interface StructureGraph {
  cards: GraphCard[]
  edges: GraphCardEdge[]
  packages: GraphPackage[]
}
/** A node in the PACKAGE-level overview: one box per package. */
export interface PkgGraphNode {
  id: string
  label: string
  classCount: number
  x: number
  y: number
  w: number
  h: number
}
export interface PackageGraph {
  nodes: PkgGraphNode[]
  edges: GraphCardEdge[]
}

const CARD_W = 240
const HEADER_H = 34
const ROW_H = 22
const PAD_V = 12
const EDGE_RANK: Record<EdgeKind, number> = { inherits: 3, references: 2, calls: 1 }

export function fileBase(p: string): string {
  return p.split('/').pop() ?? p
}
/** package id = the file's directory ('(root)' for top-level files). */
export function packageOf(file: string): string {
  const i = file.lastIndexOf('/')
  return i > 0 ? file.slice(0, i) : '(root)'
}
/** A readable package label: strip the build/source root and show the dotted
 *  package (Java/Kotlin/…), e.g. `…/src/main/java/com/wbq/snake/ai` → `com.wbq.snake.ai`. */
export function packageLabel(pkg: string): string {
  if (pkg === '(root)') return pkg
  for (const m of ['src/main/java/', 'src/main/kotlin/', 'src/main/scala/', 'src/main/', 'src/']) {
    const i = pkg.indexOf(m)
    if (i >= 0) {
      const rest = pkg.slice(i + m.length).replace(/\//g, '.')
      return rest.length > 0 ? rest : '(root)'
    }
  }
  return pkg.split('/').slice(-2).join('/') // fallback: last 2 path segments
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

function cardHeight(memberCount: number): number {
  return HEADER_H + memberCount * ROW_H + PAD_V
}

const PKG_HEADER_H = 22 // room for the package label inside its box

/** Hierarchical top→down layout via dagre COMPOUND: classes are grouped into
 *  their package cluster, clusters laid out relative to each other. Mutates each
 *  card's x/y (using its CURRENT w/h) and each package's x/y/w/h (the box that
 *  wraps its cards). Call once with estimated sizes, then again with xyflow's
 *  MEASURED sizes so edges land on real card edges. */
export function layoutGraph(
  cards: GraphCard[],
  edges: GraphCardEdge[],
  packages: GraphPackage[],
): void {
  const g = new dagre.graphlib.Graph({ compound: true })
  g.setGraph({ rankdir: 'TB', nodesep: 36, ranksep: 56, marginx: 16, marginy: 16 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const p of packages) g.setNode(p.id, {}) // cluster node
  for (const c of cards) {
    g.setNode(c.id, { width: c.w, height: c.h })
    g.setParent(c.id, c.pkg)
  }
  for (const e of edges) g.setEdge(e.source, e.target)
  dagre.layout(g)
  for (const c of cards) {
    const n = g.node(c.id)
    // dagre gives the node CENTER; xyflow positions are top-left.
    c.x = n.x - c.w / 2
    c.y = n.y - c.h / 2
  }
  for (const p of packages) {
    const n = g.node(p.id)
    if (n === undefined) continue
    // cluster bbox (center + size) → top-left; reserve a strip for the label.
    p.x = n.x - n.width / 2
    p.y = n.y - n.height / 2 - PKG_HEADER_H
    p.w = n.width
    p.h = n.height + PKG_HEADER_H
  }
}

export const ALL_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set(['inherits', 'references', 'calls'])

const PKG_NODE_W = 200
const PKG_NODE_H = 52

/** Collapse the class graph to a PACKAGE-level overview: one node per package
 *  (with its changed-class count) + aggregated inter-package edges (strongest
 *  kind per pair). Far fewer nodes/edges → readable architecture. */
export function aggregatePackageGraph(graph: StructureGraph): PackageGraph {
  const cardPkg = new Map(graph.cards.map((c) => [c.id, c.pkg]))
  const classCount = new Map<string, number>()
  for (const c of graph.cards) {
    classCount.set(c.pkg, (classCount.get(c.pkg) ?? 0) + (c.isChanged ? 1 : 0))
  }
  const edgeMap = new Map<string, GraphCardEdge>()
  for (const e of graph.edges) {
    const a = cardPkg.get(e.source)
    const b = cardPkg.get(e.target)
    if (a === undefined || b === undefined || a === b) continue
    const id = `${a}=>${b}`
    const ex = edgeMap.get(id)
    if (ex === undefined || EDGE_RANK[e.kind] > EDGE_RANK[ex.kind]) {
      edgeMap.set(id, { id, source: a, target: b, kind: e.kind })
    }
  }
  const nodes: PkgGraphNode[] = [...classCount].map(([id, n]) => ({
    id,
    label: packageLabel(id),
    classCount: n,
    x: 0,
    y: 0,
    w: PKG_NODE_W,
    h: PKG_NODE_H,
  }))
  const edges = [...edgeMap.values()]
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 44, ranksep: 64, marginx: 16, marginy: 16 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of nodes) g.setNode(n.id, { width: n.w, height: n.h })
  for (const e of edges) g.setEdge(e.source, e.target)
  dagre.layout(g)
  for (const n of nodes) {
    const d = g.node(n.id)
    n.x = d.x - n.w / 2
    n.y = d.y - n.h / 2
  }
  return { nodes, edges }
}

/** Member rows to highlight for the active (highlighted) edges — ONLY the exact
 *  methods that edge involves (memberLinks): caller↔callee for 'calls', the
 *  referencing member for 'references'. Class-level edges with no specific member
 *  (e.g. inheritance) highlight nothing. We never highlight a whole class's
 *  members — only what the edge actually links. */
export function relatedMembers(
  edges: ReadonlyArray<GraphCardEdge>,
  highlightedEdgeIds: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>()
  if (highlightedEdgeIds.size === 0) return ids
  for (const e of edges) {
    if (!highlightedEdgeIds.has(e.id)) continue
    for (const l of e.memberLinks ?? []) {
      if (l.source !== undefined) ids.add(l.source)
      if (l.target !== undefined) ids.add(l.target)
    }
  }
  return ids
}

export function buildStructureGraph(
  diff: StructuralDiff,
  edgeKinds: ReadonlySet<EdgeKind> = ALL_EDGE_KINDS,
): StructureGraph {
  const cards = new Map<string, GraphCard>()
  const ensureCard = (key: string, title: string, file: string, kind: CardKind): GraphCard => {
    let c = cards.get(key)
    if (c === undefined) {
      c = {
        id: key,
        title,
        file,
        pkg: packageOf(file),
        kind,
        isChanged: false,
        members: [],
        x: 0,
        y: 0,
        w: 0,
        h: 0,
      }
      cards.set(key, c)
    }
    return c
  }

  // 1) changed symbols → cards + changed member rows.
  const changedSymbolCard = new Map<string, string>()
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

  // 2) edges. Prefer inherits > references > calls for a given pair.
  const edgeMap = new Map<string, GraphCardEdge>()
  const callLinks = new Map<string, Array<{ source?: string; target?: string }>>()
  const addEdge = (source: string, target: string, kind: EdgeKind): void => {
    if (source === target || !cards.has(source) || !cards.has(target)) return
    const id = `${source}=>${target}`
    const existing = edgeMap.get(id)
    if (existing === undefined || EDGE_RANK[kind] > EDGE_RANK[existing.kind]) {
      edgeMap.set(id, { id, source, target, kind })
    }
  }
  // class-level relationships (the architecture); guard for older API responses
  for (const e of diff.classEdges ?? []) {
    if (!edgeKinds.has(e.kind)) continue
    addEdge(e.from, e.to, e.kind)
    // a 'references' edge may touch several upstream members (every method/field
    // where the reference sits) + the downstream constructor → one link each
    if ((e.fromMembers !== undefined && e.fromMembers.length > 0) || e.toMember !== undefined) {
      const edgeId = `${e.from}=>${e.to}`
      const arr = callLinks.get(edgeId) ?? []
      for (const fm of e.fromMembers ?? []) arr.push({ source: fm })
      if (e.toMember !== undefined) arr.push({ target: e.toMember })
      callLinks.set(edgeId, arr)
    }
  }
  // method-level call edges + caller cards (from impact) — only when 'calls' is on,
  // so filtering it out also drops the otherwise-orphaned caller cards.
  if (edgeKinds.has('calls'))
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
        if (callerKey === targetCardId) continue
        const callerCard = ensureCard(callerKey, callerTitle, callerFile, callerKind)
        if (callerLabel !== null && !callerCard.members.some((m) => m.label === callerLabel)) {
          callerCard.members.push({
            id: `${callerKey}::${callerLabel}`,
            label: callerLabel,
            kind: 'method',
            role: 'caller',
          })
        }
        addEdge(callerKey, targetCardId, 'calls')
        // record which member rows this call links (caller method → changed method)
        const edgeId = `${callerKey}=>${targetCardId}`
        const arr = callLinks.get(edgeId) ?? []
        arr.push({
          source: callerLabel !== null ? `${callerKey}::${callerLabel}` : undefined,
          target: item.changedSymbolId,
        })
        callLinks.set(edgeId, arr)
      }
    }

  const list = [...cards.values()]
  const edges = [...edgeMap.values()]
  for (const e of edges) {
    const links = callLinks.get(e.id)
    if (links !== undefined) e.memberLinks = links
  }
  // one package per distinct directory the cards live in.
  const packages: GraphPackage[] = [...new Set(list.map((c) => c.pkg))].map((id) => ({
    id,
    label: packageLabel(id),
    x: 0,
    y: 0,
    w: 0,
    h: 0,
  }))
  // estimated sizes for the FIRST layout; the view re-layouts with measured ones.
  for (const c of list) {
    c.w = CARD_W
    c.h = cardHeight(c.members.length)
  }
  layoutGraph(list, edges, packages)
  return { cards: list, edges, packages }
}
