// RFC-083 PR-G — class-level relationship edges among CHANGED classes, for the
// graph's hierarchy. Two kinds:
//   - 'inherits'   : C's declaration extends/implements D (UML generalization)
//   - 'references' : C's body constructs / holds a field of / statically uses D
// Both are found by matching OTHER changed class NAMES inside a class's source
// (language-agnostic, heuristic — like the impact scan). Inheritance is detected
// from the declaration's heritage clause; everything else is a reference. The
// PURE core takes file text injected (no I/O); the caller reads the worktree.

import type { FileStructuralDiff, ClassEdge, SymbolKind, SymbolNode } from '@agent-workflow/shared'

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
  /** RFC-087 — structural parent/super-trait/embedded leaf names (Go/Rust), where
   *  the heritage isn't in the declaration header `isInheritance` scans. */
  heritage?: readonly string[]
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Blank out line comments, block comments and string/char/template literals
 *  (replacing their content with spaces, KEEPING newlines so line numbers/ranges
 *  stay valid), so a class/method name mentioned only in a comment or string isn't
 *  mistaken for a real reference (e.g. a `Food colors` comment must not link
 *  ThemeConfig to Food). Handles C-family / Java / TS / Go; `#` is left alone
 *  (it is a JS private field, not a comment in these grammars). */
function stripCommentsAndStrings(src: string): string {
  const out: string[] = []
  let state: 'code' | 'line' | 'block' | 'str' = 'code'
  let quote = ''
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i] ?? ''
    const c2 = src[i + 1] ?? ''
    const blank = c === '\n' || c === '\t' ? c : ' '
    if (state === 'code') {
      if (c === '/' && c2 === '/') {
        out.push('  ')
        i += 1
        state = 'line'
      } else if (c === '/' && c2 === '*') {
        out.push('  ')
        i += 1
        state = 'block'
      } else if (c === '"' || c === "'" || c === '`') {
        out.push(' ')
        quote = c
        state = 'str'
      } else out.push(c)
    } else if (state === 'line') {
      if (c === '\n') state = 'code'
      out.push(c === '\n' ? '\n' : blank)
    } else if (state === 'block') {
      if (c === '*' && c2 === '/') {
        out.push('  ')
        i += 1
        state = 'code'
      } else out.push(blank)
    } else {
      // string literal
      if (c === '\\') {
        out.push('  ')
        i += 1
      } else if (c === quote || c === '\n') {
        out.push(c === '\n' ? '\n' : ' ')
        state = 'code'
      } else out.push(blank)
    }
  }
  return out.join('')
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
      out.push({
        key,
        name: leafName(sym.qualifiedName),
        file: sym.filePath,
        range: sym.range,
        heritage: sym.heritage,
      })
    }
  }
  return out
}

/** RFC-086 — explicit "enclosing member CREATES this anonymous type" edges. An
 *  anonymous class (Java `new TimerTask(){…}`, JS/TS anon `class` expr) has a
 *  synthetic qualifiedName that never appears as text elsewhere, so the name-match
 *  heuristic in computeClassEdges can't (and shouldn't — it would over-match the
 *  base type) find it. Instead we read the structural parentId chain: walk up from
 *  the anon node to the nearest real container (its owning class) and record the
 *  first member on the way (the method/field that instantiated it) as the edge's
 *  fromMember. PURE. */
export function computeAnonCreationEdges(files: ReadonlyArray<FileStructuralDiff>): ClassEdge[] {
  const byId = new Map<string, SymbolNode>()
  for (const f of files) {
    for (const ch of f.changes) {
      const s = ch.after ?? ch.before
      if (s !== undefined) byId.set(s.id, s)
    }
  }
  const edges: ClassEdge[] = []
  const seen = new Set<string>()
  for (const s of byId.values()) {
    if (s.anonymous !== true) continue
    const to = `${s.filePath}::${s.qualifiedName}`
    // walk parentId up to the nearest container; first member on the way = creator
    let creator: string | undefined
    let cur = s.parentId !== undefined ? byId.get(s.parentId) : undefined
    while (cur !== undefined && !CONTAINER_KINDS.has(cur.kind)) {
      if (creator === undefined && MEMBER_KINDS.has(cur.kind)) creator = cur.id
      cur = cur.parentId !== undefined ? byId.get(cur.parentId) : undefined
    }
    if (cur === undefined) continue // no enclosing changed class to anchor 'from'
    const from = `${cur.filePath}::${cur.qualifiedName}`
    if (from === to) continue
    const key = `${from}|${to}`
    if (seen.has(key)) continue
    seen.add(key)
    const edge: ClassEdge = { from, to, kind: 'references' }
    if (creator !== undefined) edge.fromMembers = [creator]
    edges.push(edge)
  }
  return edges
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

  // strip comments/strings once per file so a name in a comment/string is ignored
  const strippedCache = new Map<string, string>()
  const strippedText = (file: string): string | undefined => {
    const cached = strippedCache.get(file)
    if (cached !== undefined) return cached
    const t = fileText.get(file)
    if (t === undefined) return undefined
    const s = stripCommentsAndStrings(t)
    strippedCache.set(file, s)
    return s
  }
  for (const c of nodes) {
    const text = strippedText(c.file)
    if (text === undefined) continue
    const body = text.split('\n').slice(c.range.startLine - 1, c.range.endLine)
    const bodyText = body.join('\n')
    const declText = body.slice(0, 3).join(' ') // heritage clauses live near the top
    const members = membersByClass.get(c.key)
    for (const d of nodes) {
      if (d.key === c.key || d.name === c.name) continue // skip self + same-name (ambiguous)
      // RFC-087 — structural heritage (Go/Rust) wins; else the regex heritage scan
      // (Java/TS/Python/C++/Scala). An inherits pair need not also appear in the
      // body text, so check heritage before the name-in-body gate below.
      const inherits = c.heritage?.includes(d.name) === true || isInheritance(declText, d.name)
      const re = new RegExp(`\\b${escapeRegExp(d.name)}\\b`)
      if (!inherits && !re.test(bodyText)) continue
      const kind = inherits ? 'inherits' : 'references'
      // upstream: EVERY changed member of C where D appears.
      // downstream: D's constructor + D's members C invokes by name (`.foo`).
      let fromMembers: string[] | undefined
      let toMembers: string[] | undefined
      if (kind === 'references') {
        const ids = new Set<string>()
        if (members !== undefined) {
          // C members where D's NAME appears (holds a field/param of type D)
          for (const ln of matchLines(body, re, c.range.startLine)) {
            const m = members.find((mm) => ln >= mm.startLine && ln <= mm.endLine)
            if (m !== undefined) ids.add(m.id)
          }
        }
        const uc = usedMembersAndCallers(
          membersByClass.get(d.key),
          members,
          body,
          c.range.startLine,
        )
        // upstream = type-reference sites + the methods that CALL into D
        for (const id of uc.callers) ids.add(id)
        if (ids.size > 0) fromMembers = [...ids]
        if (uc.used.length > 0) toMembers = uc.used
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

/** What the referencing class C USES of referenced class D, AND the C member
 *  doing the using:
 *   - `used`    : D's constructor (entry) + D members invoked by name (`.foo`).
 *   - `callers` : C members whose body contains such a call (the call's UPSTREAM
 *                 start point). Heuristic (a name can coincide), mirroring the
 *                 class-name reference scan. */
function usedMembersAndCallers(
  dMembers: ReadonlyArray<MemberRange> | undefined,
  cMembers: ReadonlyArray<MemberRange> | undefined,
  body: string[],
  cStartLine: number,
): { used: string[]; callers: string[] } {
  if (dMembers === undefined || dMembers.length === 0) return { used: [], callers: [] }
  const used = new Set<string>()
  const callers = new Set<string>()
  const byName = new Map<string, string[]>()
  for (const m of dMembers) {
    if (m.kind === 'constructor') used.add(m.id) // entry point, always relevant
    const arr = byName.get(m.name) ?? []
    arr.push(m.id)
    byName.set(m.name, arr)
  }
  const names = [...byName.keys()].filter((n) => n.length > 0)
  if (names.length > 0) {
    // RFC-087 — match every member-access operator: `.` (java/ts/js/python/go/rust),
    // C++ `->` (pointer), and `::` (Rust assoc / C++ scope) — not just the dot.
    const re = new RegExp(`(?:\\.|->|::)(${names.map(escapeRegExp).join('|')})\\b`, 'g')
    for (let i = 0; i < body.length; i += 1) {
      const line = body[i] ?? ''
      re.lastIndex = 0
      let hit = false
      let match: RegExpExecArray | null
      while ((match = re.exec(line)) !== null) {
        for (const id of byName.get(match[1] ?? '') ?? []) used.add(id)
        hit = true
      }
      if (hit) {
        const ln = cStartLine + i
        const caller = cMembers?.find((mm) => ln >= mm.startLine && ln <= mm.endLine)?.id
        if (caller !== undefined) callers.add(caller)
      }
    }
  }
  return { used: [...used], callers: [...callers] }
}
