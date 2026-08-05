// RFC-083 PR-E — SCIP index reader (PURE: bytes → reference graph, no I/O).
//
// SCIP (Sourcegraph Code Intelligence Protocol) is a protobuf format emitted by
// the per-language indexers (scip-typescript / scip-python / …). We decode only
// the subset deep-mode needs — documents → occurrences {symbol, range,
// symbol_roles} — with the REAL field numbers from scip.proto. protobuf is
// forward-compatible, so unknown fields (metadata, external_symbols, syntax
// kind, …) in a real index are ignored cleanly. We deliberately avoid the full
// generated schema package: a 3-field subset + the ubiquitous `protobufjs`
// round-trips real indexer output AND lets tests mint fixtures in code (no
// committed binary blobs).

import protobuf from 'protobufjs'

// scip.proto field numbers (https://github.com/sourcegraph/scip): Index.documents=2;
// Document.relative_path=1, occurrences=2, language=4; Occurrence.range=1,
// symbol=2, symbol_roles=3. SymbolRole.Definition = 0x1.
const SCIP_PROTO = `
syntax = "proto3";
package scip;
message Index { repeated Document documents = 2; }
message Document { string relative_path = 1; repeated Occurrence occurrences = 2; string language = 4; }
message Occurrence { repeated int32 range = 1; string symbol = 2; int32 symbol_roles = 3; }
`

const INDEX_TYPE = protobuf.parse(SCIP_PROTO).root.lookupType('scip.Index')
const SYMBOL_ROLE_DEFINITION = 0x1

export interface ScipOccurrence {
  symbol: string
  /** SCIP range: [startLine, startChar, endChar] or [startLine, startChar,
   *  endLine, endChar] — 0-based, half-open. */
  range: number[]
  isDefinition: boolean
}
export interface ScipDocument {
  relativePath: string
  occurrences: ScipOccurrence[]
}
export interface ScipGraph {
  documents: ScipDocument[]
  /** symbol string → every occurrence of it across documents (O(1) reverse-ref).
   *  RFC-258 gate F-03: `local N` symbols are DOCUMENT-scoped in SCIP — two
   *  files both emit `local 0` for unrelated locals — so local symbols are
   *  stored under a `${doc}\0${symbol}` compound key. Always look occurrences
   *  up through `occurrencesOf` (which routes on the `local ` prefix), never
   *  via a raw `bySymbol.get`. */
  bySymbol: Map<string, Array<{ doc: string; occ: ScipOccurrence }>>
}

/** SCIP local symbols are `local <id>` (document-scoped). */
export function isLocalScipSymbol(symbol: string): boolean {
  return symbol.startsWith('local ')
}

function localKey(doc: string, symbol: string): string {
  return `${doc}\u0000${symbol}`
}

/** Occurrences of `symbol`, honouring SCIP local-symbol document scoping.
 *  `doc` is the document the symbol was observed in — required to resolve a
 *  local symbol; ignored for global ones. */
export function occurrencesOf(
  graph: ScipGraph,
  symbol: string,
  doc: string,
): Array<{ doc: string; occ: ScipOccurrence }> {
  const key = isLocalScipSymbol(symbol) ? localKey(doc, symbol) : symbol
  return graph.bySymbol.get(key) ?? []
}

export class ScipParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScipParseError'
  }
}

/** Decode a SCIP index. Throws ScipParseError on malformed/truncated bytes. An
 *  empty index (0 documents) yields an empty graph and does NOT throw. */
export function parseScip(bytes: Uint8Array): ScipGraph {
  let decoded: { documents?: Array<{ relativePath?: string; occurrences?: unknown[] }> }
  try {
    decoded = INDEX_TYPE.toObject(INDEX_TYPE.decode(bytes), { defaults: true, arrays: true }) as {
      documents?: Array<{ relativePath?: string; occurrences?: unknown[] }>
    }
  } catch (e) {
    throw new ScipParseError(`malformed SCIP index: ${e instanceof Error ? e.message : String(e)}`)
  }
  const documents: ScipDocument[] = (decoded.documents ?? []).map((d) => ({
    relativePath: d.relativePath ?? '',
    occurrences: (d.occurrences ?? []).map((raw) => {
      const o = raw as { symbol?: string; range?: number[]; symbolRoles?: number }
      return {
        symbol: o.symbol ?? '',
        range: o.range ?? [],
        isDefinition: ((o.symbolRoles ?? 0) & SYMBOL_ROLE_DEFINITION) !== 0,
      }
    }),
  }))
  return { documents, bySymbol: buildSymbolIndex(documents) }
}

/** Merge several SCIP graphs (one per language indexer) into one, rebuilding the
 *  symbol index over the combined documents. */
export function mergeScipGraphs(graphs: ScipGraph[]): ScipGraph {
  const documents = graphs.flatMap((g) => g.documents)
  return { documents, bySymbol: buildSymbolIndex(documents) }
}

export function buildSymbolIndex(documents: ScipDocument[]): ScipGraph['bySymbol'] {
  const m = new Map<string, Array<{ doc: string; occ: ScipOccurrence }>>()
  for (const d of documents) {
    for (const occ of d.occurrences) {
      if (occ.symbol === '') continue
      // F-03 — document-scope local symbols so `local 0` never crosses files.
      const key = isLocalScipSymbol(occ.symbol) ? localKey(d.relativePath, occ.symbol) : occ.symbol
      const arr = m.get(key)
      if (arr === undefined) m.set(key, [{ doc: d.relativePath, occ }])
      else arr.push({ doc: d.relativePath, occ })
    }
  }
  return m
}

/** Encode documents back to SCIP bytes — used by tests to mint fixtures in code
 *  (deterministic, no committed binary). */
export function encodeScipFixture(documents: ScipDocument[]): Uint8Array {
  const obj = {
    documents: documents.map((d) => ({
      relativePath: d.relativePath,
      occurrences: d.occurrences.map((o) => ({
        range: o.range,
        symbol: o.symbol,
        symbolRoles: o.isDefinition ? SYMBOL_ROLE_DEFINITION : 0,
      })),
    })),
  }
  return INDEX_TYPE.encode(INDEX_TYPE.fromObject(obj)).finish()
}
