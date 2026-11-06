// RFC-085 T2 — lightweight cross-file resolution support (PURE).
//
//  - `scanClassDecls`     : a SHALLOW class-name→file index (regex over decl
//    lines, NOT a full parse) so a type name can be located to its file lazily.
//
// Heuristic (the RFC's accepted "尽力而为"). RFC-453: moved here from the structural-diff call graph — it only
// serves this context's `RepositoryRevisionContent.classIndex()`; `inferLocalTypes` stayed in workspace-insight.

/** class/interface/struct/enum/trait/object declaration name → file path(s).
 *  Two shapes: keyword-first (`class Foo`, Rust `struct Foo`) and Go's name-first
 *  `type Foo struct|interface`. */
export function scanClassDecls(file: string, source: string): string[] {
  const out = new Set<string>()
  const re = /\b(?:class|interface|struct|enum|trait|object)\s+([A-Za-z_]\w*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    if (m[1] !== undefined) out.add(m[1])
  }
  // Go: `type Game struct {…}` / `type Reader interface {…}`
  const go = /\btype\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/g
  while ((m = go.exec(source)) !== null) {
    if (m[1] !== undefined) out.add(m[1])
  }
  void file
  return [...out]
}

/** Merge per-file class names into a name → files index. */
export function buildClassIndex(
  perFile: Array<{ file: string; names: string[] }>,
): Map<string, string[]> {
  const idx = new Map<string, string[]>()
  for (const { file, names } of perFile) {
    for (const n of names) {
      const arr = idx.get(n) ?? []
      if (!arr.includes(file)) arr.push(file)
      idx.set(n, arr)
    }
  }
  return idx
}
