// RFC-310 PR-7 T72/T75 —— MR facts snapshot collector 与 feedback reply。
//
// 锁：①同 snapshot 三读 fence——两次 mr.get 之间 head 变化即 `mr-facts-head-race`
// 整组丢弃（不缝合跨 head 的两半事实）；②threads 采集与 authorClass 三分类
// （human / bot 后缀 / self-marker），业务 revision 只随外部 note 追加而变；③读不到的面
// 不伪造——mock 自 PR-12 起如实暴露 provider 的 merge status（种子分支无冲突 ⇒
// mergeableState='mergeable'），但**不**暴露 approvals，于是 approvalHold 仍是
// null 而不是被折算成"没有阻塞"；④reply 只回复不 resolve，正文自动附隐形 self-marker；
// 再采集时外部 thread 作者/revision 不变，但新增消息归 self（防 feedback 自循环）；⑤源码级负面锁：facts/
// reply 文件不可出现 resolve/approve/merge 的 action 或 API path（平台永不
// merge/approve/resolve 的 §10 纪律，对拍 T84 负扫描）。

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  SYSTEM_MOCK_CODE_HOST_TOKEN,
  startSystemMockSuite,
  type StartedSystemMockSuite,
} from '@agent-workflow/system-mocks'

import type { MrEnsureConnectionDeps } from '../src/modules/integration/application/mrEnsure'
import {
  collectMergeRequestFacts,
  replyMergeRequestThread,
  selfMarkerToken,
} from '../src/modules/integration/application/mrFacts'

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

function connectionFor(
  provider: 'gitlab' | 'github',
  project: string,
  fetchImpl?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): MrEnsureConnectionDeps {
  return {
    provider,
    // gitlab 的 project 定位段是 URL-encoded path；github 是原样 owner/repo。
    project: provider === 'gitlab' ? encodeURIComponent(project) : project,
    call: {
      connection: {
        provider,
        baseUrl:
          provider === 'gitlab'
            ? suite.endpoints.gitlabApiBaseUrl
            : suite.endpoints.githubApiBaseUrl,
        repositoryUrlPrefixes: [],
        token: SYSTEM_MOCK_CODE_HOST_TOKEN,
        rejectUnauthorized: true,
      },
      ctx: { ports: {} },
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    },
  }
}

for (const provider of ['gitlab', 'github'] as const) {
  describe(`rfc310 pr7 T72/T75 — mr facts on the ${provider} system mock`, () => {
    test('snapshot, author classes, reply self-loop guard, head-race fence', async () => {
      const projectPath = `rfc310/${provider}-mr-facts`
      const project = await suite.client.seedCodeHost({
        provider,
        projectPath,
        title: 'facts baseline',
        baseFiles: { 'src/a.ts': 'export const a = 1\n' },
        headFiles: { 'src/a.ts': 'export const a = 2\n' },
      })
      const mrRef = String(project.number)
      // 三类作者的 thread：human、bot 后缀、（稍后由 reply 产生的）self。
      await suite.client.mutateCodeHost({
        kind: 'add-review-comment',
        provider,
        projectPath,
        body: 'please rename this variable',
        actor: { username: 'alice' },
      })
      await suite.client.mutateCodeHost({
        kind: 'add-review-comment',
        provider,
        projectPath,
        body: 'lint: unused import',
        actor: { username: 'ci-bot' },
      })

      const deps = connectionFor(provider, projectPath)
      const first = await collectMergeRequestFacts(deps, mrRef, { selfMarker: 'm-777' })
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const snap = first.snapshot
      expect(snap).toMatchObject({
        mrRef,
        headSha: project.headSha,
        state: 'opened',
        draft: false,
        // mock 暴露 provider 的 merge status（种子分支无冲突），但不暴露 approvals：
        // 前者如实读出，后者读不到就留 null，绝不折算成"无人阻塞"。
        mergeableState: 'mergeable',
        approvalHold: null,
        mergedCommitSha: null,
      })
      expect(snap.targetBranch).toBe(project.defaultBranch)
      expect(snap.targetSha).toBe(project.baseSha)
      expect(snap.threads).toHaveLength(2)
      const classes = [...snap.threads.map((t) => t.authorClass)].sort()
      expect(classes).toEqual(['bot', 'human'])
      const humanThread = snap.threads.find((t) => t.authorClass === 'human')!
      expect(humanThread.lastBody).toContain('rename')
      expect(humanThread.revision).toMatch(/^1:/)

      // reply：只回复不 resolve；正文自动带隐形 marker。
      const replied = await replyMergeRequestThread(deps, {
        mrRef,
        threadRef: humanThread.threadRef,
        body: 'Renamed in the next revision.',
        selfMarker: 'm-777',
      })
      expect(replied.ok).toBe(true)

      // 再采集：平台回复作为 self 消息保留在完整树中，但不能覆盖最近一条
      // 外部意见的作者、正文或业务 revision；外部 resolved 状态也不改动。
      const second = await collectMergeRequestFacts(deps, mrRef, { selfMarker: 'm-777' })
      expect(second.ok).toBe(true)
      if (!second.ok) return
      const repliedThread = second.snapshot.threads.find(
        (t) => t.threadRef === humanThread.threadRef,
      )!
      expect(repliedThread.authorClass).toBe('human')
      expect(repliedThread.revision).toBe(humanThread.revision)
      expect(repliedThread.lastBody).toBe(humanThread.lastBody)
      expect(repliedThread.messages).toHaveLength(2)
      expect(repliedThread.messages[1]).toMatchObject({ authorClass: 'self' })
      expect(repliedThread.messages[1]!.body).toContain(selfMarkerToken('m-777'))
      expect(repliedThread.resolved).toBe(false)
      // 没配 selfMarker 的采集方看到同一条是 human（marker 判定是采集方合同）。
      const noMarker = await collectMergeRequestFacts(deps, mrRef)
      expect(noMarker.ok).toBe(true)
      if (noMarker.ok) {
        expect(
          noMarker.snapshot.threads.find((t) => t.threadRef === humanThread.threadRef)!.authorClass,
        ).toBe('human')
      }

      // head race：threads 读取之后、第二次 mr.get 之前推新 head → 整组丢弃。
      let calls = 0
      const racingDeps = connectionFor(provider, projectPath, async (url, init) => {
        calls += 1
        const path = typeof url === 'string' ? url : url instanceof URL ? url.pathname : url.url
        const isFinalGet =
          calls > 1 &&
          init?.method !== 'POST' &&
          (provider === 'gitlab'
            ? /merge_requests\/\d+$/.test(String(path))
            : /pulls\/\d+$/.test(String(path)))
        if (isFinalGet) {
          await suite.client.mutateCodeHost({
            kind: 'advance-head',
            provider,
            projectPath,
            files: { 'src/b.ts': 'export const b = 1\n' },
          })
        }
        return fetch(url as string, init)
      })
      const raced = await collectMergeRequestFacts(racingDeps, mrRef, { selfMarker: 'm-777' })
      expect(raced).toMatchObject({ ok: false, code: 'mr-facts-head-race' })
    })
  })
}

describe('rfc310 pr7 — no merge/approve/resolve reachability (T84 pairing)', () => {
  test('facts/reply source never references resolving or merging actions', () => {
    const roots = [
      'src/modules/integration/application/mrFacts.ts',
      'src/modules/integration/application/mrEnsure.ts',
    ]
    for (const rel of roots) {
      const text = readFileSync(join(import.meta.dir, '..', rel), 'utf8')
      for (const banned of [
        "'thread.resolve'",
        "'mr.approve'",
        "'mr.merge'",
        "'review.submit'",
        // 端点字面量形态：写路径结尾的 /merge、/approve、/resolve。注意只读的
        // /approvals（复数）是合法采集面，不在禁列。
        '/merge`',
        "/merge'",
        "/approve'",
        '/approve`',
        '/resolve',
        'resolveDiscussion',
      ]) {
        expect(text.includes(banned)).toBe(false)
      }
    }
  })
})
