import ts from 'typescript'
import { inverseRfc371V2Sources } from './rfc371V2SourceInverse'

/** Exact inverse of the implementation gate's two selected Event Center
 * choices. Historical complete native root fingerprints remain unchanged. */
export function inverseStageAImplementationGateRoots(source: ts.SourceFile): ts.SourceFile {
  source = inverseRfc371V2Sources(source)
  const selected = source.fileName.endsWith('cli/start.ts')
    ? {
        call: '  const employeeHttpEventCenter = await composeEventCenter({\n',
        field: "    ...(hostExecution ? { executionMode: 'host' as const } : {}),\n",
      }
    : source.fileName.endsWith('cli/postgresqlDaemonApplication.ts')
      ? {
          call: '  const eventCenter = await composeEventCenter({\n',
          field: "    ...(input.hostExecution ? { executionMode: 'host' as const } : {}),\n",
        }
      : undefined
  if (selected === undefined) return source
  const introduced = selected.call + selected.field
  const count = source.text.split(introduced).length - 1
  if (count === 0 && source.text.split(selected.call).length === 2) return source
  if (count !== 1) throw new Error('stage A implementation gate root inverse unreviewed choice')
  return ts.createSourceFile(
    source.fileName,
    source.text.replace(introduced, selected.call),
    ts.ScriptTarget.Latest,
    true,
  )
}
