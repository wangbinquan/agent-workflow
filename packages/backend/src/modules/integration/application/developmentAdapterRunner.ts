// RFC-370: Integration owns the original nine envelopes and result policy.
// Selected effects own program preparation and execution observations.
import { z } from 'zod'
import type { EvidenceStagingReference } from '@/modules/development-automation/public/types'
import type { DevelopmentAdapterOperation } from './developmentAdapterOperation'
import type {
  AdapterConfigurationReference,
  AdapterFailureCategory,
  AdapterFailureReceipt,
  AdapterRetryability,
  ApprovalAdapterEffects,
  PipelineAdapterEffects,
  RequirementAdapterEffects,
} from './ports/developmentAdapterEffects'

export type { AdapterFailureCategory, AdapterFailureReceipt, AdapterRetryability }

const STDOUT_LIMIT = 256 * 1024

export const acquireEnvelopeSchema = z
  .object({
    protocol: z.literal('aw-adapter@1'),
    operation: z.literal('acquire'),
    sourceRevision: z.string().min(1).max(200),
    title: z.string().min(1).max(500),
    files: z
      .array(
        z
          .object({ relativePath: z.string().min(1).max(1024), role: z.string().min(1).max(60) })
          .strict(),
      )
      .max(1000),
  })
  .strict()

export const writebackEnvelopeSchema = z
  .object({
    protocol: z.literal('aw-adapter@1'),
    operation: z.literal('questions.writeback'),
    correlationRef: z.string().min(1).max(200),
  })
  .strict()

export const collectAnswersEnvelopeSchema = z
  .object({
    protocol: z.literal('aw-adapter@1'),
    operation: z.literal('answers.collect'),
    complete: z.boolean(),
    answerRevision: z.string().min(1).max(200).nullable(),
    answers: z
      .array(z.object({ questionId: z.string().min(1), answer: z.string() }).strict())
      .max(200),
  })
  .strict()

// ---- pipeline 三 op envelope（PR-6 T63；design §6.1/§6.5）----------------
// gate status/retryability 词表与 development-automation domain/pipelineManifest.ts
// 的 gateStatusSchema 同词——跨 context 各自持有（rfc294 preflight 禁止反向
// import；两边由 backend 测试以样本配对锁定）。adapter stdout 只报文件描述符
// （relativePath/fileId），实体写进 sink；平台 importer 重新 walk sink 算真
// digest，adapter 自报 digest/bytes 不作数，所以 envelope 不携带它们。
const pipelineGateStatus = z.enum([
  'queued',
  'running',
  'pass',
  'fail',
  'canceled',
  'skipped',
  'unknown',
  'unavailable',
])
const sha40 = z.string().regex(/^[0-9a-f]{40}$/)

export const pipelineCollectEnvelopeSchema = z
  .object({
    protocol: z.literal('aw-adapter@1'),
    operation: z.literal('pipeline.collect'),
    providerKey: z.string().min(1).max(200),
    /** provider 无法提供 head 绑定（partial）时为 null——fence 恒不判 pass。 */
    providerHeadSha: sha40.nullable(),
    targetSha: sha40.nullable(),
    completeness: z.enum(['complete', 'partial']),
    gates: z
      .array(
        z
          .object({
            gateKey: z.string().min(1).max(200),
            required: z.boolean(),
            status: pipelineGateStatus,
            runRef: z.string().min(1).max(200),
            attempt: z.number().int().min(1),
            finishedAt: z.string().datetime({ offset: true }).nullable(),
            retryability: z.enum(['safe', 'unsafe', 'unknown']),
            failureCategories: z.array(z.string().min(1).max(100)).max(50),
            files: z
              .array(
                z
                  .object({
                    fileId: z.string().min(1).max(200),
                    relativePath: z.string().min(1).max(1024),
                  })
                  .strict(),
              )
              .max(1000),
          })
          .strict(),
      )
      .max(200),
    redaction: z.enum(['complete', 'failed']),
  })
  .strict()

export const pipelineTriggerEnvelopeSchema = z
  .object({
    protocol: z.literal('aw-adapter@1'),
    operation: z.literal('pipeline.trigger'),
    providerReceiptRef: z.string().min(1).max(200),
    runRef: z.string().min(1).max(200),
    headSha: sha40,
    /** true = 按 idempotencyKey 查到既有 run 并 adopt（未再造第二个）。 */
    adopted: z.boolean(),
  })
  .strict()

export const pipelineRerunEnvelopeSchema = z
  .object({
    protocol: z.literal('aw-adapter@1'),
    operation: z.literal('pipeline.rerun'),
    providerReceiptRef: z.string().min(1).max(200),
    runRef: z.string().min(1).max(200),
    attempt: z.number().int().min(1),
    headSha: sha40,
  })
  .strict()

const approvalReceiptFields = {
  intentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  correlationRef: z.string().min(1).max(500),
  externalRequestRef: z.string().min(1).max(500),
  submittedRevision: z.string().min(1).max(500),
  submittedAt: z.string().datetime({ offset: true }),
} as const

export const approvalSubmitEnvelopeSchema = z
  .object({
    protocol: z.literal('aw-adapter@1'),
    operation: z.literal('approval.submit'),
    ...approvalReceiptFields,
  })
  .strict()

export const approvalLookupEnvelopeSchema = z.discriminatedUnion('found', [
  z
    .object({
      protocol: z.literal('aw-adapter@1'),
      operation: z.literal('approval.lookup'),
      found: z.literal(true),
      ...approvalReceiptFields,
    })
    .strict(),
  z
    .object({
      protocol: z.literal('aw-adapter@1'),
      operation: z.literal('approval.lookup'),
      found: z.literal(false),
    })
    .strict(),
])

export const approvalObserveEnvelopeSchema = z
  .object({
    protocol: z.literal('aw-adapter@1'),
    operation: z.literal('approval.observe'),
    correlationRef: z.string().min(1).max(500),
    observedRevision: z.string().min(1).max(500),
    status: z.enum(['pending', 'approved', 'rejected', 'expired', 'unavailable']),
    evidenceRef: z.string().min(1).max(500).nullable(),
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict()

export interface AdapterRunInput {
  readonly configuration: AdapterConfigurationReference
  readonly staging: EvidenceStagingReference
  readonly effects: RequirementAdapterEffects | PipelineAdapterEffects | ApprovalAdapterEffects
  readonly operation: DevelopmentAdapterOperation
}

export type AdapterRunResult<T> =
  | { readonly ok: true; readonly envelope: T }
  | { readonly ok: false; readonly failure: AdapterFailureReceipt }

function failure(
  category: AdapterFailureCategory,
  code: string,
  retryability: AdapterRetryability,
  remediation: string,
): { ok: false; failure: AdapterFailureReceipt } {
  return {
    ok: false,
    failure: { category, code, retryability, attemptOrdinal: 0, remediation, evidenceRef: null },
  }
}

function isReference(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

/** Every selected purpose is complete before its first program effect. */
function assertCompletePurpose(input: AdapterRunInput): void {
  const kind = input.operation.kind
  const names =
    kind === 'acquire' || kind === 'questions.writeback' || kind === 'answers.collect'
      ? (['acquire', 'questionsWriteback', 'answersCollect'] as const)
      : kind === 'pipeline.collect' || kind === 'pipeline.trigger' || kind === 'pipeline.rerun'
        ? (['collect', 'trigger', 'rerun'] as const)
        : (['submit', 'lookup', 'observe'] as const)
  const effects = input.effects
  if (!isReference(effects)) throw new Error('development-adapter-purpose-incomplete')
  const members = effects as unknown as Record<string, unknown>
  for (const name of names) {
    if (typeof members[name] !== 'function') {
      throw new Error(`development-adapter-purpose-incomplete:${name}`)
    }
  }
  if (!isReference(effects.programs) || typeof effects.programs.bind !== 'function') {
    throw new Error('development-adapter-purpose-incomplete:programs.bind')
  }
  if (
    effects.namespace?.kind !== 'evidence-staging-namespace' ||
    !isReference(effects.namespace.reference) ||
    input.staging?.kind !== 'evidence-staging' ||
    input.staging.namespace.kind !== 'evidence-staging-namespace' ||
    !isReference(input.staging.reference) ||
    input.staging.namespace.reference !== effects.namespace.reference
  ) {
    throw new Error('development-adapter-staging-namespace-mismatch')
  }
  if (
    input.configuration?.kind !== 'development-adapter-configuration' ||
    !isReference(input.configuration.reference)
  ) {
    throw new Error('development-adapter-configuration-reference-invalid')
  }
}

async function runAdapter(input: AdapterRunInput): Promise<AdapterRunResult<unknown>> {
  assertCompletePurpose(input)
  const binding = input.effects.programs.bind(input.configuration)
  const prepared = 'then' in binding ? await binding : binding
  if (!prepared.ok) return prepared
  if (
    prepared.program?.kind !== 'development-adapter-program' ||
    !isReference(prepared.program.reference)
  ) {
    throw new Error('development-adapter-program-reference-invalid')
  }
  const common = { program: prepared.program, staging: input.staging }
  const operation = input.operation
  const observation = await (() => {
    switch (operation.kind) {
      case 'acquire':
        return (input.effects as RequirementAdapterEffects).acquire({
          ...common,
          externalId: operation.externalId,
        })
      case 'questions.writeback':
        return (input.effects as RequirementAdapterEffects).questionsWriteback({
          ...common,
          externalId: operation.externalId,
          questionsJson: operation.questionsJson,
        })
      case 'answers.collect':
        return (input.effects as RequirementAdapterEffects).answersCollect({
          ...common,
          externalId: operation.externalId,
          correlationRef: operation.correlationRef,
        })
      case 'pipeline.collect':
        return (input.effects as PipelineAdapterEffects).collect({
          ...common,
          headSha: operation.headSha,
          targetSha: operation.targetSha,
          gateKeysCsv: operation.gateKeysCsv,
        })
      case 'pipeline.trigger':
        return (input.effects as PipelineAdapterEffects).trigger({
          ...common,
          headSha: operation.headSha,
          gateKeysCsv: operation.gateKeysCsv,
          idempotencyKey: operation.idempotencyKey,
        })
      case 'pipeline.rerun':
        return (input.effects as PipelineAdapterEffects).rerun({
          ...common,
          runRef: operation.runRef,
          gateKey: operation.gateKey,
          headSha: operation.headSha,
          idempotencyKey: operation.idempotencyKey,
        })
      case 'approval.submit':
        return (input.effects as ApprovalAdapterEffects).submit({
          ...common,
          stepRunRef: operation.stepRunRef,
          draftRef: operation.draftRef,
          deadlineAt: operation.deadlineAt,
          idempotencyKey: operation.idempotencyKey,
          intentDigest: operation.intentDigest,
        })
      case 'approval.lookup':
        return (input.effects as ApprovalAdapterEffects).lookup({
          ...common,
          idempotencyKey: operation.idempotencyKey,
        })
      case 'approval.observe':
        return (input.effects as ApprovalAdapterEffects).observe({
          ...common,
          correlationRef: operation.correlationRef,
        })
    }
  })()
  if (observation.kind === 'unavailable') {
    return failure(
      'configuration',
      'adapter-executable-unavailable',
      'after-configuration',
      'fix the adapter executableRef',
    )
  }
  const timedOut = observation.kind === 'expired'
  const stdout = observation.kind === 'completed' ? observation.stdout : ''
  const exitCode = observation.kind === 'completed' ? observation.exitCode : 0
  if (timedOut) {
    return failure(
      'transient',
      'adapter-timeout',
      'same-input',
      'retry with backoff or raise adapter timeout',
    )
  }
  if (stdout.length > STDOUT_LIMIT) {
    return failure(
      'contract-violation',
      'adapter-stdout-overflow',
      'never',
      'adapter must keep stdout to one small envelope',
    )
  }
  if (exitCode !== 0) {
    const mapped =
      exitCode === 2
        ? (['configuration', 'after-configuration'] as const)
        : exitCode === 5
          ? (['transient', 'same-input'] as const)
          : exitCode === 6
            ? (['stale-input', 'after-refresh'] as const)
            : (['business-failure', 'never'] as const)
    return failure(
      mapped[0],
      `adapter-exit-${exitCode}`,
      mapped[1],
      `inspect the Adapter's provider-side diagnostics for exit code ${exitCode}`,
    )
  }
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0)
  const last = lines[lines.length - 1]
  if (last === undefined) {
    return failure(
      'contract-violation',
      'adapter-envelope-missing',
      'never',
      'adapter printed no envelope',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(last)
  } catch {
    return failure(
      'contract-violation',
      'adapter-envelope-not-json',
      'never',
      'adapter envelope must be one JSON line',
    )
  }
  return { ok: true, envelope: parsed }
}

export async function runRequirementAcquire(
  input: AdapterRunInput & {
    readonly operation: { readonly kind: 'acquire'; readonly externalId: string }
  },
): Promise<AdapterRunResult<z.infer<typeof acquireEnvelopeSchema>>> {
  const raw = await runAdapter(input)
  if (!raw.ok) return raw
  const parsed = acquireEnvelopeSchema.safeParse(raw.envelope)
  if (!parsed.success) {
    return failure(
      'contract-violation',
      'adapter-envelope-schema',
      'never',
      'acquire envelope failed strict schema',
    )
  }
  return { ok: true, envelope: parsed.data }
}

export async function runQuestionsWriteback(
  input: AdapterRunInput & {
    readonly operation: {
      readonly kind: 'questions.writeback'
      readonly externalId: string
      readonly questionsJson: string
    }
  },
): Promise<AdapterRunResult<z.infer<typeof writebackEnvelopeSchema>>> {
  const raw = await runAdapter(input)
  if (!raw.ok) return raw
  const parsed = writebackEnvelopeSchema.safeParse(raw.envelope)
  if (!parsed.success) {
    return failure(
      'contract-violation',
      'adapter-envelope-schema',
      'never',
      'writeback envelope failed strict schema',
    )
  }
  return { ok: true, envelope: parsed.data }
}

export async function runAnswersCollect(
  input: AdapterRunInput & {
    readonly operation: {
      readonly kind: 'answers.collect'
      readonly externalId: string
      readonly correlationRef: string
    }
  },
): Promise<AdapterRunResult<z.infer<typeof collectAnswersEnvelopeSchema>>> {
  const raw = await runAdapter(input)
  if (!raw.ok) return raw
  const parsed = collectAnswersEnvelopeSchema.safeParse(raw.envelope)
  if (!parsed.success) {
    return failure(
      'contract-violation',
      'adapter-envelope-schema',
      'never',
      'collect envelope failed strict schema',
    )
  }
  return { ok: true, envelope: parsed.data }
}

export async function runPipelineCollect(
  input: AdapterRunInput & {
    readonly operation: {
      readonly kind: 'pipeline.collect'
      readonly headSha: string
      readonly targetSha: string
      readonly gateKeysCsv: string
    }
  },
): Promise<AdapterRunResult<z.infer<typeof pipelineCollectEnvelopeSchema>>> {
  const raw = await runAdapter(input)
  if (!raw.ok) return raw
  const parsed = pipelineCollectEnvelopeSchema.safeParse(raw.envelope)
  if (!parsed.success) {
    return failure(
      'contract-violation',
      'adapter-envelope-schema',
      'never',
      'pipeline.collect envelope failed strict schema',
    )
  }
  return { ok: true, envelope: parsed.data }
}

export async function runPipelineTrigger(
  input: AdapterRunInput & {
    readonly operation: {
      readonly kind: 'pipeline.trigger'
      readonly headSha: string
      readonly gateKeysCsv: string
      readonly idempotencyKey: string
    }
  },
): Promise<AdapterRunResult<z.infer<typeof pipelineTriggerEnvelopeSchema>>> {
  const raw = await runAdapter(input)
  if (!raw.ok) return raw
  const parsed = pipelineTriggerEnvelopeSchema.safeParse(raw.envelope)
  if (!parsed.success) {
    return failure(
      'contract-violation',
      'adapter-envelope-schema',
      'never',
      'pipeline.trigger envelope failed strict schema',
    )
  }
  return { ok: true, envelope: parsed.data }
}

export async function runPipelineRerun(
  input: AdapterRunInput & {
    readonly operation: {
      readonly kind: 'pipeline.rerun'
      readonly runRef: string
      readonly gateKey: string
      readonly headSha: string
      readonly idempotencyKey: string
    }
  },
): Promise<AdapterRunResult<z.infer<typeof pipelineRerunEnvelopeSchema>>> {
  const raw = await runAdapter(input)
  if (!raw.ok) return raw
  const parsed = pipelineRerunEnvelopeSchema.safeParse(raw.envelope)
  if (!parsed.success) {
    return failure(
      'contract-violation',
      'adapter-envelope-schema',
      'never',
      'pipeline.rerun envelope failed strict schema',
    )
  }
  return { ok: true, envelope: parsed.data }
}

export async function runApprovalSubmit(
  input: AdapterRunInput & {
    readonly operation: Extract<AdapterRunInput['operation'], { kind: 'approval.submit' }>
  },
): Promise<AdapterRunResult<z.infer<typeof approvalSubmitEnvelopeSchema>>> {
  const raw = await runAdapter(input)
  if (!raw.ok) return raw
  const parsed = approvalSubmitEnvelopeSchema.safeParse(raw.envelope)
  return parsed.success
    ? { ok: true, envelope: parsed.data }
    : failure(
        'contract-violation',
        'adapter-envelope-schema',
        'never',
        'approval.submit envelope failed strict schema',
      )
}

export async function runApprovalLookup(
  input: AdapterRunInput & {
    readonly operation: Extract<AdapterRunInput['operation'], { kind: 'approval.lookup' }>
  },
): Promise<AdapterRunResult<z.infer<typeof approvalLookupEnvelopeSchema>>> {
  const raw = await runAdapter(input)
  if (!raw.ok) return raw
  const parsed = approvalLookupEnvelopeSchema.safeParse(raw.envelope)
  return parsed.success
    ? { ok: true, envelope: parsed.data }
    : failure(
        'contract-violation',
        'adapter-envelope-schema',
        'never',
        'approval.lookup envelope failed strict schema',
      )
}

export async function runApprovalObserve(
  input: AdapterRunInput & {
    readonly operation: Extract<AdapterRunInput['operation'], { kind: 'approval.observe' }>
  },
): Promise<AdapterRunResult<z.infer<typeof approvalObserveEnvelopeSchema>>> {
  const raw = await runAdapter(input)
  if (!raw.ok) return raw
  const parsed = approvalObserveEnvelopeSchema.safeParse(raw.envelope)
  return parsed.success
    ? { ok: true, envelope: parsed.data }
    : failure(
        'contract-violation',
        'adapter-envelope-schema',
        'never',
        'approval.observe envelope failed strict schema',
      )
}
