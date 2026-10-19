// RFC-370 §10 V19 — a program fixture run on this host's interpreter, in a
// throw-away directory. The hosted task image runs the same code
// (`execution-contract-fixture`).
import type { WorkflowNode } from '@agent-workflow/shared'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { resolveScriptInterpreter, runScriptProcess } from './scriptRun'
import type { ScriptFixtureProcess } from '../../application/ports/scriptFixture'

export function createLocalScriptFixtureProcess(
  input: {
    readonly scriptInterpreterOverrides?: Partial<Record<'bash' | 'node' | 'python', string>>
    /** Parent of the throw-away directory (the task image passes its volume). */
    readonly scratchRoot?: string
  } = {},
): ScriptFixtureProcess {
  return {
    async run(run) {
      const interpreter = await resolveScriptInterpreter(
        run.runtimeKind,
        input.scriptInterpreterOverrides ?? {},
      )
      if (interpreter === null) return { kind: 'interpreter-unavailable' }
      const parent = input.scratchRoot ?? tmpdir()
      mkdirSync(parent, { recursive: true })
      const root = mkdtempSync(join(parent, 'agent-workflow-execution-contract-'))
      const runDir = join(root, 'run')
      const worktreePath = join(root, 'worktree')
      const node = {
        id: 'execution-contract-fixture',
        kind: 'script',
        language: run.runtimeKind,
        script: run.source,
        env: {
          DIGITAL_EMPLOYEE_TOOL_PARAMETERS_JSON: run.parameterValuesJson,
        },
      } as WorkflowNode
      try {
        mkdirSync(runDir, { recursive: true })
        mkdirSync(worktreePath, { recursive: true })
        const outcome = await runScriptProcess({
          node,
          inputs: { 'contract-input': run.inputJson },
          runDir,
          worktreePath,
          repos: [{ name: 'fixture', path: worktreePath }],
          taskId: 'execution-contract-fixture',
          nodeId: 'execution-contract-fixture',
          nodeRunId: ulid(),
          iteration: 0,
          retryIndex: 0,
          shardKey: null,
          envelopeNonce: ulid(),
          interpreter,
          depsEnv: null,
          timeoutMs: run.timeoutMs,
        })
        if (outcome.failureCode !== null)
          return {
            kind: 'failed',
            failureCode: outcome.failureCode,
            stderrTail: outcome.result.stderrTail,
          }
        return { kind: 'completed', rawStdout: outcome.result.rawStdout }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  }
}
