import ts from 'typescript'
import { createHash } from 'node:crypto'
import reviewed from '../fixtures/rfc370-stage-a-owner-original-sources.json'
import { inverseStageAImplementationGateRoots } from './stageAImplementationGateRootInverse'

/** Remove only the reviewed stage A owner/recovery additions. Keep every
 * pre-existing native and concurrent hook for the older whole-source oracles. */
export function inverseStageAOwnerBindings(source: ts.SourceFile): ts.SourceFile {
  source = inverseStageAImplementationGateRoots(source)
  const entry = reviewed.sources.find((row) =>
    source.fileName.endsWith(row.path.slice('packages/backend/src/'.length)),
  )
  if (!entry) return source
  if (createHash('sha256').update(source.text).digest('hex') === entry.previousSha256) return source
  const edits = entry.changes.map((change) => {
    for (const anchor of change.anchors) {
      const matches: number[] = []
      for (
        let at = source.text.indexOf(anchor.needle);
        at >= 0;
        at = source.text.indexOf(anchor.needle, at + 1)
      )
        matches.push(at)
      if (matches.length !== anchor.count) continue
      const at = matches[anchor.index]! + anchor.offset
      if (source.text.slice(at, at + change.introduced.length) !== change.introduced) continue
      return { start: at, end: at + change.introduced.length, text: change.previous }
    }
    throw new Error(`stage A owner inverse unreviewed fragment: ${entry.path}`)
  })
  let text = source.text
  for (const edit of [...edits].sort((left, right) => right.start - left.start))
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
  return ts.createSourceFile(source.fileName, text, ts.ScriptTarget.Latest, true)
}
