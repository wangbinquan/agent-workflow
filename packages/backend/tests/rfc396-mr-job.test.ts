// RFC-396: MR defaults must be runnable without guessing an enterprise connection.
// CI is an explicit pending configuration; the prepared CI job keeps exact tool
// versions and remains editable across daemon restarts until an adapter is chosen.
import { describe, expect, test } from 'bun:test'
import type { DigitalEmployeePlatformToolCatalogParticipant } from '@/modules/digital-employee/public/types'
import {
  buildGraphDeliveryJobs,
  GRAPH_MR_JOB_ID,
  GRAPH_MR_PIPELINE_JOB_ID,
} from '@/modules/development-automation/composition/graphDeliveryJob'
import { composeGraphDeliveryLifecycleTypePackage } from '@/modules/development-automation/composition/graphDeliveryLifecycle'
import { graphEmployeeTypePackage } from '@/modules/development-automation/application/graph-development/employeeType'
import {
  employeeJobTemplateContentSchema,
  employeeTypePackageDescriptorSchema,
  mergeExactAdapterBindings,
  mergeExactToolBindings,
  packageDigest,
} from '@/modules/digital-employee/domain/model'
import { composeBuiltinEmployeeJobs } from '@/modules/digital-employee/composition/builtinJobTemplates'
import { createDigitalEmployeeAuthoringPersistence } from '@/modules/digital-employee/infrastructure/authoringStore'
import { describeEachProvider } from './helpers/eachProvider'

const routes = [
  { routeRef: 'compile-error', displayName: '编译失败', description: '修复编译', fallback: false },
  {
    routeRef: 'unknown-failure',
    displayName: '其他失败',
    description: '诊断其他失败',
    fallback: true,
  },
]
function catalog(missing: readonly string[] = []): DigitalEmployeePlatformToolCatalogParticipant {
  return {
    listJson(typeRefJson, item) {
      const typeRef = JSON.parse(typeRefJson)
      if (
        typeRef.typeId !== 'graph-development' ||
        typeRef.revision !== 2 ||
        missing.includes(item)
      )
        return '[]'
      return JSON.stringify([
        { id: `retired:${item}`, publishedRevision: 6, selection: 'retired', content: {} },
        {
          id: `tool:${item}`,
          publishedRevision: 7,
          selection: 'selectable',
          content: {
            typeRef,
            workItemRef: item,
            ...(item === 'classify-pipeline' ? { dispatchRouteDefinitions: routes } : {}),
            ...(item === 'repair-pipeline'
              ? {
                  acceptedDispatchRoutes: [
                    { classifierWorkItemRef: 'classify-pipeline', routeRefs: ['*'] },
                  ],
                }
              : {}),
          },
        },
      ])
    },
    getRevisionJson() {
      return null
    },
    isPlatformTool() {
      return true
    },
  }
}
const descriptor = () =>
  employeeTypePackageDescriptorSchema.parse(
    JSON.parse(composeGraphDeliveryLifecycleTypePackage(graphEmployeeTypePackage).descriptorJson),
  )
const basicItems = [
  'design-and-clarify',
  'review-design',
  'implement-change',
  'repair-feedback',
  'repair-conflict',
]

describe('graph MR job defaults', () => {
  test('default selects exact graph/review/conflict tools and states that CI needs configuration', () => {
    const jobs = buildGraphDeliveryJobs({ catalog: catalog() })
    expect(jobs.defaultJob.id).toBe(GRAPH_MR_JOB_ID)
    const content = employeeJobTemplateContentSchema.parse(jobs.defaultJob.content)
    expect(content.typeRef).toEqual({ typeId: 'graph-development', revision: 2 })
    expect(content.defaultToolBindings.map((binding) => binding.workItemRef)).toEqual(basicItems)
    expect(
      content.defaultToolBindings.every((binding) => binding.registrationRef.revision === 7),
    ).toBe(true)
    expect(content.defaultAdapterBindings).toEqual([])
    expect(content.description).toContain('流水线连接待配置')
    expect(
      mergeExactToolBindings({
        manifest: descriptor().authoringManifest,
        defaults: content.defaultToolBindings,
        overrides: [],
        enabledWorkItemRefs: basicItems,
      }).violations,
    ).toEqual([])
    expect(
      mergeExactAdapterBindings({
        manifest: descriptor().authoringManifest,
        defaults: [],
        overrides: [],
        enabledWorkItemRefs: basicItems,
      }).violations,
    ).toEqual([])
  })

  test('CI draft contains actual classifier routes and compatible repair refs but cannot publish without an adapter', () => {
    const jobs = buildGraphDeliveryJobs({ catalog: catalog() })
    expect(jobs.pipelineJobDraft.id).toBe(GRAPH_MR_PIPELINE_JOB_ID)
    const draft = employeeJobTemplateContentSchema.parse(jobs.pipelineJobDraft.content)
    expect(draft.defaultToolBindings.map((binding) => binding.workItemRef)).toEqual([
      ...basicItems,
      'classify-pipeline',
    ])
    expect(draft.orderedDispatchConfigurations[0]?.routes).toEqual(
      routes.map((route) => ({
        ...route,
        destinationWorkItemRef: 'repair-pipeline',
        registrationRef: { id: 'tool:repair-pipeline', revision: 7 },
      })),
    )
    expect(jobs.requiredConfiguration).toEqual([
      expect.objectContaining({
        laneId: 'care-pipeline',
        slotRef: 'primary',
        purpose: 'pipeline-gate',
      }),
    ])
    expect(
      mergeExactAdapterBindings({
        manifest: descriptor().authoringManifest,
        defaults: draft.defaultAdapterBindings,
        overrides: [],
        enabledWorkItemRefs: ['collect-pipeline'],
      }).violations,
    ).toEqual([expect.objectContaining({ code: 'required-lane-adapter-binding-missing' })])
    const url = new URL(jobs.configurationHref, 'http://localhost')
    expect(url.pathname).toBe('/digital-employees/graph-development%402')
    expect(url.searchParams.get('view')).toBe('jobs')
    expect(url.searchParams.get('jobTemplateId')).toBe(GRAPH_MR_PIPELINE_JOB_ID)
    expect(url.searchParams.get('workItem')).toBe('collect-pipeline')
  })

  test('only an explicitly supplied exact pipeline adapter fills the required connection', () => {
    const jobs = buildGraphDeliveryJobs({
      catalog: catalog(),
      pipelineAdapterRef: { id: 'chosen-pipeline', revision: 3 },
    })
    expect(jobs.requiredConfiguration).toEqual([])
    const draft = employeeJobTemplateContentSchema.parse(jobs.pipelineJobDraft.content)
    expect(draft.defaultAdapterBindings).toEqual([
      {
        laneId: 'care-pipeline',
        slotRef: 'primary',
        adapterRef: { id: 'chosen-pipeline', revision: 3 },
      },
    ])
    expect(jobs.defaultJob.content.defaultAdapterBindings).toEqual([])
  })

  test('missing tools do not silently reduce promised repair capabilities', () => {
    expect(() => buildGraphDeliveryJobs({ catalog: catalog(['repair-feedback']) })).toThrow(
      'graph-mr-job-tool-missing:repair-feedback',
    )
    expect(() => buildGraphDeliveryJobs({ catalog: catalog(['classify-pipeline']) })).toThrow(
      'graph-mr-job-tool-missing:classify-pipeline',
    )
  })

  test('graph v2 names MR source and target separately without changing v1 intake', () => {
    const original = JSON.parse(graphEmployeeTypePackage.descriptorJson)
    const composed = descriptor()
    expect(
      composed.workIntakeAuthoring?.advancedOptions.find(
        (item) => item.optionRef === 'publication-branch',
      )?.label['zh-CN'],
    ).toBe('MR 源分支')
    expect(
      composed.workIntakeAuthoring?.advancedOptions.find(
        (item) => item.optionRef === 'working-branch',
      )?.label['zh-CN'],
    ).toBe('MR 目标分支')
    expect(JSON.parse(graphEmployeeTypePackage.descriptorJson)).toEqual(original)
    expect(original.workIntakeAuthoring.advancedOptions[0].label['zh-CN']).toBe(
      '验证通过后发布到分支',
    )
  })
})

describeEachProvider('graph CI setup draft survives restart', (harness) => {
  test('seeds an unpublished editable draft once and preserves the configured content', async () => {
    const store = createDigitalEmployeeAuthoringPersistence(harness.db)
    const type = descriptor()
    await store.ensureTypePackage({
      descriptor: type,
      descriptorDigest: packageDigest(type),
      state: 'published',
      registeredAt: 1,
    })
    let published = false
    const builtins = composeBuiltinEmployeeJobs(harness.db, async () => {
      published = true
      throw new Error('setup draft must not publish before configuration')
    })
    const job = buildGraphDeliveryJobs({ catalog: catalog() }).pipelineJobDraft
    await builtins.ensureDraft(job)
    const initial = await store.getJobTemplate(job.id)
    expect(initial?.publishedRevision).toBeNull()
    expect(initial?.visibility).toBe('public')
    const configured = employeeJobTemplateContentSchema.parse({
      ...initial!.draft,
      description: '已经选择团队实际流水线',
      defaultAdapterBindings: [
        {
          laneId: 'care-pipeline',
          slotRef: 'primary',
          adapterRef: { id: 'team-pipeline', revision: 4 },
        },
      ],
    })
    await store.updateJobTemplate(job.id, '团队图研发', configured, 2)
    await builtins.ensureDraft(job)
    const restarted = await store.getJobTemplate(job.id)
    expect(restarted?.name).toBe('团队图研发')
    expect(restarted?.draft).toEqual(configured)
    expect(published).toBe(false)
  })
})
