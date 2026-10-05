import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

/** Source locks follow the actual split implementation, never a generated or
 * historical snapshot. Business and native binding assertions still inspect
 * their real statements; the legacy Runner file is now only the public facade. */
export function readTaskAgentSources(): string {
  return [
    'modules/task-execution/application/taskAgentRun.ts',
    'modules/task-execution/infrastructure/local/nativeTaskAgentRun.ts',
    'modules/task-execution/infrastructure/local/nativeTaskAgentRunOptions.ts',
    'modules/task-execution/infrastructure/local/nativeTaskAgentPluginLoadDiagnostics.ts',
  ]
    .map((file) => readFileSync(resolve(import.meta.dir, '../../src', file), 'utf8'))
    .join('\n')
}

export function taskAgentSource(): ts.SourceFile {
  return ts.createSourceFile(
    'taskAgentRun.ts',
    readTaskAgentSources(),
    ts.ScriptTarget.Latest,
    true,
  )
}
