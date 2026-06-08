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
/** access level for grouping members (UML-ish); 'package' = no modifier. */
export type Visibility = 'public' | 'protected' | 'package' | 'private'
export const VISIBILITY_ORDER: readonly Visibility[] = ['public', 'protected', 'package', 'private']

export interface GraphMember {
  id: string
  label: string
  kind: SymbolKind
  changeType?: ChangeType
  role: MemberRole
  /** declaration header (params/return), shown on the row; from sym.signature. */
  signature?: string
  /** access level (from the signature keyword or language convention). */
  visibility?: Visibility
}

/** Access level of a member from its declaration signature, falling back to
 *  language conventions (Python `_`/`__`, Go capitalisation) and finally the
 *  language default ('package' for Java, else 'public'). */
export function memberVisibility(
  signature: string | undefined,
  name: string,
  lang: string,
): Visibility {
  if (name.startsWith('#')) return 'private' // JS/TS hard-private (#field / #method)
  const sig = signature ?? ''
  if (/\bprivate\b/.test(sig)) return 'private'
  if (/\bprotected\b/.test(sig)) return 'protected'
  if (/\b(?:public|internal)\b/.test(sig)) return 'public'
  if (lang === 'python') {
    if (name.startsWith('__') && !name.endsWith('__')) return 'private'
    if (name.startsWith('_')) return 'protected'
    return 'public'
  }
  if (lang === 'go') return /^[A-Z]/.test(name) ? 'public' : 'private'
  return lang === 'java' ? 'package' : 'public'
}

/** Row text: the signature minus the visibility keyword (it becomes the group),
 *  e.g. `public int getScore(GameContext ctx)` → `int getScore(GameContext ctx)`.
 *  Falls back to the bare name when there is no signature. */
export function memberSignature(signature: string | undefined, name: string): string {
  if (signature === undefined || signature === '') return name
  const s = signature
    .replace(/\b(?:public|protected|private|internal)\b\s*/g, '')
    .replace(/[;{]\s*$/, '')
    .trim()
  return s.length > 0 ? s : name
}

/** Group a card's members by visibility (public→protected→package→private) for
 *  display; caller rows (no visibility) come last under their own bucket. */
export function groupMembersByVisibility(
  members: readonly GraphMember[],
): Array<{ visibility: Visibility | 'callers'; members: GraphMember[] }> {
  const buckets = new Map<Visibility | 'callers', GraphMember[]>()
  for (const m of members) {
    const key: Visibility | 'callers' = m.role === 'caller' ? 'callers' : (m.visibility ?? 'public')
    const arr = buckets.get(key) ?? []
    arr.push(m)
    buckets.set(key, arr)
  }
  const out: Array<{ visibility: Visibility | 'callers'; members: GraphMember[] }> = []
  for (const v of VISIBILITY_ORDER) {
    const ms = buckets.get(v)
    if (ms !== undefined) out.push({ visibility: v, members: ms })
  }
  const callers = buckets.get('callers')
  if (callers !== undefined) out.push({ visibility: 'callers', members: callers })
  return out
}
export type CardKind = SymbolKind | 'file'
export interface GraphCard {
  id: string
  title: string
  file: string
  /** package = the file's directory; cards in the same package are grouped. */
  pkg: string
  kind: CardKind
  /** RFC-086 — an anonymous type (Java anon class / JS-TS anon class expr); the
   *  title already reads `«anonymous» <base>`, this flags it for badge styling. */
  anonymous?: boolean
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
/** Kind encoded in a symbol id (`${file}#${qn}:${kind}:${line}`). Lets the
 *  impact-caller path tell a nested-function caller from a class method so its
 *  owner folds to the file card instead of minting a phantom class (RFC-086). */
function kindFromId(id: string): SymbolKind | undefined {
  const afterHash = id.split('#')[1]
  return afterHash === undefined ? undefined : (afterHash.split(':')[1] as SymbolKind | undefined)
}
function leafOf(qualifiedName: string): string {
  const idx = qualifiedName.lastIndexOf('.')
  return idx >= 0 ? qualifiedName.slice(idx + 1) : qualifiedName
}
/** Drop the last dotted segment (`A.b.c` → `A.b`); '' when there is none. */
function stripLeaf(qualifiedName: string): string {
  const idx = qualifiedName.lastIndexOf('.')
  return idx > 0 ? qualifiedName.slice(0, idx) : ''
}

/** Leaf of a qualifiedName (segment after the last dot). */
function leafOfQn(qualifiedName: string): string {
  return qualifiedName.slice(qualifiedName.lastIndexOf('.') + 1)
}

/** A backend synthetic anonymous-scope leaf (`$anon<line>` / `$anon<line>_<col>`,
 *  see lang/extract.ts). It is NEVER a real class, so when it is not itself a
 *  changed symbol we must walk past it rather than mint a card titled with it. */
const SYNTHETIC_ANON = /^\$anon[\d_]+$/

/** RFC-086 — display title for a container card. A method-local NAMED class has a
 *  qualifiedName that passes through its enclosing method (e.g. `G.m.Helper`);
 *  design §6 wants it shown by its own leaf name (`Helper`), not method-qualified.
 *  Strip the qn up to and including the DEEPEST prefix that is a known MEMBER (the
 *  enclosing callable), leaving the local type's own (possibly dotted) name. A real
 *  inner class (`Outer.Inner` — no member in its path) is returned unchanged. */
function displayTitle(
  filePath: string,
  containerQn: string,
  qnKind: ReadonlyMap<string, SymbolKind>,
): string {
  const segs = containerQn.split('.')
  let cut = 0
  for (let i = 1; i < segs.length; i += 1) {
    const k = qnKind.get(`${filePath}::${segs.slice(0, i).join('.')}`)
    if (k !== undefined && MEMBER_KINDS.has(k)) cut = i
  }
  return cut > 0 ? segs.slice(cut).join('.') : containerQn
}

/** RFC-086 — resolve a member's owning CARD from its qualifiedName using the
 *  diff's actual symbol KINDS (`qnKind`), not a blind "everything before the
 *  last dot is a class" string split. We walk UP past any prefix that can't be a
 *  class container, so a method-local definition (an anonymous class's `run()`, a
 *  nested function/closure) never mints a phantom "class" card named after the
 *  enclosing callable. Skipped prefixes:
 *   - a KNOWN member (method/function/constructor/field …); and
 *   - an UNKNOWN synthetic `$anon…` segment — its anon container is absent from
 *     `qnKind` whenever only an inner member body changed (a container's bodyHash
 *     is header-only), which is the COMMON edit-inner-body case; treating it as a
 *     class brought the phantom card back. (When the anon IS a changed symbol,
 *     k==='class' and we keep it — that is the real «anonymous» card.)
 *  A real inner class (`Outer.Inner`, a CONTAINER kind) is NOT skipped; its card
 *  title is re-leafed by displayTitle when method-local. When the remaining
 *  container's kind is unknown, a *function* member's container is a non-class
 *  scope → file card. `preferFileForUnknownNested` (the impact-caller path, whose
 *  caller qns are NEVER in the diff so ancestor kinds are unknowable) folds an
 *  UNKNOWN multi-segment container to the file card too, since `S.m` / `G.m.Helper`
 *  can't be told apart from a real inner class there and must not mint a phantom
 *  method-named class. */
function memberContainer(
  filePath: string,
  qualifiedName: string,
  qnKind: ReadonlyMap<string, SymbolKind>,
  ownKind?: SymbolKind,
  preferFileForUnknownNested = false,
): { key: string; title: string; kind: CardKind } {
  const fileCard = {
    key: `${filePath}::<file>`,
    title: fileBase(filePath),
    kind: 'file' as CardKind,
  }
  let container = stripLeaf(qualifiedName)
  while (container !== '') {
    const k = qnKind.get(`${filePath}::${container}`)
    if (k !== undefined && MEMBER_KINDS.has(k)) {
      container = stripLeaf(container)
      continue
    }
    if (k === undefined && SYNTHETIC_ANON.test(leafOfQn(container))) {
      container = stripLeaf(container)
      continue
    }
    break
  }
  if (container === '') return fileCard
  const k = qnKind.get(`${filePath}::${container}`)
  if (k !== undefined && CONTAINER_KINDS.has(k)) {
    return {
      key: `${filePath}::${container}`,
      title: displayTitle(filePath, container, qnKind),
      kind: k,
    }
  }
  // container kind unknown (its own declaration didn't change): a method/field's
  // owner is a class (keep the RFC-083 "unchanged class still gets a card"
  // behavior); a function's owner is a non-class scope → fold to the file card.
  if (ownKind === 'function') return fileCard
  if (preferFileForUnknownNested && container.includes('.')) return fileCard
  return {
    key: `${filePath}::${container}`,
    title: displayTitle(filePath, container, qnKind),
    kind: 'class',
  }
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

/** Edge ids to highlight when a node is clicked, by the vertical click position
 *  `rel` (0 = top, 1 = bottom): top third → INCOMING, bottom third → OUTGOING,
 *  middle → BOTH. The thirds keep the directional intent while making a TALL card
 *  (whose body is mostly the lower half) still surface incoming edges from a
 *  click on a member row, instead of always reading as "output". */
export function edgesForNodeClick(
  edges: ReadonlyArray<{ id: string; source: string; target: string }>,
  nodeId: string,
  rel: number,
): Set<string> {
  const wantIn = rel < 0.34
  const wantOut = rel > 0.66
  const ids = new Set<string>()
  for (const e of edges) {
    const inc = e.target === nodeId
    const out = e.source === nodeId
    if (wantIn ? inc : wantOut ? out : inc || out) ids.add(e.id)
  }
  return ids
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

/** RFC-086 — card title for an anonymous type: its base type in guillemets
 *  (`«anonymous» TimerTask`), or bare `«anonymous»` when the base is unknown. */
export function anonymousCardTitle(baseName: string): string {
  return baseName.length > 0 ? `«anonymous» ${baseName}` : '«anonymous»'
}

/** RFC-083 — MiniMap fill for a node by its change type, so the overview reads
 *  as a "where are the changes" heatmap. Returns CSS vars (resolved against
 *  :root, so the SVG minimap stays theme-aware) matching the `.structure__delta`
 *  palette; unchanged / caller nodes fall back to a muted border tone. */
export function changeTypeColor(ct: ChangeType | undefined): string {
  switch (ct) {
    case 'added':
      return 'var(--success)'
    case 'removed':
      return 'var(--danger)'
    case 'modified':
      return '#d99100'
    case 'renamed':
    case 'moved':
      return 'var(--accent)'
    default:
      return 'var(--border)'
  }
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

  // RFC-086 — map every changed symbol's qualifiedName → kind (per file), so
  // memberContainer can tell a real class container from a method-local scope.
  const qnKind = new Map<string, SymbolKind>()
  for (const f of diff.files) {
    for (const ch of f.changes) {
      const sym = ch.after ?? ch.before
      if (sym !== undefined) qnKind.set(`${sym.filePath}::${sym.qualifiedName}`, sym.kind)
    }
  }

  // 1) changed symbols → cards + changed member rows.
  const changedSymbolCard = new Map<string, string>()
  for (const f of diff.files) {
    for (const ch of f.changes) {
      const sym = ch.after ?? ch.before
      if (sym === undefined) continue
      if (CONTAINER_KINDS.has(sym.kind)) {
        const title =
          sym.anonymous === true
            ? anonymousCardTitle(sym.name)
            : displayTitle(sym.filePath, sym.qualifiedName, qnKind)
        const card = ensureCard(
          `${sym.filePath}::${sym.qualifiedName}`,
          title,
          sym.filePath,
          sym.kind,
        )
        // a container's own symbol is authoritative over a member row that may
        // have created the card first — override title/kind (esp. the «anonymous»
        // label, whose qualifiedName is the meaningless `$anon<line>` synthetic).
        card.title = title
        card.kind = sym.kind
        if (sym.anonymous === true) card.anonymous = true
        card.changeType = ch.changeType
        card.isChanged = true
        changedSymbolCard.set(sym.id, card.id)
      } else if (MEMBER_KINDS.has(sym.kind)) {
        const c = memberContainer(sym.filePath, sym.qualifiedName, qnKind, sym.kind)
        const card = ensureCard(c.key, c.title, sym.filePath, c.kind)
        card.isChanged = true
        card.members.push({
          id: sym.id,
          label: sym.name,
          kind: sym.kind,
          changeType: ch.changeType,
          role: 'changed',
          signature: sym.signature,
          // RFC-087 — prefer the backend's structurally-derived visibility (Rust
          // `pub`, C++ access sections, JS/TS `#`); fall back to the signature/
          // convention heuristic for langs where it isn't computed server-side.
          visibility: sym.visibility ?? memberVisibility(sym.signature, sym.name, f.lang),
        })
        changedSymbolCard.set(sym.id, card.id)
      }
    }
  }

  // 2) edges. Prefer inherits > references > calls for a given pair.
  const edgeMap = new Map<string, GraphCardEdge>()
  const callLinks = new Map<string, Array<{ source?: string; target?: string }>>()
  // member id → row, to gate a 'references' edge's DOWNSTREAM (used) members by
  // visibility. PRIVATE members are never reachable from another class, so they
  // must never show as "used from outside". protected (subclasses) + package
  // (same package) CAN be, so keep them — only private is dropped.
  const memberById = new Map<string, GraphMember>()
  for (const card of cards.values()) for (const m of card.members) memberById.set(m.id, m)
  const externallyUsable = (id: string): boolean => memberById.get(id)?.visibility !== 'private'
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
    // a 'references' edge can touch several upstream members (every method/field
    // where the reference sits) + several downstream members (the referenced
    // class's constructor + the methods it actually uses) → one link each
    if (
      (e.fromMembers !== undefined && e.fromMembers.length > 0) ||
      (e.toMembers?.length ?? 0) > 0
    ) {
      const edgeId = `${e.from}=>${e.to}`
      const arr = callLinks.get(edgeId) ?? []
      for (const fm of e.fromMembers ?? []) arr.push({ source: fm })
      // downstream: only members an outside class could actually reach (public)
      for (const tm of e.toMembers ?? []) if (externallyUsable(tm)) arr.push({ target: tm })
      callLinks.set(edgeId, arr)
    }
  }
  // method-level calls (from impact). When 'calls' is on we materialise caller
  // cards + 'calls' edges. EITHER WAY, every call records its callee as a member
  // link on the pair's edge — so an existing 'references' edge X→D also surfaces
  // the D methods X actually calls (multiple downstream), not just the ctor.
  const callsOn = edgeKinds.has('calls')
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
        const c = memberContainer(file, qn, qnKind, kindFromId(caller.symbolId), true)
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
      const edgeId = `${callerKey}=>${targetCardId}`
      // the CALLING method's row id = its own symbol id (matches the changed-method
      // row when the caller is in the diff), so it lines up whether or not we
      // materialise a synthetic caller row.
      const callerMemberId = caller.symbolId
      if (callsOn) {
        const callerCard = ensureCard(callerKey, callerTitle, callerFile, callerKind)
        if (
          callerMemberId !== undefined &&
          callerLabel !== null &&
          !callerCard.members.some((m) => m.id === callerMemberId)
        ) {
          callerCard.members.push({
            id: callerMemberId,
            label: callerLabel,
            kind: 'method',
            role: 'caller',
          })
        }
        addEdge(callerKey, targetCardId, 'calls')
      }
      // attach the call's endpoints — to the calls edge we just made, OR to an
      // already-existing 'references' edge between the same pair. Surface BOTH the
      // calling method (upstream start point) and the callee (downstream).
      if (callsOn || edgeMap.has(edgeId)) {
        const arr = callLinks.get(edgeId) ?? []
        arr.push({ source: callerMemberId, target: item.changedSymbolId })
        callLinks.set(edgeId, arr)
      }
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
