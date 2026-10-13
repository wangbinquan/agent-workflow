import ts from 'typescript'
import reviewed from '../fixtures/rfc370-preexisting-ci-root-hooks.json'

/** User-approved finite test-only inverse of already committed
 * native forwarding/projection hooks. Never alters the production hooks or
 * original complete-source hashes, and rejects changed/duplicate fragments. */
export function inversePreexistingCiRootHooks(source: ts.SourceFile): ts.SourceFile {
  const entry = reviewed.roots.find((row) =>
    source.fileName.endsWith(row.path.slice('packages/backend/src/'.length)),
  )
  if (!entry) return source
  let text = source.text
  const counts = entry.introduced.map((part) => text.split(part).length - 1)
  if (counts.every((count) => count === 0)) return source
  if (!counts.every((count) => count === 1)) {
    const projection = entry.introduced.findIndex((part) => part.includes('projection:'))
    const originalStatement =
      projection >= 0 && counts[projection] !== 1
        ? ': task-launch inverse unreviewed statement: observationReports'
        : ''
    throw new Error('pre-existing root hook inverse unreviewed or incomplete' + originalStatement)
  }
  for (const introduced of entry.introduced) text = text.replace(introduced, '')
  return ts.createSourceFile(source.fileName, text, ts.ScriptTarget.Latest, true)
}
