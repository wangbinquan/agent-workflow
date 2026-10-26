import { fixtureContentStore } from './helpers/model/content'
// The graph imports committed Task outputs while the native clarify gate is still waiting.
import { nodeRunFixture, nodeRunOutputFixture, taskFixture } from './helpers/model'
import { expect, test } from 'bun:test'
import { createGraphPlatformWorkItems } from '@/modules/development-automation/application/graph-development/platformWorkItems'
import { graphExecutionContractRegistrations } from '@/modules/development-automation/application/graph-development/toolContracts'
import { bindCandidateDeliveryParticipant } from '@/modules/source-control/composition/repositoryCandidate'
import type { CollaborationHumanInputQueries } from '@/modules/collaboration/public/types'
import type { EmployeeExecutionArtifactQueries } from '@/modules/task-execution/public/types'
import { createGraphExecutionConsumption } from '@/modules/development-automation/application/graph-development/executionConsumption'
import { createGraphDesignCommands } from '@/modules/development-automation/application/graph-development/designCommands'
import { graphEmployeeRuntimeCodec } from '@/modules/development-automation/application/graph-development/employeeCodec'
import { GRAPH_CONTEXT_TYPE } from '@/modules/development-automation/application/graph-development/employeeType'
import { describeEachProvider } from './helpers/eachProvider'
import { graphFixture, bookingView } from './helpers/graphDesign'
import { createEmployeeExecutionArtifactQueries } from '@/modules/task-execution/infrastructure/employeeExecutionArtifacts'

describeEachProvider('RFC-396 committed execution consumption', (harness) => {
  test('the production artifact reader exposes completed node outputs before the human gate completes the Task', async () => {
    await taskFixture(harness.db, {
      id: 'waiting-task',
      name: 'waiting',
      workflowId: 'fixture-workflow',
      workflowVersion: 1,
      workflowSnapshot: JSON.stringify({ nodes: [{ id: 'review', kind: 'review' }] }),
      repoPath: '/fixture',
      worktreePath: '/fixture',
      baseBranch: 'main',
      branch: 'fixture',
      status: 'awaiting_human',
      startedAt: 1,
      inputs: '{}',
      digitalEmployeeCaseId: 'case-a',
      digitalEmployeeRoundId: 'round',
    })
    await nodeRunFixture(harness.db, [
      {
        id: 'designer',
        seq: 1,
        taskId: 'waiting-task',
        nodeId: 'designer',
        status: 'done',
        startedAt: 1,
      },
      {
        id: 'unfinished',
        seq: 2,
        taskId: 'waiting-task',
        nodeId: 'unfinished',
        status: 'running',
        startedAt: 1,
      },
      {
        id: 'review',
        seq: 3,
        taskId: 'waiting-task',
        nodeId: 'review',
        status: 'awaiting_human',
        startedAt: 1,
      },
    ])
    await nodeRunOutputFixture(harness.db, [
      {
        nodeRunId: 'designer',
        portName: 'design-model',
        content: 'committed design',
        active: true,
      },
      { nodeRunId: 'designer', portName: 'inactive', content: 'old', active: false },
      { nodeRunId: 'unfinished', portName: 'design-model', content: 'partial', active: true },
    ])
    const value = await createEmployeeExecutionArtifactQueries(
      harness.db,
      fixtureContentStore(harness.db),
    ).read({
      caseId: 'case-a',
      executionRef: 'waiting-task',
    })
    expect(value?.status).toBe('awaiting_human')
    expect(value?.artifacts.map((artifact) => artifact.content)).toEqual(['committed design'])
    expect(value?.reviewRunIds).toEqual(['review'])
  })
  async function fixture() {
    const f = await graphFixture(harness.db),
      document = await f.commands.document('design-a')
    const initial = JSON.parse(
      graphEmployeeRuntimeCodec.buildInitialCaseJson(
        JSON.stringify({
          caseRef: 'case-a',
          employeeRef: { id: 'e', revision: 1 },
          workScopeJson: '{"kind":"task"}',
          intake: { target: { repositoryId: 'repo-a' }, kind: 'body', body: '预约', uploads: [] },
        }),
      ),
    )
    const work = { ...JSON.parse(initial.primaryContextJson), designId: document.id }
    const plan = {
      roundRef: 'round',
      executionNonce: 'nonce',
      caseRef: { id: 'case-a' },
      employeeTypeRef: { typeId: 'graph-development', revision: 1 },
      workItemRef: 'design-and-clarify',
      inputEnvelopeJson: JSON.stringify({
        contextsJson: JSON.stringify([
          {
            id: 'context',
            typeId: GRAPH_CONTEXT_TYPE,
            revision: 1,
            stateJson: JSON.stringify(work),
            artifactRefs: [],
          },
        ]),
      }),
    }
    let content = JSON.stringify({
      summary: '预约设计',
      result: { document, candidates: [bookingView()] },
    })
    let answered = false
    let activeTaskId = 'task'
    const answerReads: string[] = []
    const queries: CollaborationHumanInputQueries = {
      async clarificationRounds(taskId) {
        answerReads.push(taskId)
        if (taskId !== 'task') return []
        return [
          {
            id: 'clarify-round',
            taskId: 'task',
            askingNodeRunId: 'designer',
            intermediaryNodeRunId: 'clarify',
            status: answered ? 'answered' : 'awaiting_human',
            questions: [],
            answers: answered
              ? [
                  {
                    questionId: 'q',
                    selectedOptionIndices: [0],
                    selectedOptionLabels: ['先到先得'],
                    customText: '负责人还不知道',
                    decision: {
                      status: 'provisional',
                      rationale: '先试用',
                      uncertainty: '暂时单地区',
                    },
                  },
                ]
              : [],
          },
        ]
      },
      async reviewDecision() {
        return null
      },
    }
    const executions: EmployeeExecutionArtifactQueries = {
      async read(input) {
        return input.caseId === 'case-a' && ['task', activeTaskId].includes(input.executionRef)
          ? {
              taskId: input.executionRef,
              roundRef: input.executionRef === 'task' ? 'round' : plan.roundRef,
              status: 'awaiting_clarify',
              artifacts: [
                { nodeRunId: 'designer', portName: 'design-model', content, digest: 'committed' },
              ],
              reviewRunIds: [],
            }
          : null
      },
    }
    const commands = createGraphDesignCommands({
      ...f,
      execution: {
        ...f.execution,
        humanSources: (input) => consumption.humanSources(input.caseId, input.sources),
      },
    })
    const consumption = createGraphExecutionConsumption({
      ...f,
      commands,
      humanInputs: queries,
      executions,
      rounds: {
        frozenPlan: async () => ({ caseId: 'case-a', planJson: JSON.stringify(plan) }),
        lastSettledRound: async () => null,
      },
    })
    const scene = await commands.beginRecord(document.id, 'scene:round:1', 'scene', {})
    await commands.finishRecord(scene, 'ready', { projection: { materials: { document } } })
    Object.assign(f.host, { executionRef: 'task', workItemRef: 'design-and-clarify' })
    return {
      ...f,
      commands,
      document,
      consumption,
      plan,
      answerReads,
      async continueInNewTask() {
        activeTaskId = 'recovery-task'
        plan.roundRef = 'recovery-round'
        Object.assign(f.host, { executionRef: activeTaskId })
        const current = await commands.document(document.id)
        const nextScene = await commands.beginRecord(
          document.id,
          'scene:recovery-round:1',
          'scene',
          {},
        )
        await commands.finishRecord(nextScene, 'ready', {
          projection: { materials: { document: current } },
        })
      },
      setAnswer() {
        answered = true
      },
      setContent(next: string) {
        content = next
      },
    }
  }
  test('waiting-gate imports replay once, then authoritative original answers accompany the next committed iteration', async () => {
    const f = await fixture()
    await f.consumption.progress({ roundRef: 'round', executionRef: 'task' })
    const first = await f.commands.document(f.document.id)
    expect(first.revision).toBe(f.document.revision + 1)
    await f.consumption.progress({ roundRef: 'round', executionRef: 'task' })
    expect((await f.commands.document(first.id)).revision).toBe(first.revision)
    f.setAnswer()
    const next = structuredClone(first)
    next.elements[0]!.description = '采用先到先得'
    f.setContent(
      JSON.stringify({
        summary: '澄清后更新',
        result: { document: next, candidates: [bookingView()] },
      }),
    )
    await f.consumption.progress({ roundRef: 'round', executionRef: 'task' })
    const actual = await f.commands.document(first.id)
    expect(actual.elements[0]!.description).toBe('采用先到先得')
    expect(actual.sources.find((source) => source.kind === 'clarify')).toMatchObject({
      originalAnswer: '先到先得\n负责人还不知道',
      answer: {
        selectedOptionIndices: [0],
        selectedOptionLabels: ['先到先得'],
        customText: '负责人还不知道',
      },
      decision: { status: 'provisional', uncertainty: '暂时单地区' },
    })
    expect(f.requests).toHaveLength(0)
  })
  test('concurrent human edits leave old committed output as a stale proposal', async () => {
    const f = await fixture(),
      next = structuredClone(f.document)
    next.elements[0]!.label = '人编辑的标题'
    await f.commands.change(next.id, {
      requestId: 'edit',
      expectedRevision: next.revision,
      document: next,
    })
    await f.consumption.progress({ roundRef: 'round', executionRef: 'task' })
    expect((await f.commands.document(next.id)).elements[0]!.label).toBe('人编辑的标题')
    expect((await f.queries.workspace(next.id)).proposals.some((p) => p.status === 'stale')).toBe(
      true,
    )
  })
  test('an unchanged design output still imports a newly committed human answer exactly once', async () => {
    const f = await fixture()
    await f.consumption.progress({ roundRef: 'round', executionRef: 'task' })
    const before = await f.commands.document(f.document.id)
    f.setAnswer()
    const input = {
      planJson: JSON.stringify(f.plan),
      outputJson: JSON.stringify({
        summary: '预约设计',
        result: { document: f.document, candidates: [bookingView()] },
      }),
    }
    await f.consumption.consume(input)
    const after = await f.commands.document(f.document.id)
    expect(after.revision).toBe(before.revision + 1)
    expect(after.sources.find((source) => source.kind === 'clarify')).toMatchObject({
      originalAnswer: '先到先得\n负责人还不知道',
      decision: { status: 'provisional' },
    })
    await f.consumption.consume(input)
    expect((await f.commands.document(f.document.id)).revision).toBe(after.revision)
  })
  test('invalid intermediate output is visible without breaking the native human gate', async () => {
    const f = await fixture()
    f.setContent('{broken')
    await f.consumption.progress({ roundRef: 'round', executionRef: 'task' })
    expect(
      (await f.queries.workspace(f.document.id)).requests.some(
        (row) => row.kind === 'import' && row.status === 'failed',
      ),
    ).toBe(true)
    expect((await f.commands.document(f.document.id)).revision).toBe(f.document.revision)
  })
  test('terminal consumption reads actual human answers even when intermediate import was missed', async () => {
    const f = await fixture()
    f.setAnswer()
    await f.consumption.consume({
      planJson: JSON.stringify(f.plan),
      outputJson: JSON.stringify({
        summary: 'finished',
        result: { document: f.document, candidates: [bookingView()] },
      }),
    })
    expect(
      (await f.commands.document(f.document.id)).sources.some(
        (source) => source.kind === 'clarify',
      ),
    ).toBe(true)
  })
  for (const previous of ['rejected-design', 'accepted-design'] as const)
    test(`a new Task preserves original answers from the same Case after ${previous}`, async () => {
      const f = await fixture()
      f.setAnswer()
      if (previous === 'rejected-design') f.setContent('{invalid design')
      await f.consumption.progress({ roundRef: 'round', executionRef: 'task' })
      const foreign = await f.commands.beginRecord(
        f.document.id,
        'import-error:foreign',
        'import',
        {},
      )
      await f.commands.finishRecord(foreign, 'failed', { taskId: 'unrelated-task' })
      await f.continueInNewTask()
      // A recovery model has no new answers and omits every previous human source.
      const output = JSON.stringify({
        summary: 'recovered design',
        result: { document: f.document, candidates: [bookingView()] },
      })
      await f.consumption.consume({ planJson: JSON.stringify(f.plan), outputJson: output })
      const recovered = await f.commands.document(f.document.id)
      const human = recovered.sources.filter((source) => source.kind === 'clarify')
      expect(human).toHaveLength(1)
      expect(human[0]).toMatchObject({
        taskId: 'task',
        roundId: 'clarify-round',
        originalAnswer: '先到先得\n负责人还不知道',
        decision: { status: 'provisional', uncertainty: '暂时单地区' },
      })
      expect(f.answerReads).not.toContain('unrelated-task')
      await f.consumption.consume({ planJson: JSON.stringify(f.plan), outputJson: output })
      expect((await f.commands.document(f.document.id)).revision).toBe(recovered.revision)
      if (previous === 'rejected-design')
        expect(
          (await f.queries.workspace(f.document.id)).requests.some(
            (row) => row.kind === 'import' && row.status === 'failed',
          ),
        ).toBe(true)
    })
  test('implementation limitations return as an explicit proposal and never silently alter the approved design', async () => {
    const f = await fixture()
    const basis = (
      await f.commands.preview(f.document.id, {
        requestId: 'basis',
        expectedRevision: f.document.revision,
        includedElementIds: ['booking'],
      })
    ).basis
    const payload = await f.artifacts.put([
      {
        path: 'request.json',
        content: JSON.stringify({
          basisId: basis.id,
          basisDigest: basis.digest,
          review: { decision: 'approved', basisDigest: basis.digest },
        }),
      },
    ])
    const request = await f.commands.beginRecord(
      f.document.id,
      'implementation:request',
      'implementation',
      {},
    )
    await f.commands.finishRecord(request, 'accepted', { payload, eventId: 'implementation-event' })
    const envelope = JSON.parse(f.plan.inputEnvelopeJson)
    const plan = {
      ...f.plan,
      workItemRef: 'implement-change',
      inputEnvelopeJson: JSON.stringify({
        ...envelope,
        eventJson: JSON.stringify({
          eventId: 'implementation-event',
          payloadArtifactRef: payload.artifactRef,
        }),
      }),
    }
    const input = {
      planJson: JSON.stringify(plan),
      outputJson: JSON.stringify({
        summary: 'Incomplete concurrency behavior',
        result: {
          traceProposals: [],
          testRefs: [],
          limitations: ['Concurrent cancellation remains unresolved'],
          deliveryContent: { commitMessage: 'partial', title: 'partial', description: '' },
        },
      }),
    }
    await f.consumption.consume(input)
    await f.consumption.consume(input)
    const proposal = await f.queries.proposal(f.document.id, 'code-feedback:round')
    expect(proposal.kind).toBe('code-feedback')
    expect(proposal.status).toBe('proposed')
    expect(proposal.document.concerns.at(-1)).toMatchObject({
      priority: 'required',
      disposition: 'open',
      statement: 'Concurrent cancellation remains unresolved',
    })
    expect((await f.commands.document(f.document.id)).revision).toBe(f.document.revision)
  })
  test('system work returns direct business JSON for the existing contract owner to wrap exactly once', async () => {
    const f = await fixture()
    const state = {
      workspacePath: 'fixture',
      baselineRepoPath: 'fixture',
      baseline: f.document.repositoryBaseline!,
    }
    const platform = createGraphPlatformWorkItems({
      ...f,
      workspace: { initialize: async () => state, state: async () => state },
      verification: {
        async run() {
          throw new Error('not called')
        },
      },
      candidates: bindCandidateDeliveryParticipant(),
    })
    const plan = { ...f.plan, workItemRef: 'understand-request' }
    const result = await platform.execute(plan)
    const contract = graphExecutionContractRegistrations.find(
      (item) => item.contractRef.contractId === 'graph-development.understand-request',
    )!
    expect(JSON.parse(contract.validateOutputJson!(result))).toMatchObject({
      result: { designId: 'design-a' },
    })
    const output = graphEmployeeRuntimeCodec.validateReactionOutputJson(
      JSON.stringify({
        workItemRef: plan.workItemRef,
        inputEnvelopeJson: JSON.stringify({
          ...JSON.parse(plan.inputEnvelopeJson),
          roundRef: plan.roundRef,
          executionNonce: plan.executionNonce,
        }),
        outputJson: JSON.stringify({
          schemaVersion: 1,
          roundRef: plan.roundRef,
          executionNonce: plan.executionNonce,
          directResult: JSON.parse(result),
        }),
      }),
    )
    expect(JSON.parse(output).status).toBe('ok')
  })
})
