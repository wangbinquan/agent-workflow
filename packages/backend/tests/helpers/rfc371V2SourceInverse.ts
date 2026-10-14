import ts from 'typescript'
import reviewed from '../fixtures/rfc371-v2-source-inverse.json'

// RFC-371 v2 (design/RFC-371-run-observability/redesign-v2-20261014.md) replaced
// the v1 observation assembly inside roots that RFC-370 source oracles pin. This
// test-only inverse restores the exact previous bytes of every reviewed hunk so
// the existing oracle chains keep checking everything else. It applies only to a
// root that carries every reviewed hunk exactly once; any other text (already
// restored, rewritten by an older inverse, or changed elsewhere) passes through
// unchanged and stays visible to the downstream exact-byte oracles.

/** `cli/start.ts`, `src/cli/start.ts`, repository-relative, absolute and Windows names alike. */
function reviewedFile(fileName: string) {
  const name = '/' + fileName.replaceAll('\\', '/')
  return reviewed.files.find((row) => name === '/' + row.path || name.endsWith('/src/' + row.path))
}

export function inverseRfc371V2Sources(source: ts.SourceFile): ts.SourceFile {
  const entry = reviewedFile(source.fileName)
  if (entry === undefined) return source
  const found = entry.hunks.map((hunk) => {
    const first = source.text.indexOf(hunk.current)
    const unique = first >= 0 && source.text.indexOf(hunk.current, first + 1) < 0
    return { start: unique ? first : -1, hunk }
  })
  if (found.some((item) => item.start < 0)) return source
  let text = source.text
  for (const { start, hunk } of [...found].sort((a, b) => b.start - a.start))
    text = text.slice(0, start) + hunk.previous + text.slice(start + hunk.current.length)
  return ts.createSourceFile(source.fileName, text, ts.ScriptTarget.Latest, true)
}
