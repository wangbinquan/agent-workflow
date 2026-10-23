import { z } from 'zod'
import type {
  EmployeeTypeCollaborationCodec,
  EmployeeTypeContextCodec,
  EmployeeTypePackageRegistration,
  EmployeeTypeReactionCodec,
} from '@/modules/digital-employee/public/types'
import { isMergeRequestLifecycleWorkItem } from '../domain/mergeRequestLifecycle'
import {
  developmentEmployeeTypePackage,
  issueHandlingContextSchema,
  mergeRequestLifecycleDescriptor,
  mergeRequestLifecycleRuntimeCodec,
} from './employeeTypePackage'

type RuntimeCodec = EmployeeTypeContextCodec &
  EmployeeTypeReactionCodec &
  EmployeeTypeCollaborationCodec

const recordSchema = z.record(z.string(), z.unknown())
const coreDescriptorSchema = z
  .object({
    typeRef: z.object({ typeId: z.literal('graph-development'), revision: z.number() }),
    workIntakeAuthoring: z
      .object({ advancedOptions: z.array(z.object({ optionRef: z.string() }).passthrough()) })
      .passthrough(),
    workContracts: z.array(recordSchema),
    authoringManifest: z
      .object({
        lifecycleRegions: z.array(recordSchema),
        workItems: z.array(
          z
            .object({
              workItemRef: z.string(),
              regionId: z.string(),
              responsibilityLaneId: z.string(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
    contextTypes: z.array(recordSchema),
    eventSources: z.array(recordSchema),
    eventTypes: z.array(recordSchema),
    attentionRules: z.array(recordSchema),
    reactionRules: z.array(recordSchema),
    invocationContracts: z.array(recordSchema),
  })
  .passthrough()

export const GRAPH_DELIVERY_EMPLOYEE_TYPE = { typeId: 'graph-development', revision: 2 } as const

/** Compose the new immutable type revision while keeping graph@1 registered unchanged. */
export function composeGraphDeliveryLifecycleTypePackage(
  core: EmployeeTypePackageRegistration,
): EmployeeTypePackageRegistration {
  const descriptor = coreDescriptorSchema.parse(JSON.parse(core.descriptorJson))
  const shared = mergeRequestLifecycleDescriptor
  const delivery = descriptor.authoringManifest.workItems.find(
    (item) => item.workItemRef === 'deliver-result',
  )
  if (!delivery) throw new Error('graph-delivery-work-item-missing')
  const description = {
    'zh-CN':
      '按需求自适应组织业务视图，完成澄清、审核、代码与验证，并持续处理 MR、检视意见、流水线、冲突和审批，直到外部合入或关闭。',
    'en-US':
      'Adapt business views to each request, clarify, review, implement and verify, then care for the merge request, feedback, pipelines, conflicts and approval until external merge or close.',
  }
  return {
    ...core,
    descriptorJson: JSON.stringify({
      ...descriptor,
      typeRef: GRAPH_DELIVERY_EMPLOYEE_TYPE,
      description,
      workIntakeAuthoring: {
        ...descriptor.workIntakeAuthoring,
        advancedOptions: descriptor.workIntakeAuthoring.advancedOptions.map((option) =>
          option.optionRef === 'publication-branch'
            ? {
                ...option,
                label: { 'zh-CN': 'MR 源分支', 'en-US': 'MR source branch' },
                description: {
                  'zh-CN':
                    '留空由平台为此项工作生成源分支；必须与 MR 目标分支不同。验证通过后提交 MR 并持续看护。',
                  'en-US':
                    'Leave empty for a platform-generated source branch. It must differ from the MR target branch. Verified changes enter MR delivery and care.',
                },
              }
            : option.optionRef === 'working-branch'
              ? {
                  ...option,
                  label: { 'zh-CN': 'MR 目标分支', 'en-US': 'MR target branch' },
                  description: {
                    'zh-CN': '图设计的仓库基线与 MR 合入目标；留空使用仓库默认分支。',
                    'en-US':
                      'Repository baseline and merge target for the design. Leave empty for the default branch.',
                  },
                }
              : option,
        ),
      },
      workContracts: [...descriptor.workContracts, ...shared.workContracts],
      authoringManifest: {
        ...descriptor.authoringManifest,
        lifecycleRegions: [
          ...descriptor.authoringManifest.lifecycleRegions,
          ...shared.lifecycleRegions,
        ],
        workItems: [
          ...descriptor.authoringManifest.workItems.map((item) =>
            item.workItemRef === 'deliver-result'
              ? { ...item, nextWorkItemRefs: ['publish-mr'] }
              : item,
          ),
          ...shared.workItems.map((item) =>
            item.regionId === 'delivery'
              ? {
                  ...item,
                  regionId: delivery.regionId,
                  responsibilityLaneId: delivery.responsibilityLaneId,
                  order: item.order + 100,
                }
              : item,
          ),
        ],
      },
      contextTypes: [...descriptor.contextTypes, ...shared.contextTypes],
      eventSources: [...descriptor.eventSources, ...shared.eventSources],
      eventTypes: [...descriptor.eventTypes, ...shared.eventTypes],
      attentionRules: [...descriptor.attentionRules, ...shared.attentionRules],
      reactionRules: [...descriptor.reactionRules, ...shared.reactionRules],
      invocationContracts: [...descriptor.invocationContracts, ...shared.invocationContracts],
    }),
    validateContractFixtureJson(json) {
      const request = z
        .object({ contract: z.object({ contractId: z.string() }).passthrough() })
        .passthrough()
        .parse(JSON.parse(json))
      return request.contract.contractId.startsWith('graph-development.')
        ? core.validateContractFixtureJson(json)
        : developmentEmployeeTypePackage.validateContractFixtureJson(json)
    },
  }
}

const typeRefSchema = z
  .object({ typeId: z.string(), revision: z.number().int().positive() })
  .strict()
const initialRequestSchema = z.object({ employeeTypeRef: typeRefSchema.optional() }).passthrough()
const launchSchema = z
  .object({ primaryContextTypeId: z.string(), primaryContextJson: z.string() })
  .passthrough()

/**
 * Graph retains its identity, design context and core work. The named shared
 * lifecycle receives care work and development.* contexts only.
 */
export function composeGraphDeliveryLifecycleRuntimeCodec(core: RuntimeCodec): RuntimeCodec {
  const shared = mergeRequestLifecycleRuntimeCodec
  const isCoreContext = (typeId: string) => typeId.startsWith('graph-development.')
  const select = (json: string): RuntimeCodec | typeof shared => {
    const request = z.object({ workItemRef: z.string() }).passthrough().parse(JSON.parse(json))
    return isMergeRequestLifecycleWorkItem(request.workItemRef) ? shared : core
  }
  const buildInitialCaseJson = (json: string): string => {
    const request = initialRequestSchema.parse(JSON.parse(json))
    const result = core.buildInitialCaseJson(json)
    if (
      request.employeeTypeRef?.typeId !== GRAPH_DELIVERY_EMPLOYEE_TYPE.typeId ||
      request.employeeTypeRef.revision < GRAPH_DELIVERY_EMPLOYEE_TYPE.revision
    )
      return result
    const launch = launchSchema.parse(JSON.parse(result))
    const context = z
      .object({ request: recordSchema })
      .passthrough()
      .parse(JSON.parse(launch.primaryContextJson))
    return JSON.stringify({
      ...launch,
      primaryContextJson: core.validateContextJson(
        launch.primaryContextTypeId,
        JSON.stringify({
          ...context,
          request: { ...context.request, deliveryMode: 'merge-request' },
        }),
      ),
    })
  }
  return {
    typeId: core.typeId,
    buildInitialCaseJson,
    validateContextJson(typeId, json) {
      return (isCoreContext(typeId) ? core : shared).validateContextJson(typeId, json)
    },
    resolveExternalSubjectBindingsJson(typeId, json) {
      return isCoreContext(typeId)
        ? (core.resolveExternalSubjectBindingsJson?.(typeId, json) ?? '[]')
        : shared.resolveExternalSubjectBindingsJson(typeId, json)
    },
    resolveAttentionSubjectsJson(typeId, json) {
      return (isCoreContext(typeId) ? core : shared).resolveAttentionSubjectsJson(typeId, json)
    },
    selectReactionToolSlotJson: (json) => select(json).selectReactionToolSlotJson(json),
    assembleReactionInputJson: (json) => select(json).assembleReactionInputJson(json),
    validateReactionOutputJson: (json) => select(json).validateReactionOutputJson(json),
    resolveReactionSettlementJson: (json) => select(json).resolveReactionSettlementJson(json),
    buildInvokedCaseJson(json) {
      const request = z
        .object({
          caseRef: z.string().min(1),
          employeeTypeRef: typeRefSchema,
          targetEmployeeRef: z.object({ id: z.string(), revision: z.number() }),
          targetWorkScopeJson: z.string(),
          receivedAt: z.number(),
        })
        .passthrough()
        .parse(JSON.parse(json))
      if (request.employeeTypeRef.revision < GRAPH_DELIVERY_EMPLOYEE_TYPE.revision)
        return core.buildInvokedCaseJson(json)
      const delegated = launchSchema.parse(JSON.parse(shared.buildInvokedCaseJson(json)))
      const issue = issueHandlingContextSchema.parse(JSON.parse(delegated.primaryContextJson))
      return buildInitialCaseJson(
        JSON.stringify({
          schemaVersion: 1,
          caseRef: request.caseRef,
          employeeTypeRef: request.employeeTypeRef,
          employeeRef: request.targetEmployeeRef,
          workScopeJson: request.targetWorkScopeJson,
          receivedAt: request.receivedAt,
          intake: {
            kind: 'body',
            target: { repositoryId: issue.repositoryRef },
            body: issue.request.body,
            typeOptions: {},
            uploads: [],
          },
        }),
      )
    },
    buildInvocationStartedOutputJson: shared.buildInvocationStartedOutputJson,
    buildInvocationResultOutputJson: shared.buildInvocationResultOutputJson,
  }
}
