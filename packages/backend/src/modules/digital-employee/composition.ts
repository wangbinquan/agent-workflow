import { join } from 'node:path'

import type { DbClient } from '@/db/client'
import type { EventCenterParticipant } from '@/modules/event-center/public/participants'
import { DigitalEmployeeAuthoringService } from './application/authoringService'
import { DigitalEmployeeRuntimeService } from './application/runtimeService'
import {
  createToolResourceCatalogAdapter,
  createWorkContractFixtureAdapter,
} from './composition/defaultRequiredPorts'
import type {
  EmployeeInputArtifactPort,
  ProgramArtifactPort,
  PlatformWorkItemExecutionPort,
  ReactionExecutionPort,
  ToolConnectionCatalogPort,
  ToolResourceCatalogPort,
  WorkContractFixturePort,
} from './composition/required-ports'
import { createProgramArtifactStore } from './infrastructure/programArtifactStore'
import { createEmployeeInputArtifactStore } from './infrastructure/inputArtifactStore'
import {
  createEmployeeInputUploadStore,
  type EmployeeInputUploadRecord,
} from './infrastructure/inputUploadStore'
import { createSqliteDigitalEmployeeAuthoringStore } from './infrastructure/sqliteAuthoringStore'
import { createSqliteRuntimeStore } from './infrastructure/sqliteRuntimeStore'
import { analyzeDigitalEmployeeMigration } from './composition/writerCutover'
import { z } from 'zod'
import { contractValidationCheckSchema, employeeTypePackageDescriptorSchema } from './domain/model'
import type {
  DigitalEmployeeDefinitionContent,
  DigitalEmployeeDefinitionDraft,
  EmployeeAuthoringManifest,
  EmployeeJobTemplateContent,
  EmployeeTypePackageDescriptor,
  EmployeeTypeRef,
  EmployeeTypeRuntimePackage,
  ExactResourceRef,
  GlobalExecutionPolicy,
  ToolRegistrationContent,
  ToolValidationReceipt,
} from './domain/model'
import type {
  EmployeeCaseLaunchInput,
  EmployeeCaseProjectionDocument,
  EmployeeTypePackageRegistration,
  EmployeeTypeCollaborationCodec,
  EmployeeTypeContextCodec,
  EmployeeTypeReactionCodec,
} from './public/types'

export { createReactionExecutionAdapter } from './application/adapters/task-execution-adapter'
export { startDigitalEmployeeOsWorker } from './application/osWorker'
export {
  activateDigitalEmployeeOsWriter,
  readDigitalEmployeeWriterState,
  refreshDigitalEmployeeWriterState,
} from './composition/writerCutover'
export { createEmployeeInputArtifactStore } from './infrastructure/inputArtifactStore'

type EmployeeTypeRuntimeCodec = EmployeeTypeContextCodec &
  EmployeeTypeReactionCodec &
  EmployeeTypeCollaborationCodec

export interface ToolRegistrationView {
  readonly id: string
  readonly typeRef: EmployeeTypeRef
  readonly workItemRef: string
  readonly content: ToolRegistrationContent
  readonly validationReceipt: ToolValidationReceipt
  readonly publishedRevision: number | null
  readonly state: 'draft' | 'published' | 'retired'
  readonly createdAt: number
  readonly updatedAt: number
}

export interface JobTemplateView {
  readonly id: string
  readonly typeRef: EmployeeTypeRef
  readonly name: string
  readonly draft: EmployeeJobTemplateContent
  readonly publishedRevision: number | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface EmployeeDefinitionView {
  readonly id: string
  readonly name: string
  readonly typeRef: EmployeeTypeRef
  readonly draft: DigitalEmployeeDefinitionDraft
  readonly publishedRevision: number | null
  readonly published: DigitalEmployeeDefinitionContent | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ExecutionPolicyView {
  readonly revision: number
  readonly content: GlobalExecutionPolicy
  readonly contentDigest: string
  readonly publishedAt: number
}

export interface DigitalEmployeeCommands {
  createTool(input: {
    readonly typeRef: EmployeeTypeRef
    readonly workItemRef: string
    readonly body: unknown
    readonly actorUserId: string | null
  }): Promise<ToolRegistrationView>
  validateTool(
    input: Parameters<DigitalEmployeeAuthoringService['validateTool']>[0],
  ): Promise<ToolRegistrationView>
  publishTool(
    input: Parameters<DigitalEmployeeAuthoringService['publishTool']>[0],
  ): Promise<ExactResourceRef>
  retireTool(input: Parameters<DigitalEmployeeAuthoringService['retireTool']>[0]): void
  createJobTemplate(input: {
    readonly typeRef: EmployeeTypeRef
    readonly body: unknown
    readonly actorUserId: string | null
  }): JobTemplateView
  updateJobTemplate(
    input: Parameters<DigitalEmployeeAuthoringService['updateJobTemplate']>[0],
  ): JobTemplateView
  publishJobTemplate(
    input: Parameters<DigitalEmployeeAuthoringService['publishJobTemplate']>[0],
  ): ExactResourceRef
  createEmployee(input: {
    readonly typeRef: EmployeeTypeRef
    readonly body: unknown
    readonly actorUserId: string | null
  }): EmployeeDefinitionView
  updateEmployee(input: { readonly id: string; readonly body: unknown }): EmployeeDefinitionView
  publishEmployee(
    input: Parameters<DigitalEmployeeAuthoringService['publishEmployeeDefinition']>[0],
  ): ExactResourceRef
  publishExecutionPolicy(
    input: Parameters<DigitalEmployeeAuthoringService['publishExecutionPolicy']>[0],
  ): ExecutionPolicyView
}

export interface DigitalEmployeeQueries {
  listTypes(): EmployeeTypePackageDescriptor[]
  getType(ref: EmployeeTypeRef): EmployeeTypePackageDescriptor
  getAuthoringManifest(ref: EmployeeTypeRef): EmployeeAuthoringManifest
  listTools(ref: EmployeeTypeRef, workItemRef: string): ToolRegistrationView[]
  listJobTemplates(ref: EmployeeTypeRef): JobTemplateView[]
  listEmployees(ref?: EmployeeTypeRef): EmployeeDefinitionView[]
  getEmployee(id: string): EmployeeDefinitionView
  getExecutionPolicy(): ExecutionPolicyView
  getMigrationStatus(): ReturnType<typeof analyzeDigitalEmployeeMigration>
}

export interface DigitalEmployeeModule {
  readonly commands: DigitalEmployeeCommands
  readonly queries: DigitalEmployeeQueries
  readonly inputUploads: {
    create(input: {
      readonly absolutePath: string
      readonly originalName: string
      readonly actorUserId: string | null
      readonly idempotencyKey: string | null
    }): Promise<EmployeeInputUploadRecord>
    delete(uploadRef: string, actorUserId: string | null): void
    sweepExpired(): number
  }
  readonly runtime: {
    readonly commands: {
      launch(input: EmployeeCaseLaunchInput): EmployeeCaseProjectionDocument
      launchWork(input: {
        readonly employeeId: string
        readonly intake: unknown
        readonly actorUserId: string | null
      }): EmployeeCaseProjectionDocument
      previewPolicyUpgrade(caseId: string, targetPolicyRevision: number): string
      applyPolicyUpgrade(previewToken: string): EmployeeCaseProjectionDocument
      terminate(caseId: string, terminalKind: string): EmployeeCaseProjectionDocument
      resume(caseId: string): EmployeeCaseProjectionDocument
    }
    readonly queries: {
      getCase(caseId: string): EmployeeCaseProjectionDocument
      listCases(employeeId?: string, state?: string): string
      listCasePage(input: Parameters<DigitalEmployeeRuntimeService['listCasePage']>[0]): string
      findByExternalSubject(
        subjectType: string,
        subjectRef: string,
      ): EmployeeCaseProjectionDocument | null
    }
    readonly worker: {
      runOneOutbox(): Promise<'completed' | 'retried' | 'idle'>
      pumpOneDelivery(): boolean
      planOneReaction(): string | null
      inspectOneExecution(): Promise<'completed' | 'retried' | 'failed' | 'pending' | 'idle'>
      publishOneChannelResult(): 'completed' | 'idle'
    }
  } | null
}

export interface ComposeDigitalEmployeeOptions {
  readonly db: DbClient
  readonly appHome: string
  readonly typePackages: readonly EmployeeTypePackageRegistration[]
  readonly resourceCatalog?: ToolResourceCatalogPort
  readonly connectionCatalog?: ToolConnectionCatalogPort
  readonly programArtifacts?: ProgramArtifactPort
  readonly inputArtifacts?: EmployeeInputArtifactPort
  readonly fixtureRunner?: WorkContractFixturePort
  readonly runtime?: {
    readonly eventCenter: EventCenterParticipant
    readonly execution: ReactionExecutionPort
    readonly platformWorkItems?: PlatformWorkItemExecutionPort
    readonly codecs: readonly EmployeeTypeRuntimeCodec[]
    readonly workerId?: string
  }
  readonly now?: () => number
  readonly id?: () => string
}

function runtimePackageOf(
  registration: EmployeeTypePackageRegistration,
): EmployeeTypeRuntimePackage {
  const descriptor = employeeTypePackageDescriptorSchema.parse(
    JSON.parse(registration.descriptorJson) as unknown,
  )
  return {
    descriptor,
    parseWorkScope(input) {
      return JSON.parse(registration.parseWorkScopeJson(JSON.stringify(input))) as unknown
    },
    summarizeWorkScope(scope, locale) {
      return registration.summarizeWorkScopeJson(JSON.stringify(scope), locale)
    },
    validateContractFixture(input) {
      return z
        .array(contractValidationCheckSchema)
        .parse(
          JSON.parse(registration.validateContractFixtureJson(JSON.stringify(input))) as unknown,
        )
    },
  }
}

function toolView(
  record: ReturnType<DigitalEmployeeAuthoringService['listTools']>[number],
): ToolRegistrationView {
  return {
    id: record.id,
    typeRef: record.typeRef,
    workItemRef: record.workItemRef,
    content: record.content,
    validationReceipt: record.validationReceipt,
    publishedRevision: record.publishedRevision,
    state:
      record.retiredAt !== null
        ? 'retired'
        : record.publishedRevision === null
          ? 'draft'
          : 'published',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function jobView(
  record: ReturnType<DigitalEmployeeAuthoringService['listJobTemplates']>[number],
): JobTemplateView {
  return {
    id: record.id,
    typeRef: record.typeRef,
    name: record.name,
    draft: record.draft,
    publishedRevision: record.publishedRevision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export function composeDigitalEmployee(
  options: ComposeDigitalEmployeeOptions,
): DigitalEmployeeModule {
  const store = createSqliteDigitalEmployeeAuthoringStore(options.db)
  const inputUploadStore = createEmployeeInputUploadStore(options.db)
  const inputArtifacts =
    options.inputArtifacts ??
    createEmployeeInputArtifactStore(join(options.appHome, 'artifacts', 'employee-inputs'))
  const runtimePackages = options.typePackages.map(runtimePackageOf)
  const service = new DigitalEmployeeAuthoringService({
    store,
    typePackages: runtimePackages,
    resourceCatalog: options.resourceCatalog ?? createToolResourceCatalogAdapter(options.db),
    connectionCatalog: options.connectionCatalog ?? {
      async resolve() {
        return null
      },
    },
    programArtifacts: options.programArtifacts ?? createProgramArtifactStore(options.appHome),
    fixtureRunner:
      options.fixtureRunner ?? createWorkContractFixtureAdapter({ appHome: options.appHome }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.id === undefined ? {} : { id: options.id }),
  })

  const employeeView = (
    record: ReturnType<DigitalEmployeeAuthoringService['getEmployeeDefinition']>,
  ): EmployeeDefinitionView => {
    const published =
      record.publishedRevision === null
        ? null
        : (store.getEmployeeDefinitionRevision({
            id: record.id,
            revision: record.publishedRevision,
          })?.content ?? null)
    return {
      id: record.id,
      name: record.name,
      typeRef: record.typeRef,
      draft: record.draft,
      publishedRevision: record.publishedRevision,
      published,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  const policyView = (): ExecutionPolicyView => {
    const policy = service.getExecutionPolicy()
    return {
      revision: policy.revision,
      content: policy.content,
      contentDigest: policy.contentDigest,
      publishedAt: policy.publishedAt,
    }
  }

  const runtimeService =
    options.runtime === undefined
      ? null
      : new DigitalEmployeeRuntimeService({
          store: createSqliteRuntimeStore(options.db),
          authoringStore: store,
          eventCenter: options.runtime.eventCenter,
          execution: options.runtime.execution,
          platformWorkItems: options.runtime.platformWorkItems ?? {
            async execute(plan) {
              return JSON.stringify({
                schemaVersion: 1,
                roundRef: plan.roundRef,
                executionNonce: plan.executionNonce,
                status: 'blocked',
                summary: `No deterministic platform handler is registered for ${plan.workItemRef}`,
                contextPatches: [],
                effectSuggestions: [],
                artifactRefs: [],
              })
            },
          },
          runtimeCodecs: options.runtime.codecs,
          inputUploads: inputUploadStore,
          inputArtifacts,
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.id === undefined ? {} : { id: options.id }),
          ...(options.runtime.workerId === undefined ? {} : { workerId: options.runtime.workerId }),
        })

  const runtimeDocument = (caseId: string): EmployeeCaseProjectionDocument => {
    if (runtimeService === null) throw new Error('digital employee runtime is not composed')
    const projection = runtimeService.project(caseId)
    return {
      caseRef: { id: projection.case.id, revision: projection.case.revision },
      state: projection.case.state,
      currentWorkItemRef: projection.case.currentWorkItemRef,
      projectionJson: JSON.stringify(projection),
      projectionRevision: projection.case.revision,
    }
  }

  return {
    inputUploads: {
      async create(input) {
        const artifact = await inputArtifacts.putFile(input.absolutePath)
        return inputUploadStore.create({
          actorUserId: input.actorUserId,
          originalName: input.originalName,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          blobRef: artifact.blobRef,
          idempotencyKey: input.idempotencyKey,
          now: options.now?.() ?? Date.now(),
        })
      },
      delete: (uploadRef, actorUserId) => inputUploadStore.delete(uploadRef, actorUserId),
      sweepExpired: () => inputUploadStore.sweepExpired(options.now?.() ?? Date.now()),
    },
    queries: {
      listTypes: () => service.listTypes(),
      getType: (ref) => service.getType(ref),
      getAuthoringManifest: (ref) => service.getAuthoringManifest(ref),
      listTools: (ref, workItemRef) => service.listTools(ref, workItemRef).map(toolView),
      listJobTemplates: (ref) => service.listJobTemplates(ref).map(jobView),
      listEmployees: (ref) => service.listEmployeeDefinitions(ref).map(employeeView),
      getEmployee: (id) => employeeView(service.getEmployeeDefinition(id)),
      getExecutionPolicy: policyView,
      getMigrationStatus: () => analyzeDigitalEmployeeMigration(options.db),
    },
    commands: {
      createTool: async (input) =>
        toolView(
          await service.createTool({
            typeRef: input.typeRef,
            workItemRef: input.workItemRef,
            body: input.body,
            ownerUserId: input.actorUserId,
          }),
        ),
      validateTool: async (input) => toolView(await service.validateTool(input)),
      publishTool: async (input) => (await service.publishTool(input)).ref,
      retireTool: (input) => service.retireTool(input),
      createJobTemplate: (input) =>
        jobView(
          service.createJobTemplate({
            typeRef: input.typeRef,
            body: input.body,
            ownerUserId: input.actorUserId,
          }),
        ),
      updateJobTemplate: (input) => jobView(service.updateJobTemplate(input)),
      publishJobTemplate: (input) => service.publishJobTemplate(input),
      createEmployee: (input) =>
        employeeView(
          service.createEmployeeDefinition({
            typeRef: input.typeRef,
            body: input.body,
            ownerUserId: input.actorUserId,
          }),
        ),
      updateEmployee: (input) => employeeView(service.updateEmployeeDefinition(input)),
      publishEmployee: (input) => service.publishEmployeeDefinition(input),
      publishExecutionPolicy: (input) => {
        service.publishExecutionPolicy(input)
        return policyView()
      },
    },
    runtime:
      runtimeService === null
        ? null
        : {
            commands: {
              launch: (input) => {
                const record = runtimeService.launchCase(input)
                return runtimeDocument(record.id)
              },
              launchWork: (input) => {
                const record = runtimeService.launchWork(input)
                return runtimeDocument(record.id)
              },
              previewPolicyUpgrade: (caseId, targetPolicyRevision) =>
                runtimeService.previewPolicyUpgrade(caseId, targetPolicyRevision),
              applyPolicyUpgrade: (previewToken) => {
                const record = runtimeService.applyPolicyUpgrade(previewToken)
                return runtimeDocument(record.id)
              },
              terminate: (caseId, terminalKind) => {
                const record = runtimeService.terminate(caseId, terminalKind)
                return runtimeDocument(record.id)
              },
              resume: (caseId) => {
                const record = runtimeService.resume(caseId)
                return runtimeDocument(record.id)
              },
            },
            queries: {
              getCase: runtimeDocument,
              listCases: (employeeId, state) =>
                JSON.stringify(runtimeService.listCases(employeeId, state)),
              listCasePage: (input) => JSON.stringify(runtimeService.listCasePage(input)),
              findByExternalSubject: (subjectType, subjectRef) => {
                const record = runtimeService.findCaseByExternalSubject(subjectType, subjectRef)
                return record === null ? null : runtimeDocument(record.id)
              },
            },
            worker: {
              runOneOutbox: () => runtimeService.runOneOutbox(),
              pumpOneDelivery: () => runtimeService.pumpOneDelivery(),
              planOneReaction: () => runtimeService.planOneReaction()?.id ?? null,
              inspectOneExecution: () => runtimeService.inspectOneExecution(),
              publishOneChannelResult: () => runtimeService.publishOneChannelResult(),
            },
          },
  }
}
