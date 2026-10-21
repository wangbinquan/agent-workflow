import ts from 'typescript'
import service from '../fixtures/rfc372-clarify-service-inverse.json'

export function inverseRfc372ClarifyService(source: ts.SourceFile): ts.SourceFile {
  if (!source.fileName.replaceAll('\\', '/').endsWith(service.path)) return source
  let text = source.text
  for (const change of service.changes) {
    if (text.split(change.introduced).length !== 2)
      throw new Error('clarify service inverse unreviewed or incomplete fragment')
    text = text.replace(change.introduced, change.previous)
  }
  return ts.createSourceFile(source.fileName, text, ts.ScriptTarget.Latest, true)
}

// Test-only inverse of the two RFC-372 bootstrap bindings. Every other byte,
// including concurrent observation hooks, remains visible to older source oracles.
export function inverseRfc372ClarifyRootBinding(source: ts.SourceFile): ts.SourceFile {
  const path = '/' + source.fileName.replaceAll('\\', '/')
  const receiver = path.endsWith('/server.ts')
    ? { db: 'input.db', registry: 'core.runtimeRegistry' }
    : undefined
  if (!receiver) return source
  const additions = [
    "import { composeClarifyFollowupGenerator } from '@/modules/task-execution/composition/clarifyFollowupGenerator'\n",
    '    followupGenerator: composeClarifyFollowupGenerator({\n' +
      `      db: ${receiver.db},\n` +
      `      registry: ${receiver.registry},\n` +
      '      binding: narrativeSystemAgentBinding,\n' +
      '    }),\n',
  ]
  const counts = additions.map((text) => source.text.split(text).length - 1)
  if (counts.every((count) => count === 0)) return source
  if (!counts.every((count) => count === 1))
    throw new Error('clarify root inverse unreviewed or incomplete binding')
  let text = source.text
  for (const addition of additions) text = text.replace(addition, '')
  return ts.createSourceFile(source.fileName, text, ts.ScriptTarget.Latest, true)
}
