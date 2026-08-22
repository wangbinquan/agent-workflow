import { describe, expect, test } from 'bun:test'

import {
  journeyProjectionV1Schema,
  projectEmployeeSetupJourney,
  projectMissionJourney,
} from '../src/modules/development-automation/domain/journeyProjection'
import { mergeRequestHref } from '../src/modules/development-automation/infrastructure/missionReadModels'

describe('RFC-310 PR-13 server-owned journey projection', () => {
  test('takes a first-time user through one deterministic setup action at a time', () => {
    const empty = projectEmployeeSetupJourney({
      employee: null,
      canCreate: true,
      canUpdate: true,
      canAssign: true,
      canLaunch: true,
    })
    expect(empty.current.key).toBe('define')
    expect(empty.next).toMatchObject({
      key: 'createEmployee',
      owner: 'current-user',
      href: '/code/config/employees?create=1',
    })

    const published = projectEmployeeSetupJourney({
      employee: {
        id: 'employee-java',
        publishedRevision: 3,
        archived: false,
        hasAssignment: true,
      },
      canCreate: true,
      canUpdate: true,
      canAssign: true,
      canLaunch: true,
    })
    expect(published.current.key).toBe('launch')
    expect(published.next.href).toBe('/code/missions/new?employee=employee-java')
    expect(journeyProjectionV1Schema.parse(published)).toEqual(published)
  })

  test('keeps unavailable human actions visible with the missing permission', () => {
    const journey = projectEmployeeSetupJourney({
      employee: null,
      canCreate: false,
      canUpdate: false,
      canAssign: false,
      canLaunch: false,
    })
    expect(journey.next.available).toBe(false)
    expect(journey.next.unavailableReason).toBe('digital-employees:create')
  })

  test('projects questions, automatic waits, committer review and terminal completion', () => {
    const base = {
      missionId: 'mission-1',
      automationMode: 'active',
      transitionFence: 'none',
      blockCode: null,
      hasMergeRequest: true,
      mergeRequestHref: 'https://git.example/project/-/merge_requests/7',
      canInteract: true,
      canRetry: true,
      canAttach: true,
      canResume: true,
    } as const

    expect(
      projectMissionJourney({ ...base, status: 'awaiting-information', hasQuestions: true }).next,
    ).toMatchObject({ key: 'answerQuestions', kind: 'form', owner: 'current-user' })
    expect(
      projectMissionJourney({ ...base, status: 'working', hasQuestions: false }).next,
    ).toMatchObject({ key: 'continueAutomatically', owner: 'platform' })
    expect(
      projectMissionJourney({ ...base, status: 'ready-to-merge', hasQuestions: false }).next,
    ).toMatchObject({ key: 'reviewAndMerge', owner: 'committer' })
    expect(
      projectMissionJourney({ ...base, status: 'merged', hasQuestions: false }).next,
    ).toMatchObject({ key: 'viewOutcome', kind: 'complete', href: '/digital-employees' })
  })

  test('projects child and approval waits without occupying an Agent action', () => {
    const common = {
      missionId: 'parent',
      status: 'working',
      automationMode: 'active',
      transitionFence: 'none',
      blockCode: null,
      hasQuestions: false,
      hasMergeRequest: true,
      mergeRequestHref: null,
      canInteract: true,
      canRetry: true,
      canAttach: true,
      canResume: true,
    } as const
    const child = projectMissionJourney({
      ...common,
      collaboration: {
        kind: 'child-mission',
        href: '/code/missions/child',
        resumeAt: 123,
        deadlineAt: 456,
      },
    })
    expect(child.next).toMatchObject({
      key: 'waitChildMission',
      owner: 'digital-employee',
      wake: { source: 'child-mission' },
    })

    const approval = projectMissionJourney({
      ...common,
      collaboration: {
        kind: 'approval',
        href: 'https://approval.example/REQ-1',
        resumeAt: 123,
        deadlineAt: 456,
        needsHuman: true,
      },
    })
    expect(approval.next).toMatchObject({
      key: 'openApproval',
      kind: 'external-human',
      wake: { source: 'approval' },
    })
  })

  test('is byte-stable for the same committed facts', () => {
    const input = {
      employee: {
        id: 'cpp',
        publishedRevision: 2,
        archived: false,
        hasAssignment: false,
      },
      canCreate: true,
      canUpdate: true,
      canAssign: true,
      canLaunch: true,
    } as const
    const revisions = new Set(
      Array.from({ length: 100 }, () => projectEmployeeSetupJourney(input).projectionRevision),
    )
    expect(revisions.size).toBe(1)
  })
})

// 这条 describe 锁的是「MR 链接拼装从路由层搬进读模型」这次迁移（depcheck
// `no-routes-to-db`：routes/developmentMissions.ts 不得再 import `@/db/schema`）。
// 搬家前该函数是路由内的模块私有 helper、零测试覆盖；搬完顺手把它的判据写下来，
// 免得下一次 refactor 把「非 http(s) 一律 null」这条静默改成拼一个打不开的地址。
describe('RFC-310 PR-13 merge request href projection', () => {
  test('routes GitHub to /pull and everything else to /-/merge_requests', () => {
    expect(
      mergeRequestHref({
        repositoryUrl: 'https://github.com/acme/app.git',
        endpointRef: 'endpoint-1',
        mrIid: '42',
      }),
    ).toBe('https://github.com/acme/app/pull/42')
    // endpointRef 也算数：自托管 GitHub Enterprise 的域名里可能没有 github。
    expect(
      mergeRequestHref({
        repositoryUrl: 'https://code.internal/acme/app/',
        endpointRef: 'github-enterprise-1',
        mrIid: '7',
      }),
    ).toBe('https://code.internal/acme/app/pull/7')
    expect(
      mergeRequestHref({
        repositoryUrl: 'https://git.example/group/app.git',
        endpointRef: 'gitlab-1',
        mrIid: '7',
      }),
    ).toBe('https://git.example/group/app/-/merge_requests/7')
  })

  test('returns null for anything that is not an openable http(s) address', () => {
    for (const repositoryUrl of [null, 'git@git.example:group/app.git', '/srv/git/app.git', '']) {
      expect(mergeRequestHref({ repositoryUrl, endpointRef: 'gitlab-1', mrIid: '7' })).toBeNull()
    }
  })
})
