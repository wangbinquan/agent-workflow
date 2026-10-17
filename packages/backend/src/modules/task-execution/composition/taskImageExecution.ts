import { resolve } from 'node:path'
import { rmSync } from 'node:fs'
import type { ScriptLanguage } from '@agent-workflow/shared'
import { requireWorkPath } from '@/platform/crewstation/workVolumePath'
import {
  resolveScriptInterpreter,
  runScriptProcess,
  type ScriptRunRequest,
} from '../infrastructure/local/scriptRun'
import { ensureScriptDepsEnv } from '../infrastructure/local/scriptDepsEnv'
import { createFilePortArtifactContent } from '../infrastructure/local/filePortArtifactContent'
import { resolveNativePortContentDetailed } from './portOutputValidation'

export const TASK_IMAGE_EXECUTION_OPERATIONS = [
  'validate-output',
  'file-info',
  'script-interpreter',
  'script-dependencies',
  'run-script',
  'delete-task-content',
] as const

export async function executeTaskImageExecutionOperation(
  operation: string,
  value: unknown,
  signal?: AbortSignal,
  volumeRoot = '/work',
): Promise<unknown> {
  const root = resolve(volumeRoot)
  const workPath = (path: string) => requireWorkPath(path, root)
  switch (operation) {
    case 'delete-task-content': {
      const path = workPath((value as { path: string }).path)
      if (path === root) throw new Error('hosted-task-delete-root-refused')
      rmSync(path, { recursive: true, force: true })
      return null
    }
    case 'validate-output': {
      const input = value as Parameters<typeof resolveNativePortContentDetailed>[0]
      return resolveNativePortContentDetailed({
        ...input,
        worktreePath: workPath(input.worktreePath),
      })
    }
    case 'file-info': {
      const input = value as { workspaceRef: string; relativePath: string }
      const source = { ...input, workspaceRef: workPath(input.workspaceRef) }
      const files = createFilePortArtifactContent(root)
      return { size: files.size(source), linkTarget: files.linkTarget(source) }
    }
    case 'script-interpreter': {
      const input = value as {
        language: ScriptLanguage
        overrides: Partial<Record<ScriptLanguage, string>>
      }
      return resolveScriptInterpreter(input.language, input.overrides)
    }
    case 'script-dependencies': {
      const input = value as Parameters<typeof ensureScriptDepsEnv>[0]
      return ensureScriptDepsEnv({
        ...input,
        appHome: root,
        onLine: (stream, line) => {
          if (stream === 'stderr') console.error(line)
          else console.log(line)
        },
      })
    }
    case 'run-script': {
      const input = value as ScriptRunRequest
      const result = await runScriptProcess({
        ...input,
        ...(signal === undefined ? {} : { signal }),
        runDir: workPath(input.runDir),
        worktreePath: workPath(input.worktreePath),
        onStdoutLine: (line) => {
          console.log(line)
        },
        onStderrLine: (line) => {
          console.error(line)
        },
      })
      // The platform owns process identity: never return the helper's local
      // PID. Stdout already streamed as the command's output; the control
      // plane rebuilds it from those events instead of a second copy here.
      return {
        result: {
          outcome: result.result.outcome,
          exitCode: result.result.exitCode,
          stderrTail: result.result.stderrTail,
          truncated: result.result.truncated,
          spawnError: result.result.spawnError,
        },
        failureCode: result.failureCode,
      }
    }
    default:
      throw new Error(`workspace-helper-operation-unknown: ${operation}`)
  }
}
