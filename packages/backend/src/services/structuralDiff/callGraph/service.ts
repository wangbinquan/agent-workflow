// RFC-085 T2 — lazy "expand one method" service.
//
// Given a method ref (`${file}#${qualifiedName}`), parse its file, extract the
// calls it makes (extractCalls), and resolve each to a CallTarget:
//   - resolved   : located the exact callee method/constructor (has `ref`)
//   - external   : located the owner class but not the method
//   - unresolved : couldn't determine the receiver type (dynamic / chained / etc)
// Cross-file resolution uses a prebuilt class→file index + lazy parse of target
// files (cached within one expand). PURE except for the injected readers, so it
// unit-tests with in-memory files. Best-effort by design (RFC §5).

import type Parser from 'web-tree-sitter'
import type { LangId, SymbolKind, CallTarget } from '@agent-workflow/shared'
import { parseSource } from '../lang/parser'
import { getLangExtraction } from '../lang/queries'
import { extractCalls, hasCallQuery } from './extractCalls'
import { inferLocalTypes } from './classIndex'

type TsNode = Parser.SyntaxNode

const CLASS_LIKE: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  'class',
  'interface',
  'trait',
  'struct',
  'enum',
  'object',
])
const CALLABLE: ReadonlySet<string> = new Set(['method', 'function', 'constructor'])

export interface GrammarRef {
  lang: LangId
  grammarFile: string
}
export interface ExpandCtx {
  readFile: (path: string) => Promise<string | null>
  /** class/interface/... name → file path(s); prebuilt + cached by the caller. */
  classIndex: ReadonlyMap<string, readonly string[]>
  grammarFor: (path: string) => GrammarRef | null
  /** max bytes to parse a file (reuse RFC-083 cap). */
  maxBytes?: number
}

function splitRef(ref: string): { file: string; qn: string } {
  const i = ref.indexOf('#')
  // RFC-W001: normalize the file segment to forward slashes so a Windows-native
  // ref (`src\OrderService.java#A.run`) matches the posix index keys produced
  // by `listSourceFiles` and the `ownerFile === callerFile` comparison below.
  const file = i < 0 ? ref : ref.slice(0, i)
  const posix = file.includes('\\') ? file.replace(/\\/g, '/') : file
  return i < 0 ? { file: posix, qn: ref } : { file: posix, qn: ref.slice(i + 1) }
}
function leaf(qn: string): string {
  const i = qn.lastIndexOf('.')
  return i >= 0 ? qn.slice(i + 1) : qn
}
function container(qn: string): string {
  const i = qn.lastIndexOf('.')
  return i > 0 ? qn.slice(0, i) : ''
}

interface DefInfo {
  node: TsNode
  kind: SymbolKind
  name: string
  /** Owning class name: nearest class-like ancestor, OR (Go/Rust, where a method
   *  lives outside its type's body) the receiver-prefix type. '' for top-level. */
  owner: string
}

/** Run the extraction query and index every def node by tree-node id, with its
 *  kind + name + owning class — so we can find a method + list a class's methods.
 *  Owner attribution honours `receiverPrefix` so Go (`func (g Game) m`) and Rust
 *  (`impl S { fn m }`) methods are attributed to their type even though the def
 *  node has no class-like ANCESTOR. */
function indexDefs(root: TsNode, language: Parser.Language, lang: LangId): Map<number, DefInfo> {
  const cfg = getLangExtraction(lang)
  const byId = new Map<number, DefInfo>()
  if (cfg === undefined) return byId
  const query = language.query(cfg.query)
  try {
    for (const m of query.matches(root)) {
      let node: TsNode | undefined
      let kind: SymbolKind | undefined
      let name = ''
      for (const c of m.captures) {
        if (c.name.startsWith('def.')) {
          node = c.node
          kind = c.name.slice('def.'.length) as SymbolKind
        } else if (c.name === 'name') name = c.node.text
      }
      if (node !== undefined && kind !== undefined && !byId.has(node.id)) {
        byId.set(node.id, { node, kind, name, owner: '' })
      }
    }
    // 2nd pass (needs all defs indexed): compute each def's owning class.
    for (const d of byId.values()) {
      let owner = ''
      let p = d.node.parent
      while (p !== null) {
        const pd = byId.get(p.id)
        if (pd !== undefined && CLASS_LIKE.has(pd.kind)) {
          owner = pd.name
          break
        }
        p = p.parent
      }
      if (owner === '' && cfg.receiverPrefix !== undefined && CALLABLE.has(d.kind)) {
        owner = cfg.receiverPrefix(d.node) ?? ''
      }
      d.owner = owner
    }
  } finally {
    query.delete()
  }
  return byId
}

/** Owning class name for a def node (precomputed in indexDefs), or ''. */
function ownerName(node: TsNode, defs: Map<number, DefInfo>): string {
  return defs.get(node.id)?.owner ?? ''
}

/** The receiver variable name of a Go/Rust method (`func (g Game) m` → `g`;
 *  Rust `&self` → `self`), so a `g.x()` call is recognised as a same-type call. */
function receiverVar(node: TsNode, lang: LangId): string | undefined {
  if (lang === 'go') {
    const recv = node.childForFieldName('receiver')
    return recv?.descendantsOfType('identifier')[0]?.text
  }
  return undefined
}

/** Find a callable def node whose leaf name + enclosing class match `qn`. */
function findCallable(defs: Map<number, DefInfo>, qn: string): DefInfo | undefined {
  const wantName = leaf(qn)
  const wantOwner = leaf(container(qn))
  let fallback: DefInfo | undefined
  for (const d of defs.values()) {
    if (!CALLABLE.has(d.kind) || d.name !== wantName) continue
    const owner = ownerName(d.node, defs)
    if (owner === wantOwner) return d
    if (wantOwner === '' && owner === '') return d
    fallback ??= d // name matches but owner uncertain
  }
  return fallback
}

/** Method/constructor names declared on the class named `className` in this file. */
function methodsOfClass(defs: Map<number, DefInfo>, className: string): Map<string, DefInfo> {
  const out = new Map<string, DefInfo>()
  for (const d of defs.values()) {
    if (!CALLABLE.has(d.kind)) continue
    if (ownerName(d.node, defs) === className) out.set(d.name, d)
  }
  return out
}

interface ParsedFile {
  source: string
  language: Parser.Language
  lang: LangId
  defs: Map<number, DefInfo>
  tree: Parser.Tree
}

/** Expand one method into its direct callees, source-ordered. */
export async function expandMethod(methodRef: string, ctx: ExpandCtx): Promise<CallTarget[]> {
  const max = ctx.maxBytes ?? 2_000_000
  const cache = new Map<string, ParsedFile | null>()
  const parse = async (path: string): Promise<ParsedFile | null> => {
    const hit = cache.get(path)
    if (hit !== undefined) return hit
    const g = ctx.grammarFor(path)
    const source = g === null ? null : await ctx.readFile(path)
    if (g === null || source === null || source.length > max || !hasCallQuery(g.lang)) {
      cache.set(path, null)
      return null
    }
    const { tree, language } = await parseSource(g.grammarFile, source)
    const defs = indexDefs(tree.rootNode, language, g.lang)
    const pf: ParsedFile = { source, language, lang: g.lang, defs, tree }
    cache.set(path, pf)
    return pf
  }

  try {
    const { file, qn } = splitRef(methodRef)
    const pf = await parse(file)
    if (pf === null) return []
    const method = findCallable(pf.defs, qn)
    if (method === undefined) return []
    const body = method.node.childForFieldName('body') ?? method.node
    const callerClass = container(qn) // qn of the caller's class (may be nested)
    const callerClassLeaf = leaf(callerClass)
    const selfVar = receiverVar(method.node, pf.lang) // Go/Rust receiver → same-type call

    const calls = extractCalls(body, pf.language, pf.lang)
    if (calls.length === 0) return []

    // receiver var → Type (leaf) inferred from the caller method + its class.
    const classNode = (() => {
      let p: TsNode | null = method.node.parent
      while (p !== null) {
        const d = pf.defs.get(p.id)
        if (d !== undefined && CLASS_LIKE.has(d.kind)) return p
        p = p.parent
      }
      return null
    })()
    const localTypes = inferLocalTypes(classNode?.text ?? method.node.text)

    // locate a type name → its file (index) + the file's defs (lazy parse).
    const locate = async (
      typeName: string,
    ): Promise<{ ref: string; methods: Map<string, DefInfo> } | null> => {
      const files = ctx.classIndex.get(typeName)
      const cand = files?.[0]
      if (cand === undefined) return null
      const tf = await parse(cand)
      if (tf === null) return null
      return { ref: cand, methods: methodsOfClass(tf.defs, typeName) }
    }

    const out: CallTarget[] = []
    for (const call of calls) {
      const literal = call.recv !== null ? `${call.recv}.${call.name}` : call.name
      // ---- determine the owner type of the call ----
      let ownerType: string | null = null
      let ownerFile: string | null = null
      let ownerMethods: Map<string, DefInfo> | null = null
      const label = `${literal}()`

      if (call.kind === 'constructor') {
        const loc = await locate(call.name)
        if (loc !== null) {
          ownerType = call.name
          ownerFile = loc.ref
          ownerMethods = loc.methods
        }
      } else if (
        call.recv === null ||
        call.recv === 'this' ||
        call.recv === 'self' ||
        (selfVar !== undefined && call.recv === selfVar)
      ) {
        // same-class (or bare) call → the caller's class
        ownerType = callerClassLeaf
        ownerFile = file
        ownerMethods = methodsOfClass(pf.defs, callerClassLeaf)
      } else if (/^[A-Za-z_]\w*$/.test(call.recv)) {
        const t = localTypes.get(call.recv) ?? (/^[A-Z]/.test(call.recv) ? call.recv : undefined) // recv may itself be a Type (static call)
        if (t !== undefined) {
          const loc = await locate(t)
          if (loc !== null) {
            ownerType = t
            ownerFile = loc.ref
            ownerMethods = loc.methods
          }
        }
      }

      // ---- resolve ----
      if (ownerType !== null && ownerFile !== null && ownerMethods !== null) {
        const ownerClassId = ownerType.includes('::')
          ? ownerType
          : `${ownerFile}::${ownerClassLeafQn(ownerFile, ownerType, file, callerClass)}`
        if (call.kind === 'constructor' || ownerMethods.has(call.name)) {
          // a constructor target must point at the language's REAL ctor member
          // (TS/JS `constructor`, Python `__init__`, Java/Scala the class name) so
          // expanding it finds the ctor body — not a dangling `Type.Type` ref.
          const ctorName = ownerMethods.has('constructor')
            ? 'constructor'
            : ownerMethods.has('__init__')
              ? '__init__'
              : call.name
          const memberQn = `${ownerType}.${call.kind === 'constructor' ? ctorName : call.name}`
          out.push({
            ref: `${ownerFile}#${memberQn}`,
            label: `${call.kind === 'constructor' ? 'new ' : ''}${call.name}()`,
            kind: call.kind,
            order: call.order,
            resolution: 'resolved',
            ownerClass: ownerClassId,
          })
        } else {
          out.push({
            label: `${literal}()`,
            kind: call.kind,
            order: call.order,
            resolution: 'external',
            ownerClass: ownerClassId,
          })
        }
      } else {
        out.push({ label, kind: call.kind, order: call.order, resolution: 'unresolved' })
      }
    }
    return out
  } finally {
    for (const pf of cache.values()) pf?.tree.delete()
  }
}

/** Build the owner-class card id qn. For a same-file caller, prefer the caller's
 *  full nested class qn; cross-file, the bare type name. */
function ownerClassLeafQn(
  ownerFile: string,
  ownerType: string,
  callerFile: string,
  callerClassQn: string,
): string {
  if (ownerFile === callerFile && leaf(callerClassQn) === ownerType) return callerClassQn
  return ownerType
}
