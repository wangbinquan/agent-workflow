import ts from 'typescript'
import reviewed from '../fixtures/rfc370-task-human-gate-original-sources.json'

/** Remove only the declared HumanGate delta. Every introduced fragment must
 * still match; all other bytes pass through to the whole original-source lock.
 * Older lifecycle inverses call this explicitly, never through source(). */
export function inverseHumanGateTaskSelections(source: ts.SourceFile): ts.SourceFile {
  const entry = reviewed.files.find((row) => source.fileName.endsWith(row.path))
  if (entry === undefined) return source
  let text = source.text
  for (const [index, edit] of [...entry.inverseEdits.entries()].reverse()) {
    if (text.slice(edit.start, edit.end) !== edit.introduced) {
      throw new Error(`human-gate inverse unreviewed fragment: ${entry.path}:${index}`)
    }
    text = text.slice(0, edit.start) + edit.previous + text.slice(edit.end)
  }
  return ts.createSourceFile(source.fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}
