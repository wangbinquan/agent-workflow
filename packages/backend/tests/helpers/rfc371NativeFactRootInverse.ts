import ts from 'typescript'

const build = '    build: (report, _spool, signal) => observationBuild.build(report, signal),\n'
const close = '    closeBuild: () => observationBuild.close(),\n'

/** Test-only inverse of both approved cache revisions; every other root byte remains visible. */
export function inverseRfc371NativeFactRootHooks(source: ts.SourceFile): ts.SourceFile {
  const home = source.fileName.endsWith('cli/start.ts')
    ? '    Paths.root,\n'
    : source.fileName.endsWith('cli/postgresqlDaemonApplication.ts')
      ? '    input.appHome,\n'
      : undefined
  if (home === undefined) return source
  const writer = source.fileName.endsWith('cli/start.ts') ? '    db,\n' : '    input.db,\n'
  const tail = '  )\n  const observationReports = composeCompleteObservationReports({\n'
  const count = (text: string) => source.text.split(text).length - 1
  const calculations = home + writer + '    { taskCalculations: true },\n' + tail
  const currentArguments = count(calculations) > 0 ? calculations : home + writer + tail
  const changes = [
    { current: currentArguments, previous: home + tail },
    { current: build + close + '  })\n', previous: build + '  })\n' },
  ]
  if (changes.every((change) => count(change.current) === 0 && count(change.previous) === 1))
    return source
  if (!changes.every((change) => count(change.current) === 1 && count(change.previous) === 0))
    throw new Error('native-fact root inverse unreviewed or incomplete hooks')
  let text = source.text
  for (const change of changes) text = text.replace(change.current, change.previous)
  return ts.createSourceFile(source.fileName, text, ts.ScriptTarget.Latest, true)
}
