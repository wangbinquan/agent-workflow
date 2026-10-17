import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type {
  EvidenceStagingNamespace,
  EvidenceStagingReference,
} from '@/modules/development-automation/public/types'
import {
  developmentAdapterContentSchema,
  type DevelopmentAdapterContent,
} from '../domain/developmentAdapterDefinition'
import type { DevelopmentAdapterOperation } from '../application/developmentAdapterOperation'
import type { AdapterConfigurationBinding } from '../application/ports/developmentPurposeBinding'
import type {
  AdapterConfigurationReference,
  AdapterProgramReference,
  AdapterProgramFactory,
  AdapterFailureReceipt,
  AdapterProcessObservation,
  RequirementAdapterEffects,
  PipelineAdapterEffects,
  ApprovalAdapterEffects,
} from '../application/ports/developmentAdapterEffects'
import { sha256Hex } from '@/util/hash'

export function composeCrewStationDevelopmentAdapters(input: {
  readonly helper: WorkspaceHelper
  readonly staging: {
    readonly namespace: EvidenceStagingNamespace
    begin(
      reference: EvidenceStagingReference,
      stableId?: string,
    ): Promise<{ taskId: string; path: string; id: string }>
    settled(reference: EvidenceStagingReference): void
  }
}) {
  const configurations = new WeakMap<object, DevelopmentAdapterContent>()
  const prepared = new WeakMap<object, DevelopmentAdapterContent>()
  const configurationFor: AdapterConfigurationBinding['configurationFor'] = (content) => {
    const reference: AdapterConfigurationReference = {
      kind: 'development-adapter-configuration',
      reference: {},
    }
    configurations.set(reference.reference, developmentAdapterContentSchema.parse(content))
    return reference
  }
  const programs: AdapterProgramFactory = {
    async bind(configuration) {
      const content = configurations.get(configuration.reference)
      if (!content) throw new Error('hosted-adapter-configuration-owner-mismatch')
      const result = await input.helper.call<
        { ok: true } | { ok: false; failure: AdapterFailureReceipt }
      >('development:shared', 'development-adapter', {
        method: 'prepare',
        configuration: content,
      })
      if (!result.ok) return result
      const program: AdapterProgramReference = {
        kind: 'development-adapter-program',
        reference: {},
      }
      prepared.set(program.reference, content)
      return { ok: true, program }
    },
  }
  const execute = async (
    program: AdapterProgramReference,
    staging: EvidenceStagingReference,
    operation: DevelopmentAdapterOperation,
  ): Promise<AdapterProcessObservation> => {
    const configuration = prepared.get(program.reference)
    if (!configuration) throw new Error('hosted-adapter-program-owner-mismatch')
    const mutation = [
      'questions.writeback',
      'pipeline.trigger',
      'pipeline.rerun',
      'approval.submit',
    ].includes(operation.kind)
    const stableId = mutation
      ? sha256Hex(
          JSON.stringify(
            'idempotencyKey' in operation
              ? [operation.kind, operation.idempotencyKey]
              : { configuration, operation },
          ),
        )
      : undefined
    const scope = await input.staging.begin(staging, stableId)
    const id = stableId ?? sha256Hex(JSON.stringify([scope.id, configuration, operation]))
    const result = await input.helper.call<AdapterProcessObservation>(
      scope.taskId,
      'development-adapter',
      {
        method: 'run',
        configuration,
        operation,
        path: scope.path,
        id,
      },
      { operationId: `development-adapter:${id}`, timeoutMs: configuration.timeoutMs + 30_000 },
    )
    input.staging.settled(staging)
    return result
  }
  const common = { namespace: input.staging.namespace, programs }
  const requirement: RequirementAdapterEffects = {
    ...common,
    acquire: ({ program, staging, externalId }) =>
      execute(program, staging, { kind: 'acquire', externalId }),
    questionsWriteback: ({ program, staging, externalId, questionsJson }) =>
      execute(program, staging, { kind: 'questions.writeback', externalId, questionsJson }),
    answersCollect: ({ program, staging, externalId, correlationRef }) =>
      execute(program, staging, { kind: 'answers.collect', externalId, correlationRef }),
  }
  const pipeline: PipelineAdapterEffects = {
    ...common,
    collect: ({ program, staging, headSha, targetSha, gateKeysCsv }) =>
      execute(program, staging, { kind: 'pipeline.collect', headSha, targetSha, gateKeysCsv }),
    trigger: ({ program, staging, headSha, gateKeysCsv, idempotencyKey }) =>
      execute(program, staging, { kind: 'pipeline.trigger', headSha, gateKeysCsv, idempotencyKey }),
    rerun: ({ program, staging, runRef, gateKey, headSha, idempotencyKey }) =>
      execute(program, staging, {
        kind: 'pipeline.rerun',
        runRef,
        gateKey,
        headSha,
        idempotencyKey,
      }),
  }
  const approval: ApprovalAdapterEffects = {
    ...common,
    submit: ({
      program,
      staging,
      stepRunRef,
      draftRef,
      deadlineAt,
      idempotencyKey,
      intentDigest,
    }) =>
      execute(program, staging, {
        kind: 'approval.submit',
        stepRunRef,
        draftRef,
        deadlineAt,
        idempotencyKey,
        intentDigest,
      }),
    lookup: ({ program, staging, idempotencyKey }) =>
      execute(program, staging, { kind: 'approval.lookup', idempotencyKey }),
    observe: ({ program, staging, correlationRef }) =>
      execute(program, staging, { kind: 'approval.observe', correlationRef }),
  }
  return { configurationFor, requirement, pipeline, approval }
}
