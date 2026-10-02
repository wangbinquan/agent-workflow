// RFC-370 A2: selected ProgramArtifactPort reads may be remote. The actual
// authoring query must wait and preserve its source, missing and failure results.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeEachProvider } from './helpers/eachProvider'
import { composeDigitalEmployee } from '@/modules/digital-employee/composition'
import type { ProgramArtifactPort } from '@/modules/digital-employee/composition/required-ports'
import { developmentEmployeeTypePackage } from '@/modules/development-automation/composition/employeeTypePackage'
import type { ExecutionContractParticipant } from '@/modules/execution-contract/public/types'
import { createDigitalEmployeeAuthoringPersistence } from '@/modules/digital-employee/infrastructure/authoringStore'
import { sha256Hex } from '@/util/hash'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const executionContracts: ExecutionContractParticipant = {
  list: () => [],
  get: () => {
    throw new Error('the editor does not execute a tool')
  },
  async validateExecutor({ contractRef }) {
    return {
      schemaVersion: 1,
      contractRef,
      status: 'valid',
      checks: [{ code: 'selected-program-editor', ok: true, detail: 'test contract' }],
    }
  },
  async validateAgentCandidates() {
    return []
  },
  validateEnvelope() {
    throw new Error('the editor does not settle a reaction')
  },
}

describeEachProvider('RFC-370 selected employee program content', (harness) => {
  for (const result of ['content', 'missing', 'failure'] as const) {
    test(`awaits the selected ${result} result before completing the actual editor query`, async () => {
      const appHome = mkdtempSync(join(tmpdir(), 'rfc370-program-content-'))
      roots.push(appHome)
      const source = 'print("selected content")\n'
      const parameters = { mode: 'selected', retries: 0, enabled: false }
      const failure = new Error('selected program content unavailable')
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let ordinal = 0
      const artifacts: ProgramArtifactPort = {
        async put(input) {
          expect(this).toBe(artifacts)
          expect(input.source).toBe(source)
          expect(input.parameterValues).toEqual(parameters)
          return {
            executableArtifactRef: 'object:employee-program/source',
            executableDigest: sha256Hex(input.source),
            parameterValuesRef: 'object:employee-program/parameters',
          }
        },
        async read(input) {
          expect(this).toBe(artifacts)
          expect(input.executableArtifactRef).toBe('object:employee-program/source')
          expect(input.executableDigest).toBe(sha256Hex(source))
          expect(input.parameterValuesRef).toBe('object:employee-program/parameters')
          entered.resolve()
          await release.promise
          if (result === 'failure') throw failure
          return result === 'missing' ? null : { source, parameterValues: parameters }
        },
      }
      const module = composeDigitalEmployee({
        db: harness.db,
        appHome,
        typePackages: [developmentEmployeeTypePackage],
        programArtifacts: artifacts,
        executionContracts,
        connectionCatalog: { resolve: async () => null },
        id: () => `selected-program-${++ordinal}`,
      })
      const typeRef = { typeId: 'development', revision: 10 }
      const created = await module.commands.createTool({
        typeRef,
        workItemRef: 'prepare-materials',
        actorUserId: 'program-author',
        body: {
          displayName: 'Selected program',
          description: 'Durable selected content',
          roleRef: 'primary',
          implementation: {
            kind: 'program',
            runtimeKind: 'python',
            source,
            parameterValues: parameters,
            runtimeProfileRef: { id: 'builtin:script-runtime', revision: 1 },
          },
        },
      })
      const store = createDigitalEmployeeAuthoringPersistence(harness.db)
      const before = await store.getTool(created.id)
      let settled = false
      const reading = module.queries
        .getToolAuthoring({ typeRef, workItemRef: 'prepare-materials', toolId: created.id })
        .then(
          (value) => {
            settled = true
            return { ok: true as const, value }
          },
          (error: unknown) => {
            settled = true
            return { ok: false as const, error }
          },
        )
      try {
        await entered.promise
        expect(settled).toBe(false)
        expect(await store.getTool(created.id)).toEqual(before)
      } finally {
        release.resolve()
      }
      const actual = await reading
      if (result === 'content') {
        expect(actual.ok).toBe(true)
        if (!actual.ok) throw actual.error
        expect(actual.value.body.implementation).toMatchObject({
          kind: 'program',
          runtimeKind: 'python',
          source,
          parameterValues: parameters,
        })
      } else {
        expect(actual.ok).toBe(false)
        if (actual.ok) throw new Error('expected selected read failure')
        if (result === 'failure') expect(actual.error).toBe(failure)
        else expect(actual.error).toMatchObject({ code: 'employee-program-artifact-unavailable' })
      }
      expect(await store.getTool(created.id)).toEqual(before)
    })
  }
})
