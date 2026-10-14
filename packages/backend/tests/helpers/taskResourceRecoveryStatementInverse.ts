import ts from 'typescript'
import reviewed from '../fixtures/rfc370-task-resource-recovery-original-sources.json'
import { inverseRfc371V2Sources } from './rfc371V2SourceInverse'

/** Remove only this finite recovery delta before the older HumanGate inverse.
 * Every introduced fragment must still match, and every other byte survives
 * for the original whole-source and lifecycle-call locks to inspect. */
export function inverseTaskResourceRecoverySelections(source: ts.SourceFile): ts.SourceFile {
  source = inverseRfc371V2Sources(source)
  const entry = reviewed.files.find((row) => source.fileName.endsWith(row.path))
  if (entry === undefined) return source
  let text = source.text
  for (const [index, edit] of [...entry.inverseEdits.entries()].reverse()) {
    if (text.slice(edit.start, edit.end) !== edit.introduced) {
      throw new Error(`resource-recovery inverse unreviewed fragment: ${entry.path}:${index}`)
    }
    text = text.slice(0, edit.start) + edit.previous + text.slice(edit.end)
  }
  return ts.createSourceFile(source.fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}
