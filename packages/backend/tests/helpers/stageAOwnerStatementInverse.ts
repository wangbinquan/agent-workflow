import ts from 'typescript'
import { createHash } from 'node:crypto'
import reviewed from '../fixtures/rfc370-stage-a-owner-original-sources.json'

/** Remove only the reviewed stage A owner/recovery additions. Keep every
 * pre-existing native and concurrent hook for the older whole-source oracles. */
export function inverseStageAOwnerBindings(source: ts.SourceFile): ts.SourceFile {
  const entry = reviewed.sources.find((row) =>
    source.fileName.endsWith(row.path.slice('packages/backend/src/'.length)),
  )
  if (!entry) return source
  if (createHash('sha256').update(source.text).digest('hex') === entry.previousSha256) return source
  const edits = entry.changes.map((change) => {
    const start = source.text.indexOf(change.needle)
    if (start < 0 || source.text.indexOf(change.needle, start + 1) >= 0)
      throw new Error(`stage A owner inverse unreviewed fragment: ${entry.path}`)
    const at = start + change.offset
    return { start: at, end: at + change.introduced.length, text: change.previous }
  })
  let text = source.text
  for (const edit of [...edits].sort((left, right) => right.start - left.start))
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
  return ts.createSourceFile(source.fileName, text, ts.ScriptTarget.Latest, true)
}
