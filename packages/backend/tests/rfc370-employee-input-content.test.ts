// RFC-370: async selected object presence must settle before Case admission.
// Actual authoring/runtime/codec and provider persistence are used; no worker is started.
import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeEachProvider } from './helpers/eachProvider'
import { legacyShapedReactionExecution } from './helpers/legacyShapedReactionExecution'
import { employeeCases, employeeInputUploads, users } from '@/db/schema'
import { composeDigitalEmployee } from '@/modules/digital-employee/composition'
import type { EmployeeInputArtifactPort } from '@/modules/digital-employee/composition/required-ports'
import {
  developmentEmployeeRuntimeCodec,
  developmentEmployeeTypePackage,
  developmentExecutionContractRegistrations,
} from '@/modules/development-automation/composition/employeeTypePackage'
import { digitalEmployeeLifecycleEventCatalogJson } from '@/modules/digital-employee/public/events'
import { composeEventCenter } from '@/modules/event-center/composition'
import { ExecutionContractService } from '@/modules/execution-contract/application/executionContractService'

const roots: string[] = []
setDefaultTimeout(30_000)
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describeEachProvider('RFC-370 selected employee input presence', (harness) => {
  for (const result of ['present', 'missing', 'failure'] as const) {
    test(`awaits ${result} before admitting a real Case and stops in input order`, async () => {
      const appHome = mkdtempSync(join(tmpdir(), 'rfc370-employee-input-'))
      roots.push(appHome)
      const db = harness.db
      let ordinal = 0
      const id = () => `selected-input-${++ordinal}`
      const now = () => 20_000
      await db.insert(users).values({
        id: 'input-author',
        username: 'input-author',
        displayName: 'Input Author',
        passwordHash: 'fixture',
        createdAt: now(),
        updatedAt: now(),
      })
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const calls: string[] = []
      const blobs = ['a'.repeat(64), 'b'.repeat(64)]
      const failure = new Error('selected input content unavailable')
      const inputArtifacts: EmployeeInputArtifactPort = {
        async putFile(source) {
          expect(this).toBe(inputArtifacts)
          const blobRef = source.endsWith('one') ? blobs[0]! : blobs[1]!
          return { blobRef, sha256: blobRef, bytes: 10 }
        },
        async hasBlob(blobRef) {
          expect(this).toBe(inputArtifacts)
          calls.push(blobRef)
          if (calls.length === 1) {
            entered.resolve()
            await release.promise
            if (result === 'failure') throw failure
            if (result === 'missing') return false
          }
          return true
        },
        copyBlobTo() {
          throw new Error('Case admission does not materialize a workspace')
        },
      }
      const eventCenter = await composeEventCenter({
        db,
        typePackageDescriptorJsons: [
          developmentEmployeeTypePackage.descriptorJson,
          digitalEmployeeLifecycleEventCatalogJson,
        ],
        automation: { kind: 'observation-only' },
        now,
        id,
      })
      const executionContracts = new ExecutionContractService({
        registrations: developmentExecutionContractRegistrations,
        resources: {
          async inspect({ implementation }) {
            return {
              kind: implementation.kind,
              name:
                implementation.kind === 'agent'
                  ? implementation.agentRef.id
                  : implementation.workflowRef.id,
              available: true,
              detail: 'input admission does not launch the Agent',
              declaredContractRefs:
                implementation.kind === 'agent'
                  ? developmentExecutionContractRegistrations.map((entry) => entry.contractRef)
                  : null,
            }
          },
        },
        programFixtures: {
          async run() {
            throw new Error('input admission does not run a program')
          },
        },
      })
      const module = composeDigitalEmployee({
        db,
        appHome,
        typePackages: [developmentEmployeeTypePackage],
        inputArtifacts,
        executionContracts,
        now,
        id,
        runtime: {
          eventCenter: eventCenter.participant,
          codecs: [developmentEmployeeRuntimeCodec],
          platformWorkItems: {
            async execute() {
              throw new Error('input admission does not execute platform work')
            },
          },
          reactionExecution: legacyShapedReactionExecution({
            async launch() {
              throw new Error('input admission does not dispatch business work')
            },
            async inspect() {
              return { kind: 'pending', executionRef: 'unused' }
            },
            async cancel() {},
          }),
        },
      })
      const typeRef = { typeId: 'development', revision: 10 }
      const tool = await module.commands.createTool({
        typeRef,
        workItemRef: 'analyze-implement',
        actorUserId: 'input-author',
        body: {
          displayName: 'Input reader',
          description: 'No execution during admission',
          roleRef: 'primary',
          implementation: {
            kind: 'agent',
            agentRef: { id: 'input-agent', revision: 1 },
          },
        },
      })
      const toolRef = await module.commands.publishTool({
        typeRef,
        workItemRef: 'analyze-implement',
        toolId: tool.id,
        actorUserId: 'input-author',
      })
      const job = await module.commands.createJobTemplate({
        typeRef,
        actorUserId: 'input-author',
        body: {
          name: 'Selected input job',
          description: 'Body input',
          defaultToolBindings: [
            {
              workItemRef: 'analyze-implement',
              slotRef: 'default',
              registrationRef: toolRef,
            },
          ],
        },
      })
      const jobRef = await module.commands.publishJobTemplate({
        id: job.id,
        actorUserId: 'input-author',
      })
      const employee = await module.commands.createEmployee({
        typeRef,
        actorUserId: 'input-author',
        body: {
          name: 'Selected input employee',
          jobTemplateRef: jobRef,
          workScope: { kind: 'repository', repositoryId: 'input-repository' },
        },
      })
      const uploads = []
      for (const [index, source] of ['one', 'two'].entries()) {
        const upload = await module.inputUploads.create({
          absolutePath: `/selected-object/${source}`,
          originalName: `${source}.txt`,
          actorUserId: 'input-author',
          idempotencyKey: `input-${index}`,
        })
        uploads.push({
          uploadRef: upload.id,
          placement: 'repository' as const,
          targetPath: `inputs/${source}.txt`,
        })
      }
      let settled = false
      const pending = module
        .runtime!.commands.launchWork({
          employeeId: employee.id,
          actorUserId: 'input-author',
          intake: {
            name: 'Await selected inputs',
            kind: 'body-and-files',
            target: { repositoryId: 'input-repository' },
            body: 'Read two selected immutable objects',
            externalId: null,
            uploads,
            idempotencyKey: 'selected-input-case',
          },
        })
        .then(
          (value) => {
            settled = true
            return { kind: 'ok' as const, value }
          },
          (error: unknown) => {
            settled = true
            return { kind: 'error' as const, error }
          },
        )
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error('Case admission settled before input presence')
          }),
        ])
        expect(settled).toBe(false)
        expect(calls).toEqual([blobs[0]!])
        expect(await db.select().from(employeeCases)).toHaveLength(0)
        expect((await db.select().from(employeeInputUploads)).map((row) => row.state)).toEqual([
          'pending',
          'pending',
        ])
        release.resolve()
        const outcome = await pending
        if (result === 'present') {
          expect(outcome.kind).toBe('ok')
          expect(calls).toEqual(blobs)
          expect(await db.select().from(employeeCases)).toHaveLength(1)
          expect((await db.select().from(employeeInputUploads)).map((row) => row.state)).toEqual([
            'claimed',
            'claimed',
          ])
        } else {
          expect(outcome.kind).toBe('error')
          if (outcome.kind !== 'error') throw new Error('Expected input admission failure')
          if (result === 'failure') expect(outcome.error).toBe(failure)
          else
            expect(outcome.error).toMatchObject({
              code: 'employee-upload-artifact-missing',
            })
          expect(calls).toEqual([blobs[0]!])
          expect(await db.select().from(employeeCases)).toHaveLength(0)
          expect((await db.select().from(employeeInputUploads)).map((row) => row.state)).toEqual([
            'pending',
            'pending',
          ])
        }
      } finally {
        release.resolve()
        await pending
      }
    })
  }
})
