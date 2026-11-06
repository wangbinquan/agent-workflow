// RFC-085 T2 — extract the calls a method makes, IN SOURCE ORDER.
//
// Per-language tree-sitter call queries capture each call/construction node with
// its receiver expression (`@recv`, optional) and the called name (`@name`).
// `extractCalls` runs the query scoped to a method's body subtree and returns the
// raw calls ordered by source position. Resolution (receiver type → class →
// method) happens later in resolve.ts — this file is pure structure extraction.

import type Parser from 'web-tree-sitter'
import type { LangId } from '@agent-workflow/shared'

type TsNode = Parser.SyntaxNode

export interface RawCall {
  /** receiver expression text (`this` / `self` / `service` / `a.b`), or null for a bare call. */
  recv: string | null
  /** the called method/type name. */
  name: string
  kind: 'method' | 'constructor'
  /** source-order index among this method's calls (0-based). */
  order: number
}

// `@call.new` → constructor; `@call.method`/`@call.bare`/`@call.scoped` → method.
const JAVA = `
(method_invocation object: (_)? @recv name: (identifier) @name) @call.method
(object_creation_expression type: (_) @name) @call.new
`
const TS_JS = `
(call_expression function: (member_expression object: (_) @recv property: (property_identifier) @name)) @call.method
(call_expression function: (identifier) @name) @call.bare
(new_expression constructor: (_) @name) @call.new
`
const PYTHON = `
(call function: (attribute object: (_) @recv attribute: (identifier) @name)) @call.method
(call function: (identifier) @name) @call.bare
`
const GO = `
(call_expression function: (selector_expression operand: (_) @recv field: (field_identifier) @name)) @call.method
(call_expression function: (identifier) @name) @call.bare
`
const RUST = `
(call_expression function: (field_expression value: (_) @recv field: (field_identifier) @name)) @call.method
(call_expression function: (scoped_identifier path: (_) @recv name: (identifier) @name)) @call.scoped
(call_expression function: (identifier) @name) @call.bare
`
// C++ method calls: the receiver field is named \`argument\` (covers \`a.foo()\`
// and \`a->foo()\`); \`value:\` is not a valid field here.
const CPP = `
(call_expression function: (field_expression argument: (_) @recv field: (field_identifier) @name)) @call.method
(call_expression function: (identifier) @name) @call.bare
(new_expression (type_identifier) @name) @call.new
`
const SCALA = `
(call_expression function: (field_expression value: (_) @recv field: (identifier) @name)) @call.method
(instance_expression (call_expression function: (identifier) @name)) @call.new
(call_expression function: (identifier) @name) @call.bare
`

const CALL_QUERIES: Partial<Record<LangId, string>> = {
  java: JAVA,
  typescript: TS_JS,
  javascript: TS_JS,
  python: PYTHON,
  go: GO,
  rust: RUST,
  cpp: CPP,
  scala: SCALA,
}

export function hasCallQuery(lang: LangId): boolean {
  return CALL_QUERIES[lang] !== undefined
}

/** Last identifier segment of a (possibly qualified/scoped) name node text. */
function leaf(text: string): string {
  const parts = text.split(/[.:]+/).filter((p) => p.length > 0)
  return parts[parts.length - 1] ?? text
}

const DYNAMIC: ReadonlySet<LangId> = new Set<LangId>(['python', 'javascript'])

/** Raw calls within `body`, source-ordered. `language` builds the query; `body`
 *  scopes it to one method. Dedups by node id (a node matched twice → first). */
export function extractCalls(body: TsNode, language: Parser.Language, lang: LangId): RawCall[] {
  const q = CALL_QUERIES[lang]
  if (q === undefined) return []
  const query = language.query(q)
  try {
    const seen = new Set<number>()
    const raws: Array<{
      recv: string | null
      name: string
      kind: 'method' | 'constructor'
      idx: number
    }> = []
    for (const m of query.matches(body)) {
      let callNode: TsNode | undefined
      let callTag = ''
      let recv: string | null = null
      let name = ''
      for (const c of m.captures) {
        if (c.name.startsWith('call.')) {
          callNode = c.node
          callTag = c.name
        } else if (c.name === 'recv') recv = c.node.text
        else if (c.name === 'name') name = c.node.text
      }
      if (callNode === undefined || name === '') continue
      // Scala `new Bar()` is an `instance_expression` wrapping a `call_expression`,
      // so the same site matches BOTH `@call.new` (outer) and `@call.bare` (inner)
      // on distinct nodes — dedup-by-id misses it. Drop the inner bare so the site
      // is counted once (as the constructor), not also as a phantom external method.
      if (callTag === 'call.bare' && callNode.parent?.type === 'instance_expression') continue
      if (seen.has(callNode.id)) continue
      seen.add(callNode.id)
      const leafName = leaf(name)
      // constructor: explicit `new`/`object_creation`, or a bare Capitalized call
      // in a dynamic language (Python/JS `Foo()` is a construction).
      const isNew = callTag === 'call.new'
      const isCtorLike =
        isNew || (callTag === 'call.bare' && DYNAMIC.has(lang) && /^[A-Z]/.test(leafName))
      raws.push({
        recv,
        name: leafName,
        kind: isCtorLike ? 'constructor' : 'method',
        idx: callNode.startIndex,
      })
    }
    raws.sort((a, b) => a.idx - b.idx)
    return raws.map((r, order) => ({ recv: r.recv, name: r.name, kind: r.kind, order }))
  } finally {
    query.delete()
  }
}
