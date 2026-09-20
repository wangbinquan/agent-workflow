import type { WorkflowNode } from '@agent-workflow/shared'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { ulid } from 'ulid'
import { z } from 'zod'
import { resolveScriptInterpreter, runScriptProcess } from '@/services/scriptRun'
import { sha256Hex } from '@/util/hash'
import type { ScriptFixtureRunner } from '../../application/ports/scriptFixture'
const parameterValuesSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
function resolveArtifact(appHome: string, artifactRef: string): string | null {
  const root = resolve(appHome)
  const absolute = resolve(root, artifactRef)
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return null
  return absolute
}

export function createScriptFixtureRunner(input: {
  readonly appHome: string
  readonly scriptInterpreterOverrides?: Partial<Record<'bash' | 'node' | 'python', string>>
}): ScriptFixtureRunner {
  return {
    async run({ implementation, inputJson }) {
      const artifactPath = resolveArtifact(input.appHome, implementation.executableArtifactRef)
      if (artifactPath === null) {
        return {
          kind: 'failed',
          checks: [
            {
              code: 'program-artifact-contained',
              ok: false,
              detail: implementation.executableArtifactRef,
            },
          ],
        }
      }
      let source: string
      try {
        source = readFileSync(artifactPath, 'utf8')
      } catch (error) {
        return {
          kind: 'failed',
          checks: [
            {
              code: 'program-artifact-readable',
              ok: false,
              detail: error instanceof Error ? error.message : String(error),
            },
          ],
        }
      }
      if (sha256Hex(source) !== implementation.executableDigest) {
        return {
          kind: 'failed',
          checks: [
            { code: 'program-artifact-digest', ok: false, detail: 'artifact digest mismatch' },
          ],
        }
      }
      let parameterValuesJson = '{}'
      if (implementation.parameterValuesRef !== null) {
        const parameterPath = resolveArtifact(input.appHome, implementation.parameterValuesRef)
        if (parameterPath === null) {
          return {
            kind: 'failed',
            checks: [
              {
                code: 'program-parameter-artifact-contained',
                ok: false,
                detail: implementation.parameterValuesRef,
              },
            ],
          }
        }
        try {
          parameterValuesJson = JSON.stringify(
            parameterValuesSchema.parse(JSON.parse(readFileSync(parameterPath, 'utf8')) as unknown),
          )
        } catch (error) {
          return {
            kind: 'failed',
            checks: [
              {
                code: 'program-parameter-artifact-readable',
                ok: false,
                detail: error instanceof Error ? error.message : String(error),
              },
            ],
          }
        }
      }
      const interpreter = await resolveScriptInterpreter(
        implementation.runtimeKind,
        input.scriptInterpreterOverrides ?? {},
      )
      if (interpreter === null) {
        return {
          kind: 'failed',
          checks: [
            {
              code: 'program-interpreter-available',
              ok: false,
              detail: implementation.runtimeKind,
            },
          ],
        }
      }

      const root = mkdtempSync(join(tmpdir(), 'agent-workflow-execution-contract-'))
      const runDir = join(root, 'run')
      const worktreePath = join(root, 'worktree')
      const node = {
        id: 'execution-contract-fixture',
        kind: 'script',
        language: implementation.runtimeKind,
        script: source,
        env: {
          DIGITAL_EMPLOYEE_TOOL_PARAMETERS_JSON: parameterValuesJson,
        },
      } as WorkflowNode
      try {
        mkdirSync(runDir, { recursive: true })
        mkdirSync(worktreePath, { recursive: true })
        const outcome = await runScriptProcess({
          node,
          inputs: { 'contract-input': inputJson },
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
          timeoutMs: 30_000,
        })
        if (outcome.failureCode !== null) {
          return {
            kind: 'failed',
            checks: [
              {
                code: 'program-fixture-execution',
                ok: false,
                detail: `${outcome.failureCode}: ${outcome.result.stderrTail.slice(-1_000)}`,
              },
            ],
          }
        }
        return { kind: 'completed', rawStdout: outcome.result.rawStdout }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  }
}
