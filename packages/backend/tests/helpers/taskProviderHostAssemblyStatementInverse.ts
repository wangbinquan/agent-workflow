import { inversePreexistingCiRootHooks } from './preexistingCiRootStatementInverse'
import ts from 'typescript'
import { inverseStageAOwnerBindings } from './stageAOwnerStatementInverse'
import reviewed from '../fixtures/rfc370-task-provider-host-assembly-original-sources.json'
import { inverseRfc213DevStartupRoot } from './rfc213DevStartupRootInverse'
import { inverseRfc371NativeFactRootHooks } from './rfc371NativeFactRootInverse'
import { inverseRfc372ClarifyRootBinding } from './rfc372ClarifyRootInverse'

/** Compose only the reviewed predecessors before locating Task assembly edits. */
export function normalizeTaskProviderHostAssemblyInput(source: ts.SourceFile): ts.SourceFile {
  // The reviewed CI boundary correction exposes the original lifecycle
  // factory through composition. Retain the older complete native oracle.
  const factoryExport = 'export { createDatabaseTaskDriverLifecyclePort }\n'
  if (
    source.fileName
      .replaceAll('\\', '/')
      .endsWith('modules/task-execution/composition/providerRuntime.ts') &&
    source.text.includes(factoryExport)
  ) {
    if (source.text.split(factoryExport).length !== 2)
      throw new Error('host composition factory inverse unreviewed export')
    source = ts.createSourceFile(
      source.fileName,
      source.text.replace(factoryExport, ''),
      ts.ScriptTarget.Latest,
      true,
    )
  }
  source = inverseRfc213DevStartupRoot(source)
  source = inverseRfc372ClarifyRootBinding(source)
  source = inverseRfc371NativeFactRootHooks(source)
  source = inverseStageAOwnerBindings(source)
  return source
}

/** Accept only exact Task fragments in the already normalized source. */
export function inversePreparedTaskProviderHostAssembly(source: ts.SourceFile): ts.SourceFile {
  const entry = reviewed.sources.find((row) =>
    source.fileName.endsWith(row.path.slice('packages/backend/src/'.length)),
  )
  if (entry === undefined) return source
  const edits = entry.changes.map((change) => {
    for (const candidate of change.anchors) {
      const matches: number[] = []
      for (
        let start = source.text.indexOf(candidate.needle);
        start >= 0;
        start = source.text.indexOf(candidate.needle, start + 1)
      )
        matches.push(start)
      if (matches.length !== candidate.count) continue
      const start = matches[candidate.index]!
      const position = start + candidate.offset
      if (source.text.slice(position, position + change.introduced.length) !== change.introduced)
        continue
      return { start: position, end: position + change.introduced.length, text: change.previous }
    }
    throw new Error(`task-provider-host inverse unreviewed fragment: ${entry.path}:${change.start}`)
  })
  if (edits.some((edit, i) => i > 0 && edit.start < edits[i - 1]!.end))
    throw new Error(`task-provider-host inverse fragment order changed: ${entry.path}`)
  let text = source.text
  for (const edit of [...edits].reverse())
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
  return inversePreexistingCiRootHooks(
    ts.createSourceFile(source.fileName, text, ts.ScriptTarget.Latest, true),
  )
}

/** Compose exact shared root hooks before the finite Task provider host assembly inverse. */
export function inverseTaskProviderHostAssembly(source: ts.SourceFile): ts.SourceFile {
  return inversePreparedTaskProviderHostAssembly(normalizeTaskProviderHostAssemblyInput(source))
}
