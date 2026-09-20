// RFC-365 T1 only: characterize current inputs before freezing a replacement codec.
// The private renderer is compiled from production source; no parallel renderer or new port.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import {
  AgentInputPortsSchema,
  StartTaskSchema,
  TriggerContextSchema,
  renderTemplate,
  type TriggerContext,
} from '@agent-workflow/shared'
import {
  eventResponseTargetSchema,
  type EventResponseTarget,
} from '@/modules/event-center/domain/responseRule'
import { employeeWorkIntakeSchema } from '@/modules/digital-employee/domain/runtimeModel'
import { validateAgentLaunchShape } from '@/services/agentLaunch'
import { assertWorkflowLaunchInputs } from '@/services/workflowLaunchInputs'
import type { RenderedLaunch } from '@/services/webhook/webhookDispatch'

const filename = resolve(import.meta.dir, '../src/services/webhook/webhookDispatch.ts')
const source = ts.createSourceFile(
  filename,
  readFileSync(filename, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
)
const renderers = source.statements.filter(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'renderEventResponseTarget',
)
if (renderers.length !== 1)
  throw new Error('expected the single production event response renderer')
const compiled = ts.transpileModule(renderers[0]!.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText
const render = runInNewContext(`${compiled}\nrenderEventResponseTarget`, { renderTemplate }) as (
  target: EventResponseTarget,
  context: TriggerContext,
) => RenderedLaunch
const context = (value = 'event text') =>
  TriggerContextSchema.parse({
    trigger: { test: { text: value } },
    contract: {
      namespace: 'test',
      definitionRef: { id: 'test.event', revision: 1 },
      availableFields: ['text'],
    },
  })
function rendered(target: unknown, value?: string) {
  return render(eventResponseTargetSchema.parse(target), context(value))
}
function intake(target: unknown, value?: string) {
  const result = rendered(target, value)
  if (result.kind !== 'digital-employee') throw new Error('wrong fixture kind')
  return employeeWorkIntakeSchema.safeParse({
    ...result.intake,
    idempotencyKey: 'event-delivery:fixture',
  })
}

describe('RFC-365 current automation compatibility', () => {
  test('the four actual renderer arms retain defaults and omitted fields', () => {
    expect(
      rendered({
        kind: 'workflow',
        refId: 'w',
        nameTemplate: ' {{trigger.test.text}} ',
        inputs: {},
      }),
    ).toEqual({
      kind: 'workflow',
      refId: 'w',
      payload: { workflowId: 'w', name: ' event text ', scratch: true, inputs: {} },
    })
    const agent = rendered({
      kind: 'agent',
      refId: 'a',
      nameTemplate: 'n',
      descriptionTemplate: null,
      inputs: {},
    })
    expect(agent).toEqual({
      kind: 'agent',
      refId: 'a',
      payload: { agentId: 'a', name: 'n', scratch: true, allowClarify: true },
    })
    expect(
      rendered({
        kind: 'workgroup',
        refId: 'g',
        nameTemplate: 'n',
        goalTemplate: '{{trigger.test.text}}',
      }),
    ).toEqual({
      kind: 'workgroup',
      refId: 'g',
      payload: { workgroupId: 'g', name: 'n', goal: 'event text', scratch: true },
    })
    const employee = rendered({
      kind: 'digital-employee',
      refId: 'e',
      intakeKind: 'external-id',
      target: { repositoryId: 'repo' },
      valueTemplate: ' external ',
    })
    expect(employee).toEqual({
      kind: 'digital-employee',
      refId: 'e',
      intake: {
        kind: 'external-id',
        target: { repositoryId: 'repo' },
        body: null,
        externalId: ' external ',
        uploads: [],
      },
    })
  })

  test('257 declared workflow and agent inputs are accepted today', () => {
    const inputs = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`field${i}`, 'value']))
    const workflow = rendered({ kind: 'workflow', refId: 'w', nameTemplate: 'n', inputs })
    if (workflow.kind !== 'workflow') throw new Error('wrong fixture kind')
    const task = StartTaskSchema.parse(workflow.payload)
    const definitions = Object.keys(inputs).map((key) => ({
      kind: 'text' as const,
      key,
      label: key,
      required: true,
    }))
    expect(() => assertWorkflowLaunchInputs(definitions, task.inputs)).not.toThrow()
    const agent = rendered({
      kind: 'agent',
      refId: 'a',
      nameTemplate: 'n',
      descriptionTemplate: null,
      inputs,
    })
    if (agent.kind !== 'agent') throw new Error('wrong fixture kind')
    const ports = AgentInputPortsSchema.parse(
      Object.keys(inputs).map((name) => ({ name, kind: 'string', required: true })),
    )
    expect(() => validateAgentLaunchShape(ports, agent.payload, { multipart: false })).not.toThrow()
    expect(Object.keys(task.inputs)).toHaveLength(257)
  })

  test('a short template can yield more than 64 KiB after expansion', () => {
    const result = rendered(
      {
        kind: 'workflow',
        refId: 'w',
        nameTemplate: 'n',
        inputs: { body: '{{trigger.test.text}}{{trigger.test.text}}' },
      },
      'x'.repeat(65536),
    )
    if (result.kind !== 'workflow') throw new Error('wrong fixture kind')
    const task = StartTaskSchema.parse(result.payload)
    expect(task.inputs.body).toHaveLength(131072)
    expect(() =>
      assertWorkflowLaunchInputs([{ kind: 'text', key: 'body', label: 'Body' }], task.inputs),
    ).not.toThrow()
  })

  test('text budgets count UTF-16 units; changing them to UTF-8 rejects existing Chinese input', () => {
    const text = '中'.repeat(65536)
    const target = { kind: 'workflow', refId: 'w', nameTemplate: 'n', inputs: { body: text } }
    const result = rendered(target)
    if (result.kind !== 'workflow') throw new Error('wrong fixture kind')
    expect(StartTaskSchema.safeParse(result.payload).success).toBe(true)
    expect(text.length).toBe(65536)
    expect(Buffer.byteLength(text)).toBe(196608)
    expect(
      eventResponseTargetSchema.safeParse({ ...target, inputs: { body: `${text}中` } }).success,
    ).toBe(false)
  })

  test('name trim is downstream, and code-point counts would expand the old UTF-16 limit', () => {
    const result = rendered({
      kind: 'workflow',
      refId: 'w',
      nameTemplate: ' {{trigger.test.text}} ',
      inputs: {},
    })
    if (result.kind !== 'workflow') throw new Error('wrong fixture kind')
    expect(StartTaskSchema.parse(result.payload).name).toBe('event text')
    const tooLong = rendered(
      { kind: 'workflow', refId: 'w', nameTemplate: '{{trigger.test.text}}', inputs: {} },
      '😀'.repeat(128),
    )
    if (tooLong.kind !== 'workflow') throw new Error('wrong fixture kind')
    expect([...tooLong.payload.name]).toHaveLength(128)
    expect(StartTaskSchema.safeParse(tooLong.payload).success).toBe(false)
  })

  test('employee target and external-id limits are downstream; camelCase and surrounding spaces survive', () => {
    const target = {
      kind: 'digital-employee',
      refId: 'e',
      intakeKind: 'external-id',
      target: { repositoryId: '中'.repeat(1000) },
      valueTemplate: ' external ',
    }
    const accepted = intake(target)
    expect(accepted.success).toBe(true)
    if (accepted.success) {
      expect(accepted.data.externalId).toBe(' external ')
      expect(accepted.data.target.repositoryId).toBe('中'.repeat(1000))
      expect(accepted.data.executionOptions).toEqual({})
      expect(accepted.data.advanced).toEqual({ collaboratorUserIds: [], typeOptions: {} })
    }
    expect(
      eventResponseTargetSchema.safeParse({ ...target, valueTemplate: 'x'.repeat(501) }).success,
    ).toBe(true)
    expect(intake({ ...target, valueTemplate: 'x'.repeat(501) }).success).toBe(false)
    expect(intake({ ...target, target: { repositoryId: 'x'.repeat(1001) } }).success).toBe(false)
    expect(intake({ ...target, target: { repositoryId: '' } }).success).toBe(false)
  })

  test('employee body is two Mi UTF-16 units, not two MiB of UTF-8', () => {
    const body = '中'.repeat(2 * 1024 * 1024)
    const target = {
      kind: 'digital-employee',
      refId: 'e',
      intakeKind: 'body',
      target: {},
      valueTemplate: body,
    }
    expect(intake(target).success).toBe(true)
    expect(Buffer.byteLength(body)).toBe(6 * 1024 * 1024)
    expect(
      eventResponseTargetSchema.safeParse({ ...target, valueTemplate: `${body}中` }).success,
    ).toBe(false)
    expect(
      intake({ ...target, valueTemplate: '{{trigger.test.text}}'.repeat(33) }, 'x'.repeat(65536))
        .success,
    ).toBe(false)
  })
})
