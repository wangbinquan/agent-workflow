// RFC-083 PR-G — class-level relationship edges among CHANGED classes, for the
// graph's hierarchy. Two kinds:
//   - 'inherits'   : C's declaration extends/implements D (UML generalization)
//   - 'references' : C's body constructs / holds a field of / statically uses D
// Both are found by matching OTHER changed class NAMES inside a class's source
// (language-agnostic, heuristic — like the impact scan). Inheritance is detected
// from the declaration's heritage clause; everything else is a reference. The
// PURE core takes file text injected (no I/O); the caller reads the worktree.

import type { FileStructuralDiff, ClassEdge, SymbolKind } from '@agent-workflow/shared'

const CONTAINER_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  'class',
  'interface',
  'trait',
  'struct',
  'enum',
  'object',
])
const MEMBER_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  'method',
  'function',
  'constructor',
  'field',
  'property',
  'constant',
])

/** Changed member (method/field/…) with its id, name + line range, for
 *  attributing a reference to the member it appears in (by range) and a usage to
 *  the member invoked (by name). */
export interface MemberRange {
  id: string
  name: string
  kind: SymbolKind
  startLine: number
  endLine: number
}

function containerKey(filePath: string, qualifiedName: string): string {
  const i = qualifiedName.lastIndexOf('.')
  return i > 0 ? `${filePath}::${qualifiedName.slice(0, i)}` : ''
}

/** Changed members grouped by their enclosing class key (`${file}::${ClassQn}`),
 *  so computeClassEdges can map a reference's line → the member it sits in. */
export function collectClassMembers(
  files: ReadonlyArray<FileStructuralDiff>,
): Map<string, MemberRange[]> {
  const out = new Map<string, MemberRange[]>()
  for (const f of files) {
    for (const ch of f.changes) {
      const sym = ch.after ?? ch.before
      if (sym === undefined || !MEMBER_KINDS.has(sym.kind) || sym.range === undefined) continue
      const key = containerKey(sym.filePath, sym.qualifiedName)
      if (key === '') continue
      const arr = out.get(key) ?? []
      arr.push({
        id: sym.id,
        name: leafName(sym.name),
        kind: sym.kind,
        startLine: sym.range.startLine,
        endLine: sym.range.endLine,
      })
      out.set(key, arr)
    }
  }
  return out
}

export interface ClassNode {
  key: string // `${filePath}::${qualifiedName}` — matches the graph card id
  name: string // leaf class name (for reference matching)
  file: string
  range: { startLine: number; endLine: number }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function leafName(qualifiedName: string): string {
  const i = qualifiedName.lastIndexOf('.')
  return i >= 0 ? qualifiedName.slice(i + 1) : qualifiedName
}

/** Changed class/interface/… symbols (with ranges) → graph nodes. */
export function collectClassNodes(files: ReadonlyArray<FileStructuralDiff>): ClassNode[] {
  const out: ClassNode[] = []
  const seen = new Set<string>()
  for (const f of files) {
    for (const ch of f.changes) {
      const sym = ch.after ?? ch.before
      if (sym === undefined || !CONTAINER_KINDS.has(sym.kind) || sym.range === undefined) continue
      const key = `${sym.filePath}::${sym.qualifiedName}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ key, name: leafName(sym.qualifiedName), file: sym.filePath, range: sym.range })
    }
  }
  return out
}

/** True when `name` appears in C's heritage clause (extends/implements / Python
 *  `class X(Base)` / C++ `: public Base`). Best-effort across languages. */
function isInheritance(declText: string, name: string): boolean {
  const n = escapeRegExp(name)
  return (
    new RegExp(`\\b(?:extends|implements)\\b[^{]*\\b${n}\\b`).test(declText) || // Java/TS/Kotlin/Scala
    new RegExp(`\\bclass\\s+\\w[\\w.]*\\s*\\([^)]*\\b${n}\\b[^)]*\\)`).test(declText) || // Python
    new RegExp(`:\\s*(?:public|private|protected|virtual|\\s|,)*[^{]*\\b${n}\\b[^{]*\\{`).test(
      declText,
    ) // C++
  )
}

/** Inherit/reference edges among the class nodes. `fileText` maps filePath → its
 *  NEW content; `membersByClass` (from collectClassMembers) lets a 'references'
 *  edge record the exact member it appears in (`fromMember`). PURE. Inheritance
 *  wins over a plain reference for the same pair. */
export function computeClassEdges(
  nodes: readonly ClassNode[],
  fileText: ReadonlyMap<string, string>,
  membersByClass: ReadonlyMap<string, ReadonlyArray<MemberRange>> = new Map(),
): ClassEdge[] {
  if (nodes.length < 2) return []
  const edges: ClassEdge[] = []
  const seen = new Set<string>()
  const add = (
    from: string,
    to: string,
    kind: ClassEdge['kind'],
    fromMembers?: string[],
    toMembers?: string[],
  ): void => {
    if (from === to) return
    const refKey = `${from}|${to}|references`
    const inhKey = `${from}|${to}|inherits`
    if (kind === 'inherits') {
      // upgrade an existing reference edge to inheritance
      if (seen.has(refKey)) {
        const i = edges.findIndex((e) => e.from === from && e.to === to && e.kind === 'references')
        if (i >= 0) edges.splice(i, 1)
        seen.delete(refKey)
      }
    } else if (seen.has(inhKey)) {
      return // already a stronger inheritance edge
    }
    const k = `${from}|${to}|${kind}`
    if (seen.has(k)) return
    seen.add(k)
    const edge: ClassEdge = { from, to, kind }
    if (fromMembers !== undefined && fromMembers.length > 0) edge.fromMembers = fromMembers
    if (toMembers !== undefined && toMembers.length > 0) edge.toMembers = toMembers
    edges.push(edge)
  }

  for (const c of nodes) {
    const text = fileText.get(c.file)
    if (text === undefined) continue
    const body = text.split('\n').slice(c.range.startLine - 1, c.range.endLine)
    const bodyText = body.join('\n')
    const declText = body.slice(0, 3).join(' ') // heritage clauses live near the top
    const members = membersByClass.get(c.key)
    for (const d of nodes) {
      if (d.key === c.key || d.name === c.name) continue // skip self + same-name (ambiguous)
      const re = new RegExp(`\\b${escapeRegExp(d.name)}\\b`)
      if (!re.test(bodyText)) continue
      const kind = isInheritance(declText, d.name) ? 'inherits' : 'references'
      // upstream: EVERY changed member of C where D appears.
      // downstream: D's constructor + D's members C invokes by name (`.foo`).
      let fromMembers: string[] | undefined
      let toMembers: string[] | undefined
      if (kind === 'references') {
        if (members !== undefined) {
          const ids = new Set<string>()
          for (const ln of matchLines(body, re, c.range.startLine)) {
            const m = members.find((mm) => ln >= mm.startLine && ln <= mm.endLine)
            if (m !== undefined) ids.add(m.id)
          }
          if (ids.size > 0) fromMembers = [...ids]
        }
        toMembers = usedMembers(membersByClass.get(d.key), bodyText)
      }
      add(c.key, d.key, kind, fromMembers, toMembers)
    }
  }
  return edges
}

/** Absolute (1-based) lines of EVERY body line matching `re`. */
function matchLines(body: string[], re: RegExp, startLine: number): number[] {
  const out: number[] = []
  for (let i = 0; i < body.length; i += 1) {
    if (re.test(body[i] ?? '')) out.push(startLine + i)
  }
  return out
}

/** The referenced class's members that the referencing body USES: its
 *  constructor (entry) + any member invoked by name as `.foo(`/`.foo` in the
 *  body. Heuristic (a name can coincide), mirroring the class-name reference
 *  scan. Returns undefined when nothing is found. */
function usedMembers(
  dMembers: ReadonlyArray<MemberRange> | undefined,
  bodyText: string,
): string[] | undefined {
  if (dMembers === undefined || dMembers.length === 0) return undefined
  const used = new Set<string>()
  const byName = new Map<string, string[]>()
  for (const m of dMembers) {
    if (m.kind === 'constructor') used.add(m.id) // entry point, always relevant
    const arr = byName.get(m.name) ?? []
    arr.push(m.id)
    byName.set(m.name, arr)
  }
  const names = [...byName.keys()].filter((n) => n.length > 0)
  if (names.length > 0) {
    const re = new RegExp(`\\.(${names.map(escapeRegExp).join('|')})\\b`, 'g')
    for (const match of bodyText.matchAll(re)) {
      for (const id of byName.get(match[1] ?? '') ?? []) used.add(id)
    }
  }
  return used.size > 0 ? [...used] : undefined
}
