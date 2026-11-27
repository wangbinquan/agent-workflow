// Regression guard (RFC-628): a digital employee preempted by an event before it posts "reply with
// repair result" still posts that reply afterwards.
//
// 2026-11-27, a real case on GitLab (recorded in design/RFC-616-process-metrics/plan.md §4.7): the
// employee pushed its review repair and its next step was "reply with repair result". Reading the
// merge request facts collided with the head moving and blocked the step; commit 033f5fafe fixed that
// first half (the read collects again). After the case was resumed, an event that declares preemption
// took the round instead and the prepared reply was never posted. RFC-628 fixes that second half in a
// new type revision, and graph-development shares the development MR care, so it moves to revision 3.
//
// A type bump is only safe when existing employees follow it (design §3.6): graph@2 employees and jobs
// are bound to the `type-v2:` built-in graph tools, so the graph catalog has to publish `type-v3:`
// twins and answer the upgrade mapping, and the composed daemon catalog has to ask it; otherwise the
// employee stays on @2 and cannot start new work. The built-in MR jobs also change their identifier
// and their name, because the migrated copy of the old built-in job keeps the old name in @3 and a
// same-name seed would stop the daemon. This file locks design §6 J1 and J2.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { composeDigitalEmployee } from '@/modules/digital-employee/composition'
import { composeBuiltinEmployeeJobs } from '@/modules/digital-employee/composition/builtinJobTemplates'
import type { EmployeeTypePackageRegistration } from '@/modules/digital-employee/public/types'
import { graphEmployeeTypePackage } from '@/modules/development-automation/application/graph-development/employeeType'
import {
  GRAPH_MR_JOB_ID,
  GRAPH_MR_PIPELINE_JOB_ID,
} from '@/modules/development-automation/application/graph-development/deliveryJobs'
import {
  composeGraphDeliveryLifecycleTypePackage,
  GRAPH_DELIVERY_EMPLOYEE_TYPE,
} from '@/modules/development-automation/composition/graphDeliveryLifecycle'
import { ensureDigitalEmployeeAgentTemplates } from '@/modules/development-automation/application/digitalEmployeeAgentTemplates'
import { describeEachProvider } from './helpers/eachProvider'
import { employeeAutomationFixture } from './helpers/daemonEmployeeAutomationBundle'
import { standaloneDigitalEmployeeSelections } from './helpers/digitalEmployeeSelections'

const GRAPH_TWO = { typeId: 'graph-development', revision: 2 } as const
const GRAPH_THREE = { typeId: 'graph-development', revision: 3 } as const
const GRAPH_TOOL_ITEMS = ['design-and-clarify', 'review-design', 'implement-change'] as const

interface CatalogTool {
  readonly id: string
  readonly publishedRevision: number | null
  readonly selection: string
  readonly content: {
    readonly typeRef?: { readonly typeId: string; readonly revision: number }
    readonly workItemRef?: string
  }
}
const list = (
  catalog: { listJson(typeRefJson: string, workItemRef: string): string },
  typeRef: { readonly typeId: string; readonly revision: number },
  workItemRef: string,
) => JSON.parse(catalog.listJson(JSON.stringify(typeRef), workItemRef)) as CatalogTool[]

/**
 * graph-development@2 exactly as the previous build registered it: the current composed package
 * with the earlier revision and the earlier observe-mr / observe-approval successors. The build no
 * longer contains a @2 descriptor, so the history a deployment upgrades from is reconstructed here.
 */
function graphTwoPackage(): EmployeeTypePackageRegistration {
  const current = composeGraphDeliveryLifecycleTypePackage(graphEmployeeTypePackage)
  const descriptor = JSON.parse(current.descriptorJson) as {
    typeRef: { typeId: string; revision: number }
    authoringManifest: { workItems: Array<{ workItemRef: string; nextWorkItemRefs: string[] }> }
  }
  descriptor.typeRef = { ...GRAPH_TWO }
  for (const item of descriptor.authoringManifest.workItems) {
    if (item.workItemRef === 'observe-mr')
      item.nextWorkItemRefs = [
        'classify-feedback',
        'collect-pipeline',
        'repair-conflict',
        'prepare-approval',
        'evaluate-ready',
      ]
    if (item.workItemRef === 'observe-approval') item.nextWorkItemRefs = ['observe-mr']
  }
  return { ...current, descriptorJson: JSON.stringify(descriptor) }
}

describeEachProvider('RFC-628 graph-development@3 built-in catalog and upgrade', (harness) => {
  const homes: string[] = []
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })
  const freshHome = () => {
    const home = mkdtempSync(join(tmpdir(), 'rfc628-graph-'))
    homes.push(home)
    return home
  }

  test('J1 the graph catalog lists type-v3 tools, maps type-v2 to them, and the daemon catalog asks it first', async () => {
    const f = employeeAutomationFixture(harness, freshHome())
    await f.employee.platformTools.load()
    expect(GRAPH_DELIVERY_EMPLOYEE_TYPE).toEqual(GRAPH_THREE)
    for (const item of GRAPH_TOOL_ITEMS) {
      const three = list(f.employee.platformTools, GRAPH_THREE, item).filter((tool) =>
        tool.id.startsWith('platform:graph-development:'),
      )
      expect(three.length).toBeGreaterThan(0)
      for (const tool of three) {
        expect(tool.id.startsWith('platform:graph-development:type-v3:')).toBe(true)
        expect(tool.content.typeRef).toEqual(GRAPH_THREE)
        expect(tool.content.workItemRef).toBe(item)
      }
      const two = list(f.employee.platformTools, GRAPH_TWO, item).filter((tool) =>
        tool.id.startsWith('platform:graph-development:'),
      )
      expect(two.length).toBeGreaterThan(0)
      for (const tool of two) {
        expect(tool.id.startsWith('platform:graph-development:type-v2:')).toBe(true)
        expect(tool.content.typeRef).toEqual(GRAPH_TWO)
      }

      const source = two[0]!
      const sourceRef = { id: source.id, revision: source.publishedRevision! }
      const resolved = f.employee.platformTools.resolveCompatibleRevisionJson!(
        JSON.stringify(sourceRef),
        JSON.stringify(GRAPH_THREE),
        item,
      )
      expect(resolved).not.toBeNull()
      const successor = JSON.parse(resolved!) as {
        ref: { id: string; revision: number }
        content: { typeRef: unknown; workItemRef: string }
        state: string
      }
      expect(successor.ref.id).toBe(source.id.replace(':type-v2:', ':type-v3:'))
      expect(successor.content).toMatchObject({ typeRef: GRAPH_THREE, workItemRef: item })
      expect(successor.state).toBe('published')
      // The successor is an ordinary published revision of the catalog.
      expect(f.employee.platformTools.getRevisionJson(JSON.stringify(successor.ref))).not.toBeNull()

      // No mapping for another work item, another target revision or a source that is not type-v2.
      const other = GRAPH_TOOL_ITEMS.find((candidate) => candidate !== item)!
      expect(
        f.employee.platformTools.resolveCompatibleRevisionJson!(
          JSON.stringify(sourceRef),
          JSON.stringify(GRAPH_THREE),
          other,
        ),
      ).toBeNull()
      expect(
        f.employee.platformTools.resolveCompatibleRevisionJson!(
          JSON.stringify(sourceRef),
          JSON.stringify(GRAPH_TWO),
          item,
        ),
      ).toBeNull()
      expect(
        f.employee.platformTools.resolveCompatibleRevisionJson!(
          JSON.stringify(successor.ref),
          JSON.stringify(GRAPH_THREE),
          item,
        ),
      ).toBeNull()
    }
    // The MR care business tools of @3 come from the shared built-in catalog by descriptor.
    for (const item of ['repair-feedback', 'repair-conflict']) {
      expect(
        list(f.employee.platformTools, GRAPH_THREE, item).some(
          (tool) => tool.selection === 'selectable' && tool.publishedRevision !== null,
        ),
      ).toBe(true)
    }
  }, 60_000)

  test('J2 a graph@2 employee on the old built-in MR job upgrades to @3 at boot without a job-name conflict', async () => {
    const home = freshHome()
    const db = harness.db
    // The previous build: graph@1 and graph@2 registered (no platform tools needed for that).
    await composeDigitalEmployee({
      ...standaloneDigitalEmployeeSelections({ db, appHome: home }),
      db,
      appHome: home,
      typePackages: [graphEmployeeTypePackage, graphTwoPackage()],
      executionContracts: employeeAutomationFixture(harness, home).employee.executionContracts,
    }).maintenance.ready()

    // The previous build seeded its built-in MR job on @2 and an employee was created from it.
    const previous = employeeAutomationFixture(harness, home)
    await ensureDigitalEmployeeAgentTemplates(
      previous.tasks.resourceCatalog.digitalEmployeeAgentTemplates,
    )
    await previous.employee.platformTools.load()
    const previousModule = composeDigitalEmployee({
      ...standaloneDigitalEmployeeSelections({ db, appHome: home }),
      db,
      appHome: home,
      typePackages: [graphEmployeeTypePackage, graphTwoPackage()],
      executionContracts: previous.employee.executionContracts,
      platformTools: previous.employee.platformTools,
    })
    await previousModule.maintenance.ready()
    const binding = (workItemRef: string) => {
      const tool = list(previous.employee.platformTools, GRAPH_TWO, workItemRef)
        .filter(
          (candidate) =>
            candidate.selection === 'selectable' &&
            candidate.publishedRevision !== null &&
            candidate.content.typeRef?.typeId === GRAPH_TWO.typeId &&
            candidate.content.typeRef.revision === GRAPH_TWO.revision &&
            candidate.content.workItemRef === workItemRef,
        )
        .sort((left, right) => left.id.localeCompare(right.id))[0]
      if (tool === undefined) throw new Error(`graph@2 tool missing: ${workItemRef}`)
      return {
        workItemRef,
        slotRef: 'default',
        registrationRef: { id: tool.id, revision: tool.publishedRevision! },
      }
    }
    const legacyJobId = 'platform:graph-development:job:mr-v1'
    const legacyJobName = '图驱动研发 · MR 交付与看护'
    const legacyJobRef = await composeBuiltinEmployeeJobs(db, (request) =>
      previousModule.commands.publishJobTemplate(request),
    ).ensure({
      id: legacyJobId,
      name: legacyJobName,
      content: {
        schemaVersion: 1,
        typeRef: GRAPH_TWO,
        description: 'graph@2 built-in MR delivery job as the previous build seeded it',
        defaultToolBindings: [
          'design-and-clarify',
          'review-design',
          'implement-change',
          'repair-feedback',
          'repair-conflict',
        ].map(binding),
        defaultAdapterBindings: [],
        defaultCollaborationBindings: [],
        orderedDispatchConfigurations: [],
        reactionLaneOrder: [],
      },
    })
    const employee = await previousModule.commands.createEmployee({
      typeRef: GRAPH_TWO,
      actorUserId: null,
      body: {
        name: 'graph@2 MR employee',
        jobTemplateRef: legacyJobRef,
        workScope: { kind: 'task' },
        toolOverrides: [],
      },
    })
    expect(employee.typeRef).toEqual(GRAPH_TWO)

    // This build boots in daemon order: catalog, automatic upgrade, then the graph seed.
    const current = employeeAutomationFixture(harness, home)
    const module = current.employee.module
    await ensureDigitalEmployeeAgentTemplates(
      current.tasks.resourceCatalog.digitalEmployeeAgentTemplates,
    )
    await current.employee.platformTools.load()
    await module.maintenance.ready()
    await current.employee.initializeGraph()
    await current.employeeInput.integration.eventCenter.initialize()

    expect(GRAPH_MR_JOB_ID).toBe('platform:graph-development:job:mr-v2')
    expect(GRAPH_MR_PIPELINE_JOB_ID).toBe('platform:graph-development:job:mr-ci-v2')
    expect(await module.queries.getEmployee(employee.id)).toMatchObject({
      id: employee.id,
      typeRef: GRAPH_THREE,
    })
    const jobs = await module.queries.listJobTemplates(GRAPH_THREE)
    // The migrated copy of the old built-in job keeps its name for the upgraded employee …
    expect(
      jobs.some(
        (job) =>
          job.name === legacyJobName &&
          job.id !== GRAPH_MR_JOB_ID &&
          job.publishedRevision !== null,
      ),
    ).toBe(true)
    // … next to the new built-in jobs with their new identifiers and names.
    expect(jobs.find((job) => job.id === GRAPH_MR_JOB_ID)).toMatchObject({
      name: '图驱动研发 · MR 交付与看护（v2）',
    })
    expect(jobs.find((job) => job.id === GRAPH_MR_JOB_ID)?.publishedRevision).not.toBeNull()
    expect(jobs.find((job) => job.id === GRAPH_MR_PIPELINE_JOB_ID)).toMatchObject({
      name: '图驱动研发 · 完整 MR 看护（v2，配置流水线连接）',
    })
    // The old built-in job stays as @2 history.
    expect(
      (await module.queries.listJobTemplates(GRAPH_TWO)).find((job) => job.id === legacyJobId),
    ).toBeDefined()

    // The upgraded employee can start new work, pinned to @3.
    const launched = await module.runtime!.commands.launchWork({
      employeeId: employee.id,
      actorUserId: null,
      intake: {
        name: '预约需求',
        kind: 'body',
        body: '预约',
        uploads: [],
        target: { repositoryId: 'repo-fixture' },
        advanced: { typeOptions: {} },
        executionOptions: {},
        externalId: null,
        idempotencyKey: 'rfc628-upgraded-graph-employee',
      },
    })
    const { employeeCases } = tablesOf(db)
    const [row] = await db
      .select({ typeId: employeeCases.typeId, typeRevision: employeeCases.typeRevision })
      .from(employeeCases)
      .where(eq(employeeCases.id, launched.caseRef.id))
    expect(row).toEqual({ typeId: 'graph-development', typeRevision: 3 })
  }, 90_000)
})
