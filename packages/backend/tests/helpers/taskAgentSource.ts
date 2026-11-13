import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

/** Source locks follow the actual split implementation, never a generated or
 * historical snapshot. Business and native binding assertions still inspect
 * their real statements; the legacy Runner file is now only the public facade. */
export function readTaskAgentSources(): string {
  return [
    'modules/task-execution/application/taskAgentRun.ts',
    // RFC-491: the native compatibility run moved to tests/helpers; the plugin-load judgment to runtime-management.
    '../tests/helpers/nativeTaskAgentRun.ts',
    '../tests/helpers/nativeTaskAgentRunOptions.ts',
    'modules/runtime-management/infrastructure/local/pluginLoadDiagnostics.ts',
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
