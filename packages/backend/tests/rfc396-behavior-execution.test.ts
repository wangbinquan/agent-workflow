// The adapters run candidate programs; expected model outcomes are computed in the application.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import { createLocalVerificationCommandEffectsFactory } from '@/modules/development-automation/infrastructure/local/verificationCommandEffects'
import { createCrewStationVerificationCommandEffectsFactory } from '@/modules/development-automation/composition/crewstationVerification'
import { executeTaskImageVerification } from '@/modules/development-automation/composition/taskImageVerification'
import { verifyGraphBehavior } from '@/modules/development-automation/application/graph-development/behaviorVerification'
import { EvidenceStore } from '@/modules/development-automation/infrastructure/evidenceStore'
import type { GraphBehaviorCheck, GraphDesignDocument } from '@agent-workflow/shared'
import { bookingDesign } from './helpers/graphDesign'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function stateDesign() {
  const document = bookingDesign()
  document.elements = ['idle', 'reserved'].map((id) => ({
    id,
    kind: 'behavior' as const,
    role: 'state' as const,
    revision: 1,
    label: id,
    description: '',
    sourceIds: [],
  }))
  document.relations = [
    {
      id: 'reserve',
      revision: 1,
      from: 'idle',
      to: 'reserved',
      kind: 'transition',
      label: 'reserve',
      sourceIds: [],
    },
  ]
  document.models = [
    {
      id: 'machine',
      revision: 1,
      kind: 'state',
      label: 'reservation',
      sourceIds: [],
      initialStateId: 'idle',
      stateIds: ['idle', 'reserved'],
      terminalStateIds: ['reserved'],
      transitions: [
        {
          relationId: 'reserve',
          event: 'reserve',
          guards: [],
          actionRef: 'reserve',
          assertionRefs: ['unique'],
        },
      ],
    },
  ]
  document.concerns = []
  document.views = []
  document.obligations = []
  return document
}
const check: GraphBehaviorCheck = {
  modelId: 'machine',
  programRef: 'repo:adapter.js',
  inputs: [{}],
  depth: 2,
  paths: 8,
  timeoutMs: 5000,
}

for (const deployment of ['standalone', 'hosted'] as const) {
  test.skipIf(process.platform === 'win32')(
    `${deployment}: actual candidate behavior, disagreement and environment changes are observable`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'rfc396-behavior-'))
      roots.push(root)
      const ws = join(root, 'ws')
      mkdirSync(ws)
      const script = join(ws, 'adapter.js')
      writeFileSync(
        script,
        '#!/usr/bin/env bun\nconst request = await Bun.stdin.json(); let state="idle"; const states=[state]; for (const action of request.actions) { if(action.actionRef === "reserve" && state === "idle") state="reserved"; states.push(state); } console.log(JSON.stringify({ states, assertions: {unique: true} }));\n',
      )
      chmodSync(script, 0o755)
      const helper: WorkspaceHelper = {
        async call<T>(_task: string, operation: string, value: unknown) {
          expect(operation).toBe('verification-command')
          return (await executeTaskImageVerification(value, undefined, root)) as T
        },
      }
      const retained = new Set<string>()
      const factory =
        deployment === 'standalone'
          ? createLocalVerificationCommandEffectsFactory()
          : createCrewStationVerificationCommandEffectsFactory({
              helper,
              locate: (path) => ({ taskId: 'case', path }),
              reference: (_task, path) => path,
              retainWorkspace: (path, keep) => {
                if (keep) retained.add(path)
                else retained.delete(path)
              },
            })
      const effects = factory.create({ evidence: new EvidenceStore(root) })
      const result = await verifyGraphBehavior({
        document: stateDesign(),
        check,
        workspaceRef: ws,
        effects,
      })
      expect(result.result).toBe('passed')
      expect(result.cases).toHaveLength(1)
      expect(result.cases[0]!.run.exitCode).toBe(0)
      const before = await factory.environment!(ws)
      writeFileSync(join(ws, 'bun.lock'), '{"dependency": "changed"}')
      expect((await factory.environment!(ws)).digest).not.toBe(before.digest)
      writeFileSync(
        script,
        '#!/usr/bin/env bun\nawait Bun.stdin.text(); console.log(JSON.stringify({ states:["idle","idle"], assertions:{unique:true} }));\n',
      )
      expect(
        (await verifyGraphBehavior({ document: stateDesign(), check, workspaceRef: ws, effects }))
          .result,
      ).toBe('failed')
      const rules: GraphDesignDocument = {
        ...stateDesign(),
        models: [
          {
            id: 'machine',
            kind: 'decision-table',
            revision: 1,
            label: 'priority',
            sourceIds: [],
            inputFields: ['vip'],
            resolution: 'unique',
            rows: [
              {
                id: 'normal',
                ruleId: 'normal',
                priority: 1,
                conditions: [{ field: 'vip', operator: 'eq', value: false }],
                output: { priority: 'normal' },
                assertionRefs: ['priority'],
              },
              {
                id: 'vip',
                ruleId: 'vip',
                priority: 2,
                conditions: [{ field: 'vip', operator: 'eq', value: true }],
                output: { priority: 'high' },
                assertionRefs: ['priority'],
              },
            ],
          },
        ],
      }
      writeFileSync(
        script,
        '#!/usr/bin/env bun\nconst {input} = await Bun.stdin.json(); console.log(JSON.stringify({ outputs:[{priority:input.vip ? "high" : "normal"}], assertions:{priority:true} }));\n',
      )
      expect(
        (
          await verifyGraphBehavior({
            document: rules,
            check: { ...check, inputs: [{ vip: false }, { vip: true }] },
            workspaceRef: ws,
            effects,
          })
        ).result,
      ).toBe('passed')
      expect(retained.size).toBe(0)
    },
    30_000,
  )
}

test('finite path budgets, missing action bindings, rule conflicts and incomplete observations cannot pass', async () => {
  const factory = createLocalVerificationCommandEffectsFactory(),
    effects = factory.create({ evidence: {} as EvidenceStore })
  effects.invokeBehavior = async () => ({
    exitCode: 0,
    timedOut: false,
    outputJson: JSON.stringify({ states: ['idle', 'reserved'], assertions: { unique: true } }),
    error: '',
  })
  expect(
    (
      await verifyGraphBehavior({
        document: stateDesign(),
        check: { ...check, paths: 1 },
        workspaceRef: 'fixture',
        effects,
      })
    ).result,
  ).toBe('inconclusive')
  const missing = stateDesign()
  const model = missing.models[0]!
  if (model.kind === 'state') model.transitions[0]!.actionRef = null
  expect(
    (await verifyGraphBehavior({ document: missing, check, workspaceRef: 'fixture', effects }))
      .result,
  ).toBe('inconclusive')
  effects.invokeBehavior = async () => ({
    exitCode: 0,
    timedOut: false,
    outputJson: JSON.stringify({ assertions: { unique: true } }),
    error: '',
  })
  expect(
    (
      await verifyGraphBehavior({
        document: stateDesign(),
        check,
        workspaceRef: 'fixture',
        effects,
      })
    ).result,
  ).toBe('failed')
  const table: GraphDesignDocument = {
    ...stateDesign(),
    models: [
      {
        id: 'machine',
        kind: 'decision-table',
        revision: 1,
        label: 'priority',
        sourceIds: [],
        inputFields: ['vip'],
        resolution: 'unique',
        rows: [
          {
            id: 'one',
            ruleId: 'r1',
            priority: 1,
            conditions: [],
            output: { priority: 'normal' },
            assertionRefs: ['unique'],
          },
          {
            id: 'two',
            ruleId: 'r2',
            priority: 2,
            conditions: [],
            output: { priority: 'high' },
            assertionRefs: ['unique'],
          },
        ],
      },
    ],
  }
  expect(
    (await verifyGraphBehavior({ document: table, check, workspaceRef: 'fixture', effects }))
      .result,
  ).toBe('inconclusive')
})
