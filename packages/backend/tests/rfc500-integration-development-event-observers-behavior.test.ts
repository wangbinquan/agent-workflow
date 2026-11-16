// RFC-500 — the development employee event observers keep their behaviour after moving to application.
//
// Why this file exists: before RFC-500 nothing ran the code-host observer's `run` (binding → `collectMergeRequestFacts`
// → projection → cursor) or the dispatcher end to end; `rfc310-event-center` covers the pure projection, the cursor and
// the approval observer, and the daemon bundle tests only construct the observer. This file runs the moved code-host
// observer against the system-mock GitLab, pins its pass-through and error paths, the dispatcher's routing, and that the
// composition's assembly hands the deployment's binding and gateway through with the process clock and `randomUUID`.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test'

import {
  SYSTEM_MOCK_CODE_HOST_TOKEN,
  startSystemMockSuite,
  type StartedSystemMockSuite,
} from '@agent-workflow/system-mocks'

import { encodeDevelopmentApprovalSubject } from '../src/modules/development-automation/public/types'
import {
  createDevelopmentCodeHostEventObserver,
  createDevelopmentEmployeeEventObserver,
} from '../src/modules/integration/application/developmentEventObservers'
import type { MrEnsureConnectionDeps } from '../src/modules/integration/application/mrEnsure'
import { codeHostRequests } from '../src/modules/integration/composition'
import { composeDevelopmentEmployeeEventObserver } from '../src/modules/integration/composition/digitalEmployeeEventObserver'

setDefaultTimeout(120_000)

let suite: StartedSystemMockSuite

beforeAll(async () => {
  suite = await startSystemMockSuite()
})

beforeEach(async () => {
  await suite.client.reset()
})

afterAll(async () => {
  await suite.close()
})

function gitlabConnection(projectPath: string): MrEnsureConnectionDeps {
  return {
    provider: 'gitlab',
    project: encodeURIComponent(projectPath),
    requests: codeHostRequests,
    call: {
      connection: {
        provider: 'gitlab',
        baseUrl: suite.endpoints.gitlabApiBaseUrl,
        repositoryUrlPrefixes: [],
        token: SYSTEM_MOCK_CODE_HOST_TOKEN,
        rejectUnauthorized: true,
      },
      ctx: { ports: {} },
    },
  }
}

const CODE_HOST = { sourceRef: { id: 'code-host.activity', revision: 1 } }
const APPROVAL = { sourceRef: { id: 'development.approval-state', revision: 1 } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('RFC-500 code-host observer run on the system-mock GitLab', () => {
  test('the first run emits the lifecycle, review and pipeline facts once; an unchanged rerun re-emits only the periodic check', async () => {
    const projectPath = 'rfc500/observer'
    const project = await suite.client.seedCodeHost({
      provider: 'gitlab',
      projectPath,
      title: 'observer baseline',
      baseFiles: { 'src/a.ts': 'export const a = 1\n' },
      headFiles: { 'src/a.ts': 'export const a = 2\n' },
    })
    const subject = { typeId: 'merge-request', subjectRef: `repo-1!${project.number}` }
    const bindings: string[] = []
    const observer = createDevelopmentCodeHostEventObserver({
      binding: (repositoryId) => {
        bindings.push(repositoryId)
        return gitlabConnection(projectPath)
      },
      now: () => 42,
      activationRef: () => 'activation-1',
    })

    const first = await observer.run({
      source: CODE_HOST,
      subjects: [subject, { typeId: 'external-approval', subjectRef: 'not-a-merge-request' }],
      cursorJson: null,
    })
    expect(bindings).toEqual(['repo-1'])
    expect(
      first.observations.map((observation) => [observation.eventTypeRef, observation.summary]),
    ).toEqual([
      [{ id: 'development.lifecycle-updated', revision: 2 }, 'MR 生命周期与可合入事实已刷新'],
      [{ id: 'development.review-updated', revision: 2 }, 'MR 检视意见已刷新：0 条待处理'],
      [{ id: 'development.pipeline-check-due', revision: 1 }, 'MR 门禁主动复核周期已到达'],
    ])
    for (const observation of first.observations) {
      expect(observation.subject).toBe(subject)
      expect(observation.sourceRef).toBe(CODE_HOST.sourceRef)
      expect(observation.occurredAt).toBe(42)
      expect(observation.payloadArtifactRef).toBeNull()
      expect(observation.dedupeKey).toMatch(/^development-observer:[0-9a-f]{64}$/)
    }
    expect(JSON.parse(first.cursorJson ?? 'null')).toMatchObject({
      schemaVersion: 1,
      activationRef: 'activation-1',
    })

    const second = await observer.run({
      source: CODE_HOST,
      subjects: [subject],
      cursorJson: first.cursorJson,
    })
    expect(second.observations.map((observation) => observation.eventTypeRef.id)).toEqual([
      'development.pipeline-check-due',
    ])
    expect(second.observations[0]!.dedupeKey).not.toBe(first.observations[2]!.dedupeKey)
  })

  test('other sources pass through; malformed subjects, a missing binding and a failed lookup throw', async () => {
    const unbound = createDevelopmentCodeHostEventObserver({
      binding: () => null,
      now: () => 1,
      activationRef: () => 'activation-2',
    })
    expect(await unbound.run({ source: APPROVAL, subjects: [], cursorJson: 'kept' })).toEqual({
      schemaVersion: 1,
      cursorJson: 'kept',
      observations: [],
    })
    await expect(
      unbound.run({
        source: CODE_HOST,
        subjects: [{ typeId: 'merge-request', subjectRef: 'no-separator' }],
        cursorJson: null,
      }),
    ).rejects.toThrow('invalid merge-request subject: no-separator')
    await expect(
      unbound.run({
        source: CODE_HOST,
        subjects: [{ typeId: 'merge-request', subjectRef: 'repo-9!1' }],
        cursorJson: null,
      }),
    ).rejects.toThrow('no code-host connection for repository repo-9')

    const unseeded = createDevelopmentCodeHostEventObserver({
      binding: () => gitlabConnection('rfc500/never-seeded'),
      now: () => 1,
      activationRef: () => 'activation-3',
    })
    await expect(
      unseeded.run({
        source: CODE_HOST,
        subjects: [{ typeId: 'merge-request', subjectRef: 'repo-3!1' }],
        cursorJson: null,
      }),
    ).rejects.toThrow(/^mr-facts-lookup-failed: /)
  })
})

describe('RFC-500 dispatcher and assembly', () => {
  test('the dispatcher sends the approval-state source to the approval observer and every other source to the code-host observer', async () => {
    const calls: string[] = []
    const fake = (name: string) => ({
      async run(request: { readonly source: { readonly sourceRef: { readonly id: string } } }) {
        calls.push(`${name} <- ${request.source.sourceRef.id}`)
        return { schemaVersion: 1 as const, cursorJson: name, observations: [] }
      },
    })
    const dispatcher = createDevelopmentEmployeeEventObserver({
      codeHost: fake('codeHost') as unknown as Parameters<
        typeof createDevelopmentEmployeeEventObserver
      >[0]['codeHost'],
      approval: fake('approval') as unknown as Parameters<
        typeof createDevelopmentEmployeeEventObserver
      >[0]['approval'],
    })
    for (const source of [APPROVAL, CODE_HOST, { sourceRef: { id: 'custom.source', revision: 3 } }])
      await dispatcher.run({ source, subjects: [], cursorJson: null })
    expect(calls).toEqual([
      'approval <- development.approval-state',
      'codeHost <- code-host.activity',
      'codeHost <- custom.source',
    ])
  })

  test('the assembly hands the binding and gateway through and supplies the process clock and randomUUID', async () => {
    const repositories: string[] = []
    const correlations: string[] = []
    const observer = composeDevelopmentEmployeeEventObserver({
      binding: (repositoryId) => {
        repositories.push(repositoryId)
        return null
      },
      gateway: {
        async observe(input) {
          correlations.push(input.correlationRef)
          return { ok: true as const, receipt: { status: 'approved' as const } }
        },
      },
    })

    const before = Date.now()
    const approval = await observer.run({
      source: APPROVAL,
      subjects: [
        {
          typeId: 'external-approval',
          subjectRef: encodeDevelopmentApprovalSubject({
            adapterRef: { id: 'approval-adapter', revision: 1 },
            correlationRef: 'approval-correlation',
          }),
        },
      ],
      cursorJson: null,
    })
    const after = Date.now()
    expect(correlations).toEqual(['approval-correlation'])
    expect(approval.observations.map((observation) => observation.eventTypeRef.id)).toEqual([
      'development.approval-updated',
      'approval.status.changed',
    ])
    for (const observation of approval.observations) {
      expect(observation.occurredAt).toBeGreaterThanOrEqual(before)
      expect(observation.occurredAt).toBeLessThanOrEqual(after)
    }

    const idle = await observer.run({
      source: CODE_HOST,
      subjects: [{ typeId: 'external-approval', subjectRef: 'not-a-merge-request' }],
      cursorJson: null,
    })
    expect(idle.observations).toEqual([])
    expect(
      (JSON.parse(idle.cursorJson ?? 'null') as { activationRef: string }).activationRef,
    ).toMatch(UUID)
    await expect(
      observer.run({
        source: CODE_HOST,
        subjects: [{ typeId: 'merge-request', subjectRef: 'repo-7!3' }],
        cursorJson: null,
      }),
    ).rejects.toThrow('no code-host connection for repository repo-7')
    expect(repositories).toEqual(['repo-7'])
  })
})
