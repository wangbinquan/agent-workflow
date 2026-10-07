import { expect, test, setDefaultTimeout } from 'bun:test'
import { rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DevelopmentAdapterContent } from '@/modules/integration/domain/developmentAdapterDefinition'
import type {
  AdapterConfigurationReference,
  AdapterProgramFactory,
  AdapterProgramReference,
} from '@/modules/integration/public/participants'
import { createDevelopmentAdapterStore } from '@/modules/integration/infrastructure/developmentAdapterStore'
import {
  createDevelopmentAdapter,
  publishDevelopmentAdapter,
  reviseDevelopmentAdapterDraft,
} from '@/modules/integration/application/developmentAdapterCommands'
import { composeSelectedRequirementSourceRunnerFor } from '@/modules/integration/composition/requirementSource'
import { composeSelectedPipelineEvidenceRunnerFor } from '@/modules/integration/composition/pipelineEvidence'
import { composeSelectedApprovalGatewayRunnerFor } from '@/modules/integration/composition/approvalGateway'
import { composeDevelopmentPurposeRoot } from '@/server'
import { composeSelectedDevelopmentPipelineEvidence } from '@/modules/development-automation/composition/pipelineEvidence'
import { createSelectedPipelineImportAdapter } from '@/modules/development-automation/application/pipelineEvidenceImport'
import { describeEachProvider } from './helpers/eachProvider'
import { buildPr3Fixture } from './helpers/rfc310Pr3Fixture'
import { held, MemoryPurposeContent, PurposeEffects } from './helpers/developmentPurpose'

const head = 'a'.repeat(40),
  target = 'b'.repeat(40),
  budget = { maxFiles: 64, maxFileBytes: 8192, maxTotalBytes: 32768 }
const definition = (
  purpose: DevelopmentAdapterContent['purpose'],
  operations: DevelopmentAdapterContent['operations'],
  executableRef = 'object:program:v1',
): DevelopmentAdapterContent => ({
  schemaVersion: 1,
  purpose,
  operations,
  contractVersion: 1,
  executableRef,
  parameterSchemaRef: null,
  connectionRef: null,
  secretProjection: [],
  outputBudget: budget,
  timeoutMs: 1000,
})

setDefaultTimeout(60_000)

describeEachProvider('RFC-370 published purpose programs and coherent staging', (harness) => {
  test('all nine selected operations resolve published content; manifest ACK, cleanup and reconstructed approval stay on the same receivers', async () => {
    const fx = await buildPr3Fixture({ db: harness.db })
    const content = new MemoryPurposeContent()
    const configs = new WeakMap<object, DevelopmentAdapterContent>(),
      programsByRef = new WeakMap<object, DevelopmentAdapterContent>()
    const configurations: AdapterConfigurationReference[] = [],
      configurationContents: DevelopmentAdapterContent[] = []
    const programs: AdapterProgramFactory = {
      bind(configuration) {
        expect(this).toBe(programs)
        const configured = configs.get(configuration.reference)
        if (configured === undefined) throw new Error('missing selected program configuration')
        const program: AdapterProgramReference = {
          kind: 'development-adapter-program',
          reference: {},
        }
        programsByRef.set(program.reference, configured)
        return { ok: true, program }
      },
    }
    const effects = new PurposeEffects(content.namespace, programs)
    const binding = {
      configurationFor(configured: DevelopmentAdapterContent) {
        expect(this).toBe(binding)
        const configuration: AdapterConfigurationReference = {
          kind: 'development-adapter-configuration',
          reference: {},
        }
        configs.set(configuration.reference, configured)
        configurations.push(configuration)
        configurationContents.push(configured)
        return configuration
      },
    }
    // Each purpose is a complete separate selection, while the content namespace is shared.
    const requirement = {
      ...binding,
      effects,
      staging: content.staging,
      documentCommands: content.documents,
    }
    requirement.configurationFor = function (configured) {
      return binding.configurationFor(configured)
    }
    const pipeline = {
      ...binding,
      effects,
      staging: { collect: content.staging, trigger: content.staging, rerun: content.staging },
    }
    pipeline.configurationFor = function (configured) {
      return binding.configurationFor(configured)
    }
    const approval = { ...binding, effects, staging: content.staging }
    approval.configurationFor = function (configured) {
      return binding.configurationFor(configured)
    }
    const root = composeDevelopmentPurposeRoot({
      appHome: 'unused-selected-home',
      evidenceArtifacts: content.evidence,
      selection: { requirement, pipeline, approval },
    })
    let submitted:
      | {
          intentDigest: string
          correlationRef: string
          externalRequestRef: string
          submittedRevision: string
          submittedAt: string
        }
      | undefined
    effects.observeOperation = async (kind, input) => {
      const configured = programsByRef.get(input.program.reference)
      expect(configured).toBeDefined()
      const stage = content.stage(input.staging)
      if (kind === 'acquire') {
        await stage.writeText({ relativeName: 'body.md', text: 'Selected requirement body' })
        return {
          kind: 'completed',
          stdout: JSON.stringify({
            protocol: 'aw-adapter@1',
            operation: kind,
            sourceRevision: configured!.executableRef,
            title: 'Selected requirement',
            files: [{ relativePath: 'body.md', role: 'body' }],
          }),
          exitCode: 0,
        }
      }
      if (kind === 'questions.writeback')
        return {
          kind: 'completed',
          stdout: JSON.stringify({
            protocol: 'aw-adapter@1',
            operation: kind,
            correlationRef: 'questions:r1',
          }),
          exitCode: 0,
        }
      if (kind === 'answers.collect')
        return {
          kind: 'completed',
          stdout: JSON.stringify({
            protocol: 'aw-adapter@1',
            operation: kind,
            complete: true,
            answerRevision: 'r2',
            answers: [{ questionId: 'q1', answer: 'yes' }],
          }),
          exitCode: 0,
        }
      if (kind === 'pipeline.collect') {
        await stage.writeText({ relativeName: 'console.log', text: 'unit succeeded\n' })
        return {
          kind: 'completed',
          stdout: JSON.stringify({
            protocol: 'aw-adapter@1',
            operation: kind,
            providerKey: 'chosen',
            providerHeadSha: head,
            targetSha: target,
            completeness: 'complete',
            gates: [
              {
                gateKey: 'unit',
                required: true,
                status: 'pass',
                runRef: 'run1',
                attempt: 1,
                finishedAt: '2026-10-07T00:00:00+00:00',
                retryability: 'safe',
                failureCategories: [],
                files: [{ fileId: 'unit-log', relativePath: 'console.log' }],
              },
            ],
            redaction: 'complete',
          }),
          exitCode: 0,
        }
      }
      if (kind === 'pipeline.trigger')
        return {
          kind: 'completed',
          stdout: JSON.stringify({
            protocol: 'aw-adapter@1',
            operation: kind,
            providerReceiptRef: 'trigger:r1',
            runRef: 'run1',
            headSha: head,
            adopted: false,
          }),
          exitCode: 0,
        }
      if (kind === 'pipeline.rerun')
        return {
          kind: 'completed',
          stdout: JSON.stringify({
            protocol: 'aw-adapter@1',
            operation: kind,
            providerReceiptRef: 'rerun:r2',
            runRef: 'run1',
            headSha: head,
            attempt: 2,
          }),
          exitCode: 0,
        }
      if (kind === 'approval.submit') {
        const received = input as Parameters<typeof effects.submit>[0]
        submitted = {
          intentDigest: received.intentDigest,
          correlationRef: 'approval:r1',
          externalRequestRef: 'request:r1',
          submittedRevision: 'r1',
          submittedAt: '2026-10-07T00:00:00+00:00',
        }
        return {
          kind: 'completed',
          stdout: JSON.stringify({ protocol: 'aw-adapter@1', operation: kind, ...submitted }),
          exitCode: 0,
        }
      }
      if (kind === 'approval.lookup')
        return {
          kind: 'completed',
          stdout: JSON.stringify({
            protocol: 'aw-adapter@1',
            operation: kind,
            found: true,
            ...submitted,
          }),
          exitCode: 0,
        }
      return {
        kind: 'completed',
        stdout: JSON.stringify({
          protocol: 'aw-adapter@1',
          operation: kind,
          correlationRef: 'approval:r1',
          observedRevision: 'r2',
          status: 'approved',
          evidenceRef: 'approval:evidence',
          observedAt: '2026-10-07T01:00:00+00:00',
        }),
        exitCode: 0,
      }
    }
    const store = createDevelopmentAdapterStore(harness.db),
      actor = { userId: 'admin', actorHasScriptsAuthor: true }
    const publish = async (configured: DevelopmentAdapterContent) => {
      const created = await createDevelopmentAdapter(store, actor, {
        name: configured.purpose,
        content: configured,
        now: 1,
      })
      const revision = await publishDevelopmentAdapter(store, actor, { id: created.id, now: 2 })
      return { id: created.id, revision: revision.revision }
    }
    try {
      const req = await publish(
        definition('requirement-source', ['acquire', 'questions.writeback', 'answers.collect']),
      )
      const pipe = await publish(definition('pipeline-gate', ['collect', 'trigger', 'rerun']))
      const approvalRef = await publish(
        definition('approval-gateway', ['submit', 'lookup-by-idempotency-key', 'observe']),
      )
      const source = composeSelectedRequirementSourceRunnerFor(harness.db, root.requirement)
      const allocate = content.staging.create(),
        stage = 'then' in allocate ? await allocate : allocate
      const adapterBindingRef = `${req.id}@${req.revision}`
      expect(
        await source.acquire({ adapterBindingRef, externalId: 'ext', staging: stage.reference }),
      ).toMatchObject({ ok: true, sourceRevision: 'object:program:v1', outputBudget: budget })
      expect(
        await source.publishQuestions({
          adapterBindingRef,
          externalId: 'ext',
          questionsJson: '{"questions":[]}',
          staging: stage.reference,
        }),
      ).toEqual({ ok: true, correlationRef: 'questions:r1' })
      expect(
        await source.collectAnswers({
          adapterBindingRef,
          externalId: 'ext',
          correlationRef: 'questions:r1',
          staging: stage.reference,
        }),
      ).toMatchObject({ ok: true, complete: true, answerRevision: 'r2' })
      const port = composeSelectedDevelopmentPipelineEvidence(
        composeSelectedPipelineEvidenceRunnerFor(harness.db, root.pipeline),
        root.pipeline.staging,
      ).pipelineEvidence
      const pipelineInput = {
        adapterBindingRef: `${pipe.id}@${pipe.revision}`,
        headSha: head,
        targetSha: target,
        gateKeys: ['unit'],
      }
      const collected = await port.collect(pipelineInput)
      expect(collected.ok).toBe(true)
      if (!collected.ok) throw new Error('selected collect failed')
      const putEntered = held<void>(),
        putAck = held<void>()
      content.before = (operation) => {
        if (operation === 'put') {
          putEntered.resolve()
          return putAck.promise
        }
      }
      let imported = false
      const adoption = createSelectedPipelineImportAdapter(budget)
        .import({
          staging: collected.staging,
          envelope: collected.envelope,
          expectedHeadSha: head,
          expectedTargetSha: target,
        })
        .finally(() => {
          imported = true
        })
      try {
        await Promise.race([
          putEntered.promise,
          adoption.then(() => {
            throw new Error('manifest ended before selected put')
          }),
        ])
        expect(imported).toBe(false)
        expect(content.stage(collected.staging.reference).closed).toBe(false)
      } finally {
        putAck.resolve()
      }
      const manifest = await adoption
      expect(manifest.ok).toBe(true)
      if (!manifest.ok) throw new Error('selected manifest failed')
      const saved = JSON.parse((await content.evidence.contents.readText(manifest.manifestRef))!)
      expect(saved).toEqual(JSON.parse(manifest.manifestJson))
      expect(saved.gates[0].evidenceFileIds).toEqual(['unit-log'])
      expect(saved.files[0].sha256).toBeDefined()
      expect(await content.evidence.contents.readText(saved.files[0].sha256)).toBe(
        'unit succeeded\n',
      )
      content.before = () => {}
      await collected.cleanup()
      expect(content.stage(collected.staging.reference).closed).toBe(true)
      expect(await port.trigger({ ...pipelineInput, idempotencyKey: 'trigger' })).toEqual({
        ok: true,
        runRef: 'run1',
        providerReceiptRef: 'trigger:r1',
        adopted: false,
      })
      expect(
        await port.rerun({
          ...pipelineInput,
          idempotencyKey: 'rerun',
          gateKey: 'unit',
          runRef: 'run1',
        }),
      ).toEqual({ ok: true, runRef: 'run1', providerReceiptRef: 'rerun:r2', attempt: 2 })
      const gateway = composeSelectedApprovalGatewayRunnerFor(harness.db, root.approval)
      expect(
        await gateway.submit({
          adapterRef: approvalRef,
          stepRunRef: 'step',
          validatedDraftRef: 'draft',
          deadlineAt: '2026-10-08T00:00:00+00:00',
          idempotencyKey: 'approval',
        }),
      ).toEqual({ ok: true, receipt: submitted })
      const reconstructed = composeSelectedApprovalGatewayRunnerFor(harness.db, root.approval)
      expect(
        await reconstructed.lookupByIdempotencyKey({
          adapterRef: approvalRef,
          idempotencyKey: 'approval',
        }),
      ).toEqual(submitted)
      expect(
        await reconstructed.observe({ adapterRef: approvalRef, correlationRef: 'approval:r1' }),
      ).toMatchObject({
        ok: true,
        receipt: { status: 'approved', evidenceRef: 'approval:evidence' },
      })
      expect(configurations).toHaveLength(9)
      expect(new Set(configurations.map((x) => x.reference)).size).toBe(9)
      expect(configurationContents.map((x) => x.purpose)).toEqual([
        'requirement-source',
        'requirement-source',
        'requirement-source',
        'pipeline-gate',
        'pipeline-gate',
        'pipeline-gate',
        'approval-gateway',
        'approval-gateway',
        'approval-gateway',
      ])
      await reviseDevelopmentAdapterDraft(store, actor, {
        id: req.id,
        content: definition('requirement-source', ['acquire'], 'object:program:v2'),
        now: 3,
      })
      const second = await publishDevelopmentAdapter(store, actor, { id: req.id, now: 4 })
      expect(
        await source.acquire({
          adapterBindingRef: `${req.id}@${second.revision}`,
          externalId: 'ext',
          staging: stage.reference,
        }),
      ).toMatchObject({ ok: true, sourceRevision: 'object:program:v2' })
      const before = configurations.length
      expect(
        await source.publishQuestions({
          adapterBindingRef: `${req.id}@${second.revision}`,
          externalId: 'ext',
          questionsJson: '{}',
          staging: stage.reference,
        }),
      ).toMatchObject({ ok: false, failure: { code: 'operation-not-declared' } })
      expect(configurations).toHaveLength(before)
      expect(configurationContents.at(-1)!.executableRef).toBe('object:program:v2')
      await stage.close()
    } finally {
      rmSync(fx.stagingRoot, { recursive: true, force: true })
      rmSync(dirname(dirname(dirname(fx.evidence.blobPath('a'.repeat(64))))), {
        recursive: true,
        force: true,
      })
    }
  })
})
