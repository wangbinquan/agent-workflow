// RFC-083 PR-A — extract a symbol-node set from one source file.
//
// Pipeline: parse → run the language's extraction query → for each match derive
// (kind, name, qualifiedName, parentId, signature, bodyHash, range). Nesting is
// taken from the syntax tree (a function inside a class body → method, qualified
// `Class.method`), NOT from the flat query, so qualified names are accurate.
//
// bodyHash semantics drive graphDiff:
//   - container (class/interface/struct/enum/trait/object): signature is omitted
//     so identity = kind+qualifiedName stays STABLE across member edits (adding a
//     method must not read as delete+recreate of the class). bodyHash = the
//     declaration header (name + heritage) so a container shows "modified" only
//     when its own declaration changes.
//   - leaf (function/method/field/import): signature = the declaration header
//     (params/return) for overload identity; bodyHash = the full node text so a
//     body-only edit reads as "modified".

import { createHash } from 'node:crypto'
import type Parser from 'web-tree-sitter'
import type { LangId, SymbolKind, SymbolNode } from '@agent-workflow/shared'
import { parseSource } from './parser'
import { getLangExtraction, DEGRADED_LANGS, type ExtractionConfig } from './queries'

type TsNode = Parser.SyntaxNode

const CLASS_LIKE: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  'class',
  'interface',
  'trait',
  'struct',
  'enum',
  'object',
  'namespace',
  'module',
])

function hash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16)
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function stripQuotes(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, '').trim()
}

/** RFC-086 — anonymous type nodes that have no name of their own: a Java
 *  anonymous class (`new T(){…}` = object_creation_expression carrying a
 *  class_body) and a JS/TS anonymous `class` expression. (A named class
 *  expression has a `name` field; a class *declaration* is a different node.) */
function isAnonymousTypeNode(node: TsNode): boolean {
  if (node.type === 'object_creation_expression') return true
  if (node.type === 'class') return node.childForFieldName('name') === null
  return false
}

/** Base/super type LEAF of an anonymous type: `java.util.TimerTask<X>` →
 *  `TimerTask`. Java: the `@name` capture is the created type. JS/TS anon class
 *  expression: the `extends` clause value. '' when there is none (UI then shows
 *  `«anonymous»`). */
function anonBaseLeaf(node: TsNode, nameNode: TsNode | null): string {
  let text = nameNode !== null ? nameNode.text : ''
  if (nameNode === null) {
    const heritage = node.children.find((c) => c.type === 'class_heritage')
    const ext = heritage?.children.find((c) => c.type === 'extends_clause')
    text = ext?.childForFieldName('value')?.text ?? ''
  }
  text = text.trim()
  const lt = text.indexOf('<')
  if (lt >= 0) text = text.slice(0, lt) // strip generics
  const dot = text.lastIndexOf('.')
  if (dot >= 0) text = text.slice(dot + 1) // strip package/qualifier
  return text.trim()
}

// RFC-087 — structural member visibility for langs whose signature text carries
// no usable access info (Rust `pub`, C++ `public:`/`private:` sections) or whose
// access is a name prefix (JS/TS `#private`). Returns undefined for langs handled
// by the frontend's signature/convention heuristic (Java keyword + package
// default / TS accessibility_modifier / Python `_`·`__` / Go caps / Scala kw).
type Visibility = 'public' | 'protected' | 'package' | 'private'

function computeVisibility(node: TsNode, lang: LangId, name: string): Visibility | undefined {
  if (name.startsWith('#')) return 'private' // JS/TS hard-private (#field / #method)
  if (lang === 'rust') return rustVisibility(node)
  if (lang === 'cpp') return cppVisibility(node)
  return undefined
}

/** Rust: a `visibility_modifier` child = `pub`; `pub(crate|super|self|in …)` carries
 *  a named child → module-scoped (not public API), mapped to 'package'. No modifier
 *  → private. A trait method signature is public by the trait contract. */
function rustVisibility(node: TsNode): Visibility {
  if (node.type === 'function_signature_item') return 'public'
  const vis = node.children.find((c) => c.type === 'visibility_modifier')
  if (vis === undefined) return 'private'
  return vis.namedChildren.length > 0 ? 'package' : 'public'
}

/** C++: per-member access comes from the `access_specifier` section label that
 *  precedes it inside the `field_declaration_list` (default: class→private,
 *  struct→public). Out-of-line defs (parent not a field_declaration_list) →
 *  undefined (frontend defaults public). */
function cppVisibility(node: TsNode): Visibility | undefined {
  const list = node.parent
  if (list === null || list.type !== 'field_declaration_list') return undefined
  let cur: Visibility = list.parent?.type === 'struct_specifier' ? 'public' : 'private'
  for (const sib of list.namedChildren) {
    if (sib.id === node.id) break
    if (sib.type === 'access_specifier') {
      const t = sib.text.trim()
      if (t === 'public' || t === 'protected' || t === 'private') cur = t
    }
  }
  return cur
}

// RFC-087 — structural heritage (parent/super-trait/embedded type leaf names) for
// the two langs whose inheritance isn't in the declaration header the classGraph
// regex scans: Go (struct/interface embedding) and Rust (`impl Trait for S` +
// supertrait bounds). The other 6 langs keep the regex heuristic (it covers them).
function goHeritage(node: TsNode): string[] {
  const out: string[] = []
  const push = (t: TsNode | null): void => {
    const leaf = t === null ? null : t.type === 'qualified_type' ? t.childForFieldName('name') : t
    const txt = (leaf?.text ?? '').trim()
    if (txt !== '') out.push(txt)
  }
  for (const st of node.descendantsOfType('struct_type')) {
    for (const fd of st.descendantsOfType('field_declaration')) {
      if (fd.childForFieldName('name') === null) push(fd.childForFieldName('type')) // embedded
    }
  }
  for (const it of node.descendantsOfType('interface_type')) {
    for (const ce of it.descendantsOfType('constraint_elem')) {
      push(
        ce.namedChildren.find((c) => c.type === 'type_identifier' || c.type === 'qualified_type') ??
          null,
      )
    }
  }
  return out
}

/** Rust impl/trait edges are top-level items separate from the type's own decl, so
 *  build a file-wide `typeLeaf → [parent leaves]` map once from the root. */
function rustHeritageMap(root: TsNode): Map<string, string[]> {
  const map = new Map<string, string[]>()
  const leaf = (n: TsNode | null): string => {
    if (n === null) return ''
    const t = n.type === 'generic_type' ? (n.childForFieldName('type') ?? n) : n
    return t.text.trim()
  }
  const add = (k: string, v: string): void => {
    if (k === '' || v === '') return
    const arr = map.get(k) ?? []
    arr.push(v)
    map.set(k, arr)
  }
  for (const impl of root.descendantsOfType('impl_item')) {
    const tr = impl.childForFieldName('trait')
    if (tr === null) continue // inherent impl `impl S {}` is not inheritance
    add(leaf(impl.childForFieldName('type')), leaf(tr))
  }
  for (const tr of root.descendantsOfType('trait_item')) {
    const bounds = tr.childForFieldName('bounds')
    if (bounds === null) continue
    const name = tr.childForFieldName('name')?.text?.trim() ?? ''
    for (const ti of bounds.descendantsOfType('type_identifier')) add(name, ti.text.trim())
  }
  return map
}

const MEMBERISH: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  'method',
  'function',
  'constructor',
  'field',
  'property',
  'constant',
])

interface RawDef {
  node: TsNode
  nameNode: TsNode | null
  rawKind: SymbolKind
}

/**
 * Extract symbol nodes from `source` for `lang`. Returns [] when the language
 * has no extraction config. Throws on a fatal parse failure (caller maps to
 * `parse-error`).
 */
export async function extractSymbols(opts: {
  lang: LangId
  grammarFile: string
  filePath: string
  source: string
}): Promise<{ symbols: SymbolNode[]; hadError: boolean }> {
  const cfg = getLangExtraction(opts.lang)
  if (cfg === undefined) return { symbols: [], hadError: false }
  const { tree, language } = await parseSource(opts.grammarFile, opts.source)
  const query = language.query(cfg.query)
  try {
    // tree-sitter recovers from syntax errors instead of throwing, so a grammar
    // that can't parse a construct (e.g. a newer syntax the pinned grammar
    // predates) silently yields a partial tree. Surface that as `hadError` so
    // the file is marked degraded rather than a misleading "ok".
    const hadError = tree.rootNode.hasError
    return {
      symbols: buildSymbols(query.matches(tree.rootNode), opts, cfg, tree.rootNode),
      hadError,
    }
  } finally {
    query.delete()
    tree.delete()
  }
}

function buildSymbols(
  matches: Parser.QueryMatch[],
  opts: { lang: LangId; filePath: string; source: string },
  cfg: ExtractionConfig,
  rootNode: TsNode,
): SymbolNode[] {
  // ---- Pass 1: collect raw defs, indexed by tree-node id for nesting lookup.
  const raws: RawDef[] = []
  const byNodeId = new Map<number, RawDef>()
  for (const m of matches) {
    let defCap: Parser.QueryCapture | undefined
    let nameCap: Parser.QueryCapture | undefined
    for (const c of m.captures) {
      if (c.name === 'name') nameCap = c
      else if (c.name.startsWith('def.')) defCap = c
    }
    if (defCap === undefined) continue
    const rawKind = defCap.name.slice('def.'.length) as SymbolKind
    const raw: RawDef = { node: defCap.node, nameNode: nameCap?.node ?? null, rawKind }
    // A single tree node can be captured once per def pattern; first wins.
    if (byNodeId.has(defCap.node.id)) continue
    byNodeId.set(defCap.node.id, raw)
    raws.push(raw)
  }

  const nearestDefAncestor = (n: TsNode): RawDef | null => {
    let p = n.parent
    while (p !== null) {
      const r = byNodeId.get(p.id)
      if (r !== undefined) return r
      p = p.parent
    }
    return null
  }

  const leafName = (r: RawDef): string => {
    if (r.rawKind === 'import') {
      const raw = r.nameNode !== null ? r.nameNode.text : r.node.text
      const cleaned = stripQuotes(norm(raw))
      return cleaned !== '' ? cleaned : norm(r.node.text)
    }
    return r.nameNode !== null ? r.nameNode.text : ''
  }

  // ---- Pass 2: qualifiedName + final kind (memoized over the parent chain).
  const qnameCache = new Map<RawDef, string>()
  const qualifiedName = (r: RawDef): string => {
    const cached = qnameCache.get(r)
    if (cached !== undefined) return cached
    const parent = nearestDefAncestor(r.node)
    let prefix = ''
    if (parent !== null && parent.rawKind !== 'import') {
      prefix = `${qualifiedName(parent)}.`
    } else if (cfg.receiverPrefix !== undefined) {
      const recv = cfg.receiverPrefix(r.node)
      if (recv !== null && recv !== '') prefix = `${recv}.`
    }
    // Anonymous types have no name of their own → a stable synthetic leaf keyed by
    // start line+column (`$anon<line>_<col>`), so the qualifiedName (and thus the
    // card key + symbol id) stays unique even with SEVERAL anonymous classes on the
    // same line (e.g. `f(new A(){…}, new B(){…})`). The DISPLAY name (base type) is
    // computed separately in pass 3.
    const leaf = isAnonymousTypeNode(r.node)
      ? `$anon${r.node.startPosition.row + 1}_${r.node.startPosition.column}`
      : leafName(r)
    const qn = prefix + leaf
    qnameCache.set(r, qn)
    return qn
  }

  const finalKind = (r: RawDef): SymbolKind => {
    const parent = nearestDefAncestor(r.node)
    const inClass = parent !== null && CLASS_LIKE.has(parent.rawKind)
    // RFC-087 — constructor reclassification (Java already emits @def.constructor).
    // No dedicated constructor node in TS/JS/Python/Scala — detect by name; the
    // member must sit in a class-like scope so a free fn named `constructor` isn't
    // misclassified.
    if (inClass) {
      const nm = r.nameNode?.text ?? ''
      if ((opts.lang === 'typescript' || opts.lang === 'javascript') && nm === 'constructor')
        return 'constructor'
      if (opts.lang === 'python' && nm === '__init__') return 'constructor'
      if (opts.lang === 'scala' && nm === 'this') return 'constructor'
    }
    if (r.rawKind === 'function') {
      if (inClass) return 'method'
      // Rust impl methods: captured as functions, qualified by a receiver type.
      if (cfg.receiverPrefix !== undefined) {
        const recv = cfg.receiverPrefix(r.node)
        if (recv !== null && recv !== '') return 'method'
      }
    }
    return r.rawKind
  }

  // ---- Pass 3: ids first (parentId needs sibling ids), then nodes.
  interface Built {
    raw: RawDef
    kind: SymbolKind
    name: string
    qn: string
    id: string
  }
  const built: Built[] = []
  const idByRaw = new Map<RawDef, string>()
  // class-like name → id, for receiver-based parent linking (Go methods).
  const classLikeIdByName = new Map<string, string>()
  for (const r of raws) {
    const isAnon = isAnonymousTypeNode(r.node)
    const name = isAnon ? anonBaseLeaf(r.node, r.nameNode) : leafName(r)
    // keep anonymous nodes even with an unresolved base type (name === '');
    // every other def with no name is noise and skipped.
    if (name === '' && !isAnon) continue
    const kind = finalKind(r)
    const qn = qualifiedName(r)
    const id = `${opts.filePath}#${qn}:${kind}:${r.node.startPosition.row + 1}`
    idByRaw.set(r, id)
    if (CLASS_LIKE.has(kind)) classLikeIdByName.set(qn, id)
    built.push({ raw: r, kind, name, qn, id })
  }

  const degraded = DEGRADED_LANGS.has(opts.lang)
  // RFC-087 — Rust heritage needs a file-wide impl/trait scan; build it lazily once.
  let rustMap: Map<string, string[]> | null = null
  const getRustMap = (): Map<string, string[]> => (rustMap ??= rustHeritageMap(rootNode))
  const out: SymbolNode[] = []
  for (const b of built) {
    const node = b.raw.node
    const bodyChild = node.childForFieldName('body')
    const isContainer = CLASS_LIKE.has(b.kind)
    let signature: string | undefined
    let bodyHashInput: string
    if (isContainer) {
      // identity stable across member edits (signature omitted)
      const header =
        bodyChild !== null
          ? opts.source.slice(node.startIndex, bodyChild.startIndex)
          : `${b.kind} ${b.qn}`
      bodyHashInput = norm(header)
    } else if (bodyChild !== null) {
      signature = norm(opts.source.slice(node.startIndex, bodyChild.startIndex))
      bodyHashInput = norm(node.text)
    } else {
      signature = norm(node.text)
      bodyHashInput = norm(node.text)
    }

    const structuralParent = nearestDefAncestor(node)
    let parentId = structuralParent !== null ? idByRaw.get(structuralParent) : undefined
    if (parentId === undefined && cfg.receiverPrefix !== undefined) {
      const recv = cfg.receiverPrefix(node)
      if (recv !== null && recv !== '') parentId = classLikeIdByName.get(recv)
    }

    // RFC-087 — structural visibility (members) + heritage (Go/Rust containers).
    const visibility = MEMBERISH.has(b.kind)
      ? computeVisibility(node, opts.lang, b.name)
      : undefined
    let heritage: string[] | undefined
    if (isContainer) {
      const h =
        opts.lang === 'go'
          ? goHeritage(node)
          : opts.lang === 'rust'
            ? (getRustMap().get(b.name) ?? [])
            : []
      if (h.length > 0) heritage = h
    }

    out.push({
      id: b.id,
      kind: b.kind,
      name: b.name,
      qualifiedName: b.qn,
      signature,
      bodyHash: hash(bodyHashInput),
      lang: opts.lang,
      filePath: opts.filePath,
      range: { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
      parentId,
      confidence: degraded ? 'inferred' : 'extracted',
      degraded: degraded ? true : undefined,
      anonymous: isAnonymousTypeNode(node) ? true : undefined,
      visibility,
      heritage,
    })
  }
  return out
}
