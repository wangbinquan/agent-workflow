import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { ulid } from 'ulid'
import { z } from 'zod'

import type { DbClient } from '@/db/client'
import { getAgentById } from '@/services/agent'
import { resolveScriptInterpreter, runScriptProcess } from '@/services/scriptRun'
import { getWorkflow } from '@/services/workflow'
import { sha256Hex } from '@/util/hash'
import type {
  ExecutionContractProgramFixturePort,
  ExecutionContractResourcePort,
} from '../application/ports'
import {
  EXECUTION_CONTRACT_RESULT_PORT,
  EXECUTION_CONTRACT_SCRIPT_INPUT_PORT,
  validateExactContractOutput,
} from '../domain/model'

const declarationsSchema = z
  .array(
    z.object({ contractId: z.string().min(1), version: z.number().int().positive() }).passthrough(),
  )
  .max(200)
const parameterValuesSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
const CONTRACT_PROMPT_INPUT = 'prompt'
const CONTRACT_WORKFLOW_NODE_KINDS = new Set([
  'input',
  'output',
  'agent-single',
  'script',
  'wrapper-loop',
  'wrapper-fanout',
])

export function inspectExecutionContractWorkflowDefinition(
  definition: WorkflowDefinition,
  expectedOutputPort = EXECUTION_CONTRACT_RESULT_PORT,
): {
  readonly ok: boolean
  readonly detail: string
} {
  const violations: string[] = []
  if (
    !definition.inputs.some((input) => input.kind === 'text' && input.key === CONTRACT_PROMPT_INPUT)
  ) {
    violations.push(`missing text input '${CONTRACT_PROMPT_INPUT}'`)
  }
  const requiredExtraInputs = definition.inputs
    .filter((input) => input.key !== CONTRACT_PROMPT_INPUT && input.required !== false)
    .map((input) => input.key)
  if (requiredExtraInputs.length > 0) {
    violations.push(`unsupported required inputs: ${requiredExtraInputs.sort().join(', ')}`)
  }
  const forbiddenKinds = [
    ...new Set(
      definition.nodes
        .filter((node) => !CONTRACT_WORKFLOW_NODE_KINDS.has(node.kind))
        .map((node) => node.kind),
    ),
  ].sort()
  if (forbiddenKinds.length > 0)
    violations.push(`forbidden node kinds: ${forbiddenKinds.join(', ')}`)
  const hasResultOutput =
    definition.outputs?.some((output) => output.name === expectedOutputPort) === true ||
    definition.nodes.some((node) => {
      if (node.kind !== 'output') return false
      const ports = (node as { ports?: unknown }).ports
      return (
        Array.isArray(ports) &&
        ports.some(
          (port) =>
            port !== null &&
            typeof port === 'object' &&
            (port as { name?: unknown }).name === expectedOutputPort,
        )
      )
    })
  if (!hasResultOutput) violations.push(`missing output '${expectedOutputPort}'`)
  return violations.length === 0
    ? { ok: true, detail: `closed contract workflow; ${definition.nodes.length} node(s)` }
    : { ok: false, detail: violations.join('; ') }
}

export function createExecutionContractResourceAdapter(
  db: DbClient,
  implicitAgentDeclarations: (input: {
    readonly frontmatterExtra: Readonly<Record<string, unknown>>
  }) => readonly { readonly contractId: string; readonly version: number }[] = () => [],
): ExecutionContractResourcePort {
  return {
    async inspect({ implementation, expectedOutputPort }) {
      if (implementation.kind === 'agent') {
        const agent = await getAgentById(db, implementation.agentRef.id)
        if (agent === null || agent.updatedAt !== implementation.agentRef.revision) return null
        const available = agent.outputs.includes(expectedOutputPort)
        const declared = declarationsSchema.safeParse(agent.frontmatterExtra.executionContracts)
        const fallbackDeclarations = implicitAgentDeclarations({
          frontmatterExtra: agent.frontmatterExtra,
        })
        return {
          kind: 'agent',
          name: agent.name,
          available,
          detail: available
            ? `${agent.name}; exact ${expectedOutputPort} output port`
            : `${agent.name}; missing required output ${expectedOutputPort}`,
          declaredContractRefs: declared.success ? declared.data : fallbackDeclarations,
        }
      }
      const workflow = await getWorkflow(db, implementation.workflowRef.id)
      if (workflow === null || workflow.version !== implementation.workflowRef.revision) return null
      const closure = inspectExecutionContractWorkflowDefinition(
        workflow.definition,
        expectedOutputPort,
      )
      return {
        kind: 'workflow',
        name: workflow.name,
        available: closure.ok,
        detail: `${workflow.name}; ${closure.detail}`,
        declaredContractRefs: null,
      }
    },
  }
}

function resolveArtifact(appHome: string, artifactRef: string): string | null {
  const root = resolve(appHome)
  const absolute = resolve(root, artifactRef)
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return null
  return absolute
}

export function createExecutionContractProgramFixtureAdapter(input: {
  readonly appHome: string
  readonly scriptInterpreterOverrides?: Partial<Record<'bash' | 'node' | 'python', string>>
}): ExecutionContractProgramFixturePort {
  return {
    async validate({ guide, implementation }) {
      const artifactPath = resolveArtifact(input.appHome, implementation.executableArtifactRef)
      if (artifactPath === null) {
        return [
          {
            code: 'program-artifact-contained',
            ok: false,
            detail: implementation.executableArtifactRef,
          },
        ]
      }
      let source: string
      try {
        source = readFileSync(artifactPath, 'utf8')
      } catch (error) {
        return [
          {
            code: 'program-artifact-readable',
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          },
        ]
      }
      if (sha256Hex(source) !== implementation.executableDigest) {
        return [{ code: 'program-artifact-digest', ok: false, detail: 'artifact digest mismatch' }]
      }
      let parameterValuesJson = '{}'
      if (implementation.parameterValuesRef !== null) {
        const parameterPath = resolveArtifact(input.appHome, implementation.parameterValuesRef)
        if (parameterPath === null) {
          return [
            {
              code: 'program-parameter-artifact-contained',
              ok: false,
              detail: implementation.parameterValuesRef,
            },
          ]
        }
        try {
          parameterValuesJson = JSON.stringify(
            parameterValuesSchema.parse(JSON.parse(readFileSync(parameterPath, 'utf8')) as unknown),
          )
        } catch (error) {
          return [
            {
              code: 'program-parameter-artifact-readable',
              ok: false,
              detail: error instanceof Error ? error.message : String(error),
            },
          ]
        }
      }
      const interpreter = await resolveScriptInterpreter(
        implementation.runtimeKind,
        input.scriptInterpreterOverrides ?? {},
      )
      if (interpreter === null) {
        return [
          {
            code: 'program-interpreter-available',
            ok: false,
            detail: implementation.runtimeKind,
          },
        ]
      }

      const root = mkdtempSync(join(tmpdir(), 'agent-workflow-execution-contract-'))
      const runDir = join(root, 'run')
      const worktreePath = join(root, 'worktree')
      const roundRef = `fixture-${ulid()}`
      const executionNonce = sha256Hex(roundRef)
      const fixtureInput = JSON.parse(guide.input.exampleJson) as Record<string, unknown>
      fixtureInput.roundRef = roundRef
      fixtureInput.executionNonce = executionNonce
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
          inputs: { [EXECUTION_CONTRACT_SCRIPT_INPUT_PORT]: JSON.stringify(fixtureInput) },
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
          return [
            {
              code: 'program-fixture-execution',
              ok: false,
              detail: `${outcome.failureCode}: ${outcome.result.stderrTail.slice(-1_000)}`,
            },
          ]
        }
        try {
          validateExactContractOutput({
            guide,
            roundRef,
            executionNonce,
            outputJson: outcome.result.rawStdout.trim(),
          })
          return [
            {
              code: 'program-fixture-exact-output',
              ok: true,
              detail: `${guide.input.schemaId} -> ${guide.output.schemaId}`,
            },
          ]
        } catch (error) {
          return [
            {
              code: 'program-fixture-exact-output',
              ok: false,
              detail: error instanceof Error ? error.message : String(error),
            },
          ]
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  }
}
