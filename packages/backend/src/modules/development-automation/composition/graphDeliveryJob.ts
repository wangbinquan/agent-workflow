import { z } from 'zod'
import type { DigitalEmployeePlatformToolCatalogParticipant } from '@/modules/digital-employee/public/types'
import { GRAPH_DELIVERY_EMPLOYEE_TYPE } from './graphDeliveryLifecycle'

export const GRAPH_MR_JOB_ID = 'platform:graph-development:job:mr-v1'
export const GRAPH_MR_PIPELINE_JOB_ID = 'platform:graph-development:job:mr-ci-v1'
const exactRef = z.object({ id: z.string().min(1), revision: z.number().int().positive() }).strict()
const routeSchema = z
  .object({
    routeRef: z.string().min(1),
    displayName: z.string().min(1),
    description: z.string(),
    fallback: z.boolean(),
  })
  .strict()
const catalogToolSchema = z
  .object({
    id: z.string().min(1),
    publishedRevision: z.number().int().positive().nullable(),
    selection: z.string(),
    content: z
      .object({
        typeRef: z.object({ typeId: z.string(), revision: z.number() }).optional(),
        workItemRef: z.string().optional(),
        dispatchRouteDefinitions: z.array(routeSchema).optional(),
        acceptedDispatchRoutes: z
          .array(
            z
              .object({
                classifierWorkItemRef: z.string(),
                routeRefs: z.array(z.string()),
              })
              .strict(),
          )
          .optional(),
      })
      .passthrough(),
  })
  .passthrough()

/** Exact tools are provided by the loaded catalog; no enterprise connection is guessed. */
export function buildGraphDeliveryJobs(input: {
  readonly catalog: Pick<DigitalEmployeePlatformToolCatalogParticipant, 'listJson'>
  readonly pipelineAdapterRef?: { readonly id: string; readonly revision: number }
}) {
  const typeRef = GRAPH_DELIVERY_EMPLOYEE_TYPE
  const toolsFor = (workItemRef: string) =>
    z
      .array(catalogToolSchema)
      .parse(JSON.parse(input.catalog.listJson(JSON.stringify(typeRef), workItemRef)))
      .filter(
        (tool) =>
          tool.selection === 'selectable' &&
          tool.publishedRevision !== null &&
          tool.content.typeRef?.typeId === typeRef.typeId &&
          tool.content.typeRef.revision === typeRef.revision &&
          tool.content.workItemRef === workItemRef,
      )
      .sort((a, b) => a.id.localeCompare(b.id))
  function toolFor(workItemRef: string) {
    const tool = toolsFor(workItemRef)[0]
    if (!tool) throw new Error(`graph-mr-job-tool-missing:${workItemRef}`)
    return tool
  }
  const reference = (tool: z.infer<typeof catalogToolSchema>) =>
    exactRef.parse({ id: tool.id, revision: tool.publishedRevision })
  const binding = (workItemRef: string) => ({
    workItemRef,
    slotRef: 'default',
    registrationRef: reference(toolFor(workItemRef)),
  })
  const base = {
    schemaVersion: 1 as const,
    typeRef,
    defaultToolBindings: [
      'design-and-clarify',
      'review-design',
      'implement-change',
      'repair-feedback',
      'repair-conflict',
    ].map(binding),
    defaultAdapterBindings: [] as {
      laneId: string
      slotRef: string
      adapterRef: { id: string; revision: number }
    }[],
    defaultCollaborationBindings: [],
    orderedDispatchConfigurations: [] as {
      classifierWorkItemRef: string
      routes: {
        routeRef: string
        displayName: string
        description: string
        fallback: boolean
        destinationWorkItemRef: string
        registrationRef: { id: string; revision: number }
      }[]
    }[],
    reactionLaneOrder: [],
  }
  const classifier = toolFor('classify-pipeline')
  const routes = classifier.content.dispatchRouteDefinitions
  if (!routes?.length || routes.filter((route) => route.fallback).length !== 1)
    throw new Error('graph-mr-job-classifier-routes-missing')
  const repairers = toolsFor('repair-pipeline')
  const configuredRoutes = routes.map((route) => {
    const repairer = repairers.find((tool) =>
      tool.content.acceptedDispatchRoutes?.some(
        (accepted) =>
          accepted.classifierWorkItemRef === 'classify-pipeline' &&
          (accepted.routeRefs.includes('*') || accepted.routeRefs.includes(route.routeRef)),
      ),
    )
    if (!repairer) throw new Error(`graph-mr-job-repair-route-missing:${route.routeRef}`)
    return {
      ...route,
      destinationWorkItemRef: 'repair-pipeline',
      registrationRef: reference(repairer),
    }
  })
  const pipelineAdapterRef = input.pipelineAdapterRef
    ? exactRef.parse(input.pipelineAdapterRef)
    : null
  const configurationHref = `/digital-employees/${encodeURIComponent('graph-development@2')}?${new URLSearchParams(
    {
      view: 'jobs',
      jobTemplateId: GRAPH_MR_PIPELINE_JOB_ID,
      workItem: 'collect-pipeline',
    },
  )}`
  return {
    defaultJob: {
      id: GRAPH_MR_JOB_ID,
      name: '图驱动研发 · MR 交付与看护',
      content: {
        ...base,
        description:
          '自适应图设计、澄清、审核、实现与独立验证后提交 MR，持续处理评审意见、冲突和外部合入/关闭。企业流水线连接待配置；未配置不表示 CI 通过。需要 CI 自动修复时配置“完整 MR 看护”岗位；审批和员工协同可按需配置。',
      },
    },
    pipelineJobDraft: {
      id: GRAPH_MR_PIPELINE_JOB_ID,
      name: '图驱动研发 · 完整 MR 看护（配置流水线连接）',
      content: {
        ...base,
        description: pipelineAdapterRef
          ? '图设计到 MR 持续交付：评审、流水线失败分类与修复、冲突处理和外部终态跟踪。发布前核对选定的企业流水线连接；审批与协同按需另行配置。'
          : '工具与失败分类已准备。请在“流水线门禁”职责中选择企业流水线连接的准确版本，再保存并发布此岗位。发布后可创建具备 CI 跟踪与修复的图研发数字人；外部审批和员工协同可在相应职责继续配置。',
        defaultToolBindings: [
          ...base.defaultToolBindings,
          {
            workItemRef: 'classify-pipeline',
            slotRef: 'default',
            registrationRef: reference(classifier),
          },
        ],
        defaultAdapterBindings: pipelineAdapterRef
          ? [{ laneId: 'care-pipeline', slotRef: 'primary', adapterRef: pipelineAdapterRef }]
          : [],
        orderedDispatchConfigurations: [
          { classifierWorkItemRef: 'classify-pipeline', routes: configuredRoutes },
        ],
      },
    },
    configurationHref,
    requiredConfiguration: pipelineAdapterRef
      ? []
      : [
          {
            laneId: 'care-pipeline',
            slotRef: 'primary',
            purpose: 'pipeline-gate',
            label: '企业流水线连接',
            href: configurationHref,
          },
        ],
  }
}
