import ts from 'typescript'

type Change = {
  readonly current: string
  readonly previous: string
  readonly uniqueMarker?: string
  readonly occurrences?: number
}

const preparation: readonly Change[] = [
  {
    current:
      '  host?: string\n' +
      '  /** Process-local preparation shared only by the development hot reloader. */\n' +
      '  developmentIntegrity?: { validatedDatabase?: string }\n' +
      '  configuration?: ApplicationConfigurationQueries\n',
    previous: '  host?: string\n  configuration?: ApplicationConfigurationQueries\n',
  },
  {
    current:
      '  const server = Bun.serve({\n' +
      '    // Bun --hot otherwise aliases the HTTP and control listeners when both\n' +
      "    // request an ephemeral port. Keep this application's reload identity distinct.\n" +
      '    id: `agent-workflow-http:${input.bindHost}:${input.bindPort}`,\n' +
      '    port: input.bindPort,\n',
    previous: '  const server = Bun.serve({\n    port: input.bindPort,\n',
  },
  {
    current:
      "          skipIntegrityCheck: process.env.AGENT_WORKFLOW_SKIP_INTEGRITY_CHECK === '1',\n" +
      '          developmentIntegrity: opts.developmentIntegrity,\n' +
      '        },\n',
    previous:
      "          skipIntegrityCheck: process.env.AGENT_WORKFLOW_SKIP_INTEGRITY_CHECK === '1',\n" +
      '        },\n',
  },
]
const declarationCheck: readonly Change[] = [
  {
    current:
      "import { getRuntimeDriver, RUNTIME_KINDS } from '@/services/runtime'\n" +
      "import { assertRuntimeDeclarations } from '@/services/runtime/selfCheck'\n",
    previous: "import { getRuntimeDriver } from '@/services/runtime'\n",
    uniqueMarker: "import { assertRuntimeDeclarations } from '@/services/runtime/selfCheck'\n",
  },
  {
    occurrences: 2,
    current:
      "      'runtime-declarations': async () => {\n" +
      '        const { notModeled } = assertRuntimeDeclarations(RUNTIME_KINDS.map(getRuntimeDriver))\n',
    previous:
      "      'runtime-declarations': async () => {\n" +
      "        const { assertRuntimeDeclarations } = await import('@/services/runtime/selfCheck')\n" +
      "        const { getRuntimeDriver, RUNTIME_KINDS } = await import('@/services/runtime')\n" +
      '        const { notModeled } = assertRuntimeDeclarations(RUNTIME_KINDS.map(getRuntimeDriver))\n',
  },
]

function inverseRevision(text: string, changes: readonly Change[]): string {
  const count = (fragment: string) => text.split(fragment).length - 1
  if (changes.some((change) => change.uniqueMarker && count(change.uniqueMarker) > 1))
    throw new Error('dev startup root inverse unreviewed or incomplete revision')
  if (
    changes.every(
      (change) =>
        count(change.current) === 0 && count(change.previous) === (change.occurrences ?? 1),
    )
  )
    return text
  if (
    !changes.every(
      (change) =>
        count(change.current) === (change.occurrences ?? 1) && count(change.previous) === 0,
    )
  )
    throw new Error('dev startup root inverse unreviewed or incomplete revision')
  for (const change of changes) text = text.replaceAll(change.current, change.previous)
  return text
}

// Test-only inverse of the approved development preparation and static self-check
// imports in both RFC-379 provider bindings. Preserve every other byte, including
// concurrent host/observation edits; a partial or changed binding must fail closed.
export function inverseRfc213DevStartupRoot(source: ts.SourceFile): ts.SourceFile {
  if (!('/' + source.fileName.replaceAll('\\', '/')).endsWith('/cli/start.ts')) return source
  const text = inverseRevision(inverseRevision(source.text, declarationCheck), preparation)
  if (text === source.text) return source
  return ts.createSourceFile(source.fileName, text, ts.ScriptTarget.Latest, true)
}
