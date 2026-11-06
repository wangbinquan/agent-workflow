// RFC-085 T2 — lightweight cross-file resolution support (PURE).
//
//  - `inferLocalTypes`    : best-effort `varName → TypeName` from a method's
//    params + its class's fields + local `Type v` / `v = new Type()` decls.
//
// Heuristic (the RFC's accepted "尽力而为"): statically-typed languages
// resolve well; dynamic ones (no type text) mostly yield nothing → unresolved.
// RFC-453: the shallow class-name→file index (`scanClassDecls` / `buildClassIndex`) moved to source-control,
// whose revision content answers `classIndex()`.

/** Best-effort `varName → TypeName` (leaf) from the given declaration texts. Scans
 *  three shapes, language-agnostic-ish:
 *   - `Type name`            (Java/Go/Rust/C++ params, fields, locals)
 *   - `name: Type`           (TS/Scala/Python annotations)
 *   - `name = new Type(`     (constructions)
 *  Only Capitalised type names are taken (class convention) to limit noise. */
export function inferLocalTypes(...texts: Array<string | undefined>): Map<string, string> {
  const out = new Map<string, string>()
  const text = texts.filter((t): t is string => t !== undefined).join('\n')
  const put = (name: string | undefined, type: string | undefined): void => {
    if (name === undefined || type === undefined) return
    if (!/^[A-Z]/.test(type)) return
    if (!out.has(name)) out.set(name, type.replace(/<.*$/, '')) // drop generics
  }
  // name = new Type(
  for (const m of text.matchAll(/\b(\w+)\s*[:=]\s*new\s+([A-Za-z_][\w.]*)/g))
    put(m[1], leafType(m[2]))
  // name: Type   (annotation; not `::` scope, not `=`)
  for (const m of text.matchAll(/\b(\w+)\s*:\s*([A-Z][\w.]*)/g)) put(m[1], leafType(m[2]))
  // Type name   (type-first; Type is Capitalised, name lower-ish). The negative
  // lookahead `(?!\s*\()` drops a METHOD DECLARATION (`Foo getFoo()`) so a return
  // type is never mistaken for a local var's type — that would fabricate a
  // `resolved` edge (`getFoo.x()` → Foo.x), violating the RFC's 绝不臆造 invariant.
  for (const m of text.matchAll(/\b([A-Z][\w.]*(?:<[^>]*>)?)\s+([a-z_]\w*)\b(?!\s*\()/g))
    put(m[2], leafType(m[1]))
  return out
}

function leafType(t: string | undefined): string | undefined {
  if (t === undefined) return undefined
  const base = t.replace(/<.*$/, '')
  const parts = base.split(/[.:]+/).filter((p) => p.length > 0)
  return parts[parts.length - 1] ?? base
}
