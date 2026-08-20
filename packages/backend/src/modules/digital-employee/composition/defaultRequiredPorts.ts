import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { getAgentById } from '@/services/agent'
import { extractScriptPorts } from '@/services/scriptPorts'
import { resolveScriptInterpreter, runScriptProcess } from '@/services/scriptRun'
import { getWorkflow } from '@/services/workflow'
import type { ToolResourceCatalogPort, WorkContractFixturePort } from './required-ports'

const EMPLOYEE_RESULT_PORT = 'agent-result'
const EMPLOYEE_PROMPT_INPUT = 'prompt'
const EMPLOYEE_WORKFLOW_NODE_KINDS = new Set([
  'input',
  'output',
  'agent-single',
  'script',
  'wrapper-loop',
  'wrapper-fanout',
])

export function inspectDigitalEmployeeWorkflowDefinition(definition: WorkflowDefinition): {
  readonly ok: boolean
  readonly detail: string
} {
  const violations: string[] = []
  if (
    !definition.inputs.some((input) => input.kind === 'text' && input.key === EMPLOYEE_PROMPT_INPUT)
  ) {
    violations.push(`missing text input '${EMPLOYEE_PROMPT_INPUT}'`)
  }
  const requiredExtraInputs = definition.inputs
    .filter((input) => input.key !== EMPLOYEE_PROMPT_INPUT && input.required !== false)
    .map((input) => input.key)
  if (requiredExtraInputs.length > 0) {
    violations.push(`unsupported required inputs: ${requiredExtraInputs.sort().join(', ')}`)
  }
  const forbiddenKinds = [
    ...new Set(
      definition.nodes
        .filter((node) => !EMPLOYEE_WORKFLOW_NODE_KINDS.has(node.kind))
        .map((node) => node.kind),
    ),
  ].sort()
  if (forbiddenKinds.length > 0) {
    violations.push(`forbidden node kinds: ${forbiddenKinds.join(', ')}`)
  }
  const hasResultOutput =
    definition.outputs?.some((output) => output.name === EMPLOYEE_RESULT_PORT) === true ||
    definition.nodes.some((node) => {
      if (node.kind !== 'output') return false
      const ports = (node as { ports?: unknown }).ports
      return (
        Array.isArray(ports) &&
        ports.some(
          (port) =>
            port !== null &&
            typeof port === 'object' &&
            (port as { name?: unknown }).name === EMPLOYEE_RESULT_PORT,
        )
      )
    })
  if (!hasResultOutput) violations.push(`missing output '${EMPLOYEE_RESULT_PORT}'`)
  return violations.length === 0
    ? {
        ok: true,
        detail: `closed employee workflow; ${definition.nodes.length} node(s); exact envelope output`,
      }
    : { ok: false, detail: violations.join('; ') }
}

export function createToolResourceCatalogAdapter(db: DbClient): ToolResourceCatalogPort {
  return {
    async resolveAgent(ref) {
      const agent = await getAgentById(db, ref.id)
      if (agent === null || agent.updatedAt !== ref.revision) return null
      const available = agent.outputs.includes(EMPLOYEE_RESULT_PORT)
      return {
        kind: 'agent',
        ref,
        name: agent.name,
        available,
        closureSummary: available
          ? `${agent.name}; exact ${EMPLOYEE_RESULT_PORT} envelope output`
          : `${agent.name}; missing required output ${EMPLOYEE_RESULT_PORT}`,
      }
    },
    async resolveWorkflow(ref) {
      const workflow = await getWorkflow(db, ref.id)
      if (workflow === null || workflow.version !== ref.revision) return null
      const closure = inspectDigitalEmployeeWorkflowDefinition(workflow.definition)
      return {
        kind: 'workflow',
        ref,
        name: workflow.name,
        available: closure.ok,
        closureSummary: `${workflow.name}; ${closure.detail}`,
      }
    },
  }
}

function resolveProgramArtifact(appHome: string, artifactRef: string): string | null {
  const root = resolve(appHome)
  const absolute = resolve(root, artifactRef)
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return null
  return absolute
}

/**
 * Executes ProgramTool fixtures through the existing Script executor primitive.
 * Agent/Workflow registrations are already exact-resolved above; their full
 * runtime E2E is exercised by the system-mock journey rather than spawning a
 * model during every authoring request.
 */
export function createWorkContractFixtureAdapter(input: {
  readonly appHome: string
  readonly scriptInterpreterOverrides?: Partial<Record<'bash' | 'node' | 'python', string>>
}): WorkContractFixturePort {
  return {
    async validate(request) {
      if (request.implementation.kind !== 'program') {
        return [
          {
            code: 'existing-task-execution-participant',
            ok: true,
            detail: `${request.implementation.kind} exact revision resolves through the existing TaskEngine participant`,
          },
        ]
      }

      const artifactPath = resolveProgramArtifact(
        input.appHome,
        request.implementation.executableArtifactRef,
      )
      if (artifactPath === null) {
        return [
          {
            code: 'program-artifact-contained',
            ok: false,
            detail: request.implementation.executableArtifactRef,
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
      let parameterValuesJson = '{}'
      if (request.implementation.parameterValuesRef !== null) {
        const parameterPath = resolveProgramArtifact(
          input.appHome,
          request.implementation.parameterValuesRef,
        )
        if (parameterPath === null) {
          return [
            {
              code: 'program-parameter-artifact-contained',
              ok: false,
              detail: request.implementation.parameterValuesRef,
            },
          ]
        }
        try {
          const parameters = JSON.parse(readFileSync(parameterPath, 'utf8')) as unknown
          if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
            throw new Error('parameter values must be a JSON object')
          }
          parameterValuesJson = JSON.stringify(parameters)
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
        request.implementation.runtimeKind,
        input.scriptInterpreterOverrides ?? {},
      )
      if (interpreter === null) {
        return [
          {
            code: 'program-interpreter-available',
            ok: false,
            detail: request.implementation.runtimeKind,
          },
        ]
      }

      const root = mkdtempSync(join(tmpdir(), 'agent-workflow-contract-fixture-'))
      const runDir = join(root, 'run')
      const worktreePath = join(root, 'worktree')
      const nonce = ulid()
      const node = {
        id: 'contract-fixture',
        kind: 'script',
        language: request.implementation.runtimeKind,
        script: source,
        outputs: [{ name: 'result', kind: 'string' }],
        env: { DIGITAL_EMPLOYEE_TOOL_PARAMETERS_JSON: parameterValuesJson },
      } as WorkflowNode
      try {
        mkdirSync(runDir, { recursive: true })
        mkdirSync(worktreePath, { recursive: true })
        const outcome = await runScriptProcess({
          node,
          inputs: {
            contract_input: JSON.stringify({
              schemaVersion: 1,
              fixture: true,
              inputSchemaId: request.inputSchemaId,
              expectedOutputSchemaId: request.outputSchemaId,
            }),
          },
          runDir,
          worktreePath,
          repos: [{ name: 'fixture', path: worktreePath }],
          taskId: 'contract-fixture',
          nodeId: 'contract-fixture',
          nodeRunId: ulid(),
          iteration: 0,
          retryIndex: 0,
          shardKey: null,
          envelopeNonce: nonce,
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
        const ports = extractScriptPorts({ node, rawStdout: outcome.result.rawStdout, nonce })
        if (ports.kind === 'failed') {
          return [{ code: 'program-fixture-envelope', ok: false, detail: ports.detail }]
        }
        let decoded: unknown
        try {
          decoded = JSON.parse(ports.ports.result ?? '') as unknown
        } catch {
          return [
            {
              code: 'program-fixture-output-json',
              ok: false,
              detail: 'the result port must contain a JSON object',
            },
          ]
        }
        const record = decoded as Record<string, unknown> | null
        const ok =
          record !== null &&
          typeof record === 'object' &&
          !Array.isArray(record) &&
          record.schemaVersion === 1 &&
          (record.ok === true || record.status === 'ok')
        return [
          {
            code: 'program-fixture-output-envelope',
            ok,
            detail: ok
              ? `${request.inputSchemaId} -> ${request.outputSchemaId}`
              : 'result JSON must contain schemaVersion=1 and ok=true or status="ok"',
          },
        ]
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  }
}
