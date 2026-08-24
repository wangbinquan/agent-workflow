import { ConflictError, NotFoundError } from '@/util/errors'
import type { ExecutionContractProgramFixturePort, ExecutionContractResourcePort } from './ports'
import {
  EXECUTION_CONTRACT_RESULT_PORT,
  executionContractGuideSchema,
  executionContractImplementationSchema,
  executionContractRefKey,
  executionContractValidationReceiptSchema,
  validateExactContractInput,
  validateExactContractOutput,
  type ExecutionContractCheck,
  type ExecutionContractGuide,
  type ExecutionContractImplementation,
  type ExecutionContractRef,
  type ExecutionContractRegistration,
  type ExecutionContractRuntimeView,
  type ExecutionContractValidationReceipt,
} from '../domain/model'

export interface ExecutionContractServiceDependencies {
  readonly registrations: readonly ExecutionContractRegistration[]
  readonly resources: ExecutionContractResourcePort
  readonly programFixtures: ExecutionContractProgramFixturePort
}

function invalid(code: string, detail: string): ExecutionContractCheck {
  return { code, ok: false, detail }
}

function sameRef(left: ExecutionContractRef, right: ExecutionContractRef): boolean {
  return left.contractId === right.contractId && left.version === right.version
}

function runtimeView(guide: ExecutionContractGuide): ExecutionContractRuntimeView {
  const agentTransport = guide.transports.agent
  return {
    schemaVersion: 1,
    inputMode: guide.inputMode,
    contractRef: guide.contractRef,
    displayName: guide.displayName,
    description: guide.description,
    inputSchemaId: guide.input.schemaId,
    outputSchemaId: guide.output.schemaId,
    outputTopLevelFields: guide.output.topLevelFields,
    allowedExecutorKinds: guide.allowedExecutorKinds,
    agentOutputPort:
      agentTransport === null
        ? null
        : (agentTransport.outputPort ?? EXECUTION_CONTRACT_RESULT_PORT),
    agentOutputKind: agentTransport?.outputKind ?? null,
    guideJson: JSON.stringify(guide),
  }
}

export class ExecutionContractService {
  readonly #guides = new Map<string, ExecutionContractGuide>()
  readonly #registrations = new Map<string, ExecutionContractRegistration>()
  readonly #resources: ExecutionContractResourcePort
  readonly #programFixtures: ExecutionContractProgramFixturePort

  constructor(deps: ExecutionContractServiceDependencies) {
    this.#resources = deps.resources
    this.#programFixtures = deps.programFixtures
    for (const registration of deps.registrations) {
      const guide = executionContractGuideSchema.parse(
        JSON.parse(registration.guideJson) as unknown,
      )
      if (!sameRef(registration.contractRef, guide.contractRef)) {
        throw new ConflictError(
          'execution-contract-registration-ref-mismatch',
          `${executionContractRefKey(registration.contractRef)} != ${executionContractRefKey(guide.contractRef)}`,
        )
      }
      const key = executionContractRefKey(guide.contractRef)
      if (this.#guides.has(key)) throw new ConflictError('execution-contract-duplicate', key)
      this.#guides.set(key, guide)
      this.#registrations.set(key, registration)
    }
  }

  list(): ExecutionContractRuntimeView[] {
    return [...this.#guides.values()]
      .sort((left, right) =>
        executionContractRefKey(left.contractRef).localeCompare(
          executionContractRefKey(right.contractRef),
        ),
      )
      .map(runtimeView)
  }

  get(ref: ExecutionContractRef): ExecutionContractRuntimeView {
    return runtimeView(this.#getGuide(ref))
  }

  #getGuide(ref: ExecutionContractRef): ExecutionContractGuide {
    const key = executionContractRefKey(ref)
    const guide = this.#guides.get(key)
    if (guide === undefined) {
      throw new NotFoundError(
        'execution-contract-not-found',
        `execution contract not found: ${key}`,
      )
    }
    return guide
  }

  async validateExecutor(input: {
    readonly contractRef: ExecutionContractRef
    readonly implementation: ExecutionContractImplementation
  }): Promise<ExecutionContractValidationReceipt> {
    const guide = this.#getGuide(input.contractRef)
    const implementation = executionContractImplementationSchema.parse(input.implementation)
    const checks: ExecutionContractCheck[] = [
      {
        code: 'executor-kind-allowed',
        ok: guide.allowedExecutorKinds.includes(implementation.kind),
        detail: guide.allowedExecutorKinds.includes(implementation.kind)
          ? `${implementation.kind} is allowed by ${executionContractRefKey(guide.contractRef)}`
          : `${implementation.kind} is not allowed; choose ${guide.allowedExecutorKinds.join(', ')}`,
      },
      {
        code: 'input-schema-bound',
        ok: guide.input.schemaId.length > 0,
        detail: `${guide.input.schemaId} -> ${
          implementation.kind === 'program'
            ? guide.transports.program?.inputLocation
            : implementation.kind === 'agent'
              ? guide.transports.agent?.inputLocation
              : guide.transports.workflow?.inputLocation
        }`,
      },
      {
        code: 'output-schema-bound',
        ok: guide.output.schemaId.length > 0,
        detail: `${guide.output.schemaId} <- ${
          implementation.kind === 'program'
            ? guide.transports.program?.outputLocation
            : implementation.kind === 'agent'
              ? guide.transports.agent?.outputLocation
              : guide.transports.workflow?.outputLocation
        }`,
      },
    ]

    if (implementation.kind === 'program') {
      checks.push(
        ...(await this.#programFixtures.validate({
          guide,
          implementation,
          validateOutputJson: this.#registrations.get(executionContractRefKey(guide.contractRef))
            ?.validateOutputJson,
        })),
      )
    } else {
      const transport =
        implementation.kind === 'agent' ? guide.transports.agent : guide.transports.workflow
      const projection = await this.#resources.inspect({
        implementation,
        expectedOutputPort: transport?.outputPort ?? EXECUTION_CONTRACT_RESULT_PORT,
      })
      checks.push(
        projection === null
          ? invalid(
              `${implementation.kind}-exact-revision-resolves`,
              `${implementation.kind} exact revision was not found`,
            )
          : {
              code: `${implementation.kind}-exact-revision-resolves`,
              ok: projection.available,
              detail: projection.detail,
            },
      )
      if (projection !== null && implementation.kind === 'agent') {
        const declared = projection.declaredContractRefs ?? []
        checks.push({
          code: 'agent-contract-declared',
          ok: declared.some((ref) => sameRef(ref, guide.contractRef)),
          detail: declared.some((ref) => sameRef(ref, guide.contractRef))
            ? `${projection.name} declares ${executionContractRefKey(guide.contractRef)}`
            : `${projection.name} must declare ${executionContractRefKey(guide.contractRef)} in its platform execution contracts`,
        })
      }
    }

    return executionContractValidationReceiptSchema.parse({
      schemaVersion: 1,
      contractRef: guide.contractRef,
      status: checks.every((check) => check.ok) ? 'valid' : 'invalid',
      checks,
    })
  }

  validateEnvelope(input: {
    readonly direction: 'input' | 'output'
    readonly contractRef: ExecutionContractRef
    readonly roundRef: string
    readonly executionNonce: string
    readonly envelopeJson: string
  }): string {
    const guide = this.#getGuide(input.contractRef)
    if (input.direction === 'input') {
      if (guide.inputMode === 'direct-json') {
        let decoded: unknown
        try {
          decoded = JSON.parse(input.envelopeJson) as unknown
        } catch {
          throw new Error('platform input envelope must be valid JSON')
        }
        if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
          throw new Error('platform input envelope must be one JSON object')
        }
        return JSON.stringify(decoded)
      }
      return validateExactContractInput({
        guide,
        roundRef: input.roundRef,
        executionNonce: input.executionNonce,
        inputJson: input.envelopeJson,
      })
    }
    if (guide.outputMode !== 'direct-json') {
      return validateExactContractOutput({
        guide,
        roundRef: input.roundRef,
        executionNonce: input.executionNonce,
        outputJson: input.envelopeJson,
      })
    }
    const registration = this.#registrations.get(executionContractRefKey(input.contractRef))!
    const contractValidated = registration.validateOutputJson?.(input.envelopeJson)
    if (contractValidated === undefined) {
      throw new Error('direct JSON output contract has no registered validator')
    }
    const exactResult = validateExactContractOutput({
      guide,
      roundRef: input.roundRef,
      executionNonce: input.executionNonce,
      outputJson: contractValidated,
    })
    return JSON.stringify({
      schemaVersion: 1,
      roundRef: input.roundRef,
      executionNonce: input.executionNonce,
      directResult: JSON.parse(exactResult) as unknown,
    })
  }

  projectInput(input: {
    readonly contractRef: ExecutionContractRef
    readonly roundRef: string
    readonly executionNonce: string
    readonly inputEnvelopeJson: string
    readonly projectionJson?: string | null
  }): string {
    const guide = this.#getGuide(input.contractRef)
    if (guide.inputMode === 'host-envelope') return input.inputEnvelopeJson
    const registration = this.#registrations.get(executionContractRefKey(input.contractRef))!
    const projected = registration.projectInputJson?.({
      inputEnvelopeJson: input.inputEnvelopeJson,
      projectionJson: input.projectionJson,
    })
    if (projected === undefined) {
      throw new Error('direct JSON input contract has no registered projector')
    }
    return validateExactContractInput({
      guide,
      roundRef: input.roundRef,
      executionNonce: input.executionNonce,
      inputJson: projected,
    })
  }

  async validateAgentCandidates(input: {
    readonly contractRef: ExecutionContractRef
    readonly agentRefs: readonly { readonly id: string; readonly revision: number }[]
  }) {
    this.#getGuide(input.contractRef)
    const unique = [
      ...new Map(
        input.agentRefs.map((agentRef) => [`${agentRef.id}@${agentRef.revision}`, agentRef]),
      ).values(),
    ]
    return Promise.all(
      unique.map(async (agentRef) => ({
        agentRef,
        validationReceipt: await this.validateExecutor({
          contractRef: input.contractRef,
          implementation: { kind: 'agent', agentRef },
        }),
      })),
    )
  }
}
