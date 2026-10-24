// RFC-370 收口遗留：design/RFC-370-crewstation-hosted-deployment/status.md 的
// v0.6.30「编排接口非法请求体返回 500」；docs/audit-backlog.md 的 RFC-319 DE-41 第 2 项。
// 两个 provider 走同一 HTTP 应用，锁定 typed 422 与既有成功响应。

import { beforeEach, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import type { Hono } from 'hono'
import type { DevelopmentAutomationModule } from '@/modules/development-automation/composition'
import type { SecretBox } from '@/auth/secretBox'

import { createDigitalEmployeeWriterCutoverPersistence } from '@/modules/digital-employee/infrastructure/writerCutoverPersistence'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { sealRepoUrl } from '@/services/repoCredentials'
import { createSession } from './helpers/auth/sessionStore'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { buildPr3Fixture } from './helpers/rfc310Pr3Fixture'
import { createUser } from './helpers/userFixture'

setDefaultTimeout(120_000)

const adapterDraft = {
  schemaVersion: 1,
  purpose: 'pipeline-gate',
  operations: ['collect'],
  contractVersion: 1,
  executableRef: '/opt/adapter/pipeline',
  parameterSchemaRef: null,
  connectionRef: 'pipeline',
  secretProjection: [],
  outputBudget: { maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 4096 },
  timeoutMs: 10_000,
}

const configResources = [
  { base: '/api/code/action-templates', extra: { capabilityId: 'change.implement' }, draft: {} },
  { base: '/api/code/verification-profiles', extra: {}, draft: {} },
  { base: '/api/code/digital-employees', extra: {}, draft: {} },
  { base: '/api/code/automation-policies', extra: {}, draft: {} },
  {
    base: '/api/integrations/development-adapters',
    extra: { purpose: 'pipeline-gate' },
    draft: adapterDraft,
  },
] as const

describeEachProviderHttpApplication(
  'RFC-370 development invalid request bodies',
  {
    token: 'a'.repeat(64),
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-rfc370-development-input-',
  },
  (scope) => {
    let app: Hono
    let token: string
    let secretBox: SecretBox
    let automation: DevelopmentAutomationModule
    beforeEach(async () => {
      const opened = await scope.open()
      app = opened.app
      secretBox = opened.secretBox
      automation = opened.modules.developmentAutomation.automation
      const admin = await createUser(scope.harness.db, {
        username: 'rfc370-input-admin',
        displayName: 'Admin',
        role: 'admin',
        password: 'longEnoughPassword',
      })
      token = (await createSession({ db: scope.harness.db, userId: admin.id })).token
    })

    const request = async (method: string, path: string, body: unknown): Promise<Response> =>
      app.request(path, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    async function invalid(method: string, path: string, body: unknown, code: string) {
      const response = await request(method, path, body)
      expect(response.status, `${method} ${path}: ${await response.clone().text()}`).toBe(422)
      expect(await response.json()).toMatchObject({ ok: false, code })
    }

    test('mission record decodes reject every non-object with validation-failed', async () => {
      const paths = [
        '/api/code/missions',
        '/api/code/missions/preview',
        '/api/code/missions/direct-input/preview',
        ...['answers', 'confirm-no-change', 'handoff', 'attach-mr', 'resume'].map(
          (operation) => `/api/code/missions/missing/${operation}`,
        ),
      ]
      for (const path of paths) {
        for (const body of [[], null, 'x', 1, true]) {
          await invalid('POST', path, body, 'validation-failed')
        }
      }
    })

    test('strict requirement-source decode returns validation-failed', async () => {
      for (const body of [{}, { sourceKey: '' }, { sourceKey: 'a', x: 1 }, [], null]) {
        await invalid(
          'POST',
          '/api/code/missions/missing/requirement-source',
          body,
          'validation-failed',
        )
      }
    })

    test('mission command body failures return mission-input-invalid', async () => {
      const answer = { questionId: 'q1', answer: 'answer' }
      const cases: ReadonlyArray<readonly [string, readonly unknown[]]> = [
        [
          'answers',
          [
            {},
            { answers: [answer] },
            { questionSetRef: 'qset', answers: [{ ...answer, answer: 'a'.repeat(8001) }] },
            { questionSetRef: 'qset', answers: Array.from({ length: 51 }, () => answer) },
          ],
        ],
        ['confirm-no-change', [{}, { receiptNote: 'a'.repeat(2001) }, { receiptNote: 'ok', x: 1 }]],
        ['handoff', [{ reason: 5 }, { reason: 'a'.repeat(2001) }, { x: 1 }]],
        [
          'attach-mr',
          [
            { mrIid: '' },
            { mrIid: 'a'.repeat(65) },
            { mrIid: '1', codeHostEndpointRef: 'invalid' },
          ],
        ],
      ]
      for (const [operation, bodies] of cases) {
        for (const body of bodies) {
          await invalid(
            'POST',
            `/api/code/missions/missing/${operation}`,
            body,
            'mission-input-invalid',
          )
        }
      }
      for (const path of [
        '/api/code/missions/preview',
        '/api/code/missions/direct-input/preview',
      ]) {
        await invalid('POST', path, {}, 'mission-input-invalid')
      }
    })

    test('valid mission preview and handoff retain their responses; retired admission stays 409', async () => {
      const fx = await buildPr3Fixture({ db: scope.harness.db })
      const selection = {
        repositoryId: 'repo-pr3',
        repositoryGroupId: null,
        requestedEmployee: { id: fx.employeeId, revision: 1 },
        requestedPolicy: { id: fx.policyId, revision: 1 },
      }
      const preview = await request('POST', '/api/code/missions/preview', {
        ...selection,
        submission: { kind: 'direct' },
      })
      expect(preview.status, await preview.clone().text()).toBe(200)
      expect(await preview.json()).toMatchObject({
        outcome: 'ready',
        employee: selection.requestedEmployee,
        policy: selection.requestedPolicy,
        requirementSource: null,
        sourceOptions: [],
        block: null,
      })
      const validLaunch = {
        ...selection,
        requestedEmployee: null,
        requestedPolicy: null,
        idempotencyKey: 'rfc370-valid-launch',
        submission: { kind: 'direct', title: 'Valid', body: 'Valid request', uploads: [] },
        delivery: { kind: 'create-merge-request' },
      }
      // 保留真实 drive，只等待该 HTTP 请求已启动的 Promise，避免清理目录抢在它前面。
      const drive = spyOn(automation, 'drive')
      try {
        const launched = await request('POST', '/api/code/missions', validLaunch)
        expect(launched.status, await launched.clone().text()).toBe(201)
        const launchReceipt = (await launched.json()) as { created: boolean; missionId: string }
        expect(launchReceipt).toMatchObject({ created: true, missionId: expect.any(String) })
        await drive.mock.results[0]!.value
        await createDigitalEmployeeWriterCutoverPersistence(scope.harness.db).activate({
          legacyAdmissionsEnabled: false,
          now: Date.now(),
        })
        const retired = await request('POST', '/api/code/missions', validLaunch)
        expect(retired.status).toBe(409)
        expect(await retired.json()).toMatchObject({ code: 'legacy-mission-admission-retired' })
        const missionId = await fx.launchDirect('rfc370-handoff')
        const handedOff = await request('POST', `/api/code/missions/${missionId}/handoff`, {})
        expect(handedOff.status, await handedOff.clone().text()).toBe(200)
        expect(await handedOff.json()).toMatchObject({
          missionId,
          automationMode: 'tracking-only',
          pending: false,
        })
      } finally {
        try {
          await Promise.all(drive.mock.results.map((result) => result.value))
        } finally {
          drive.mockRestore()
        }
      }
    })

    test('adopt-mr preserves typed decode errors and folds strict command failures', async () => {
      const path = '/api/code/cutover/adopt-mr'
      for (const body of [
        { repositoryId: 'r' },
        { repositoryId: 5, mrIid: '1' },
        { repositoryId: 'r', mrIid: '1', x: 1 },
      ]) {
        await invalid('POST', path, body, 'mission-input-invalid')
      }
      await invalid('POST', path, [], 'validation-failed')
      const malformed = await app.request(path, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{',
      })
      expect(malformed.status).toBe(422)
      expect(await malformed.json()).toMatchObject({ code: 'invalid-json' })
    })

    test('valid cutover adoption still returns its terminal MR receipt', async () => {
      const codeHost = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () =>
          Response.json({
            iid: 7,
            state: 'merged',
            source_branch: 'feature',
            target_branch: 'main',
            sha: 'a'.repeat(40),
          }),
      })
      try {
        const configured = await request('PUT', '/api/code-hosts/gitlab', {
          baseUrl: `http://127.0.0.1:${codeHost.port}/api/v4`,
          token: 'rfc370-test-token',
        })
        expect(configured.status, await configured.clone().text()).toBe(200)
        const { cachedRepos } = tablesOf(scope.harness.db)
        await insertOne(scope.harness.db, cachedRepos, {
          id: 'rfc370-cutover-repo',
          urlHash: 'rfc370-cutover-repo',
          urlEnc: sealRepoUrl(secretBox, `http://127.0.0.1:${codeHost.port}/group/repo.git`),
          localPath: '/unused/rfc370-cutover',
          defaultBranch: 'main',
          lastFetchedAt: Date.now(),
          createdAt: Date.now(),
        })
        const adopted = await request('POST', '/api/code/cutover/adopt-mr', {
          repositoryId: 'rfc370-cutover-repo',
          mrIid: '7',
        })
        expect(adopted.status, await adopted.clone().text()).toBe(200)
        expect(await adopted.json()).toMatchObject({
          ok: true,
          missionId: expect.any(String),
          terminal: 'merged',
        })
      } finally {
        await codeHost.stop(true)
      }
    })

    for (const resource of configResources) {
      test(`${resource.base} revise rejects invalid bodies and preserves a valid save`, async () => {
        for (const body of [
          [],
          null,
          { name: '' },
          { name: 'a'.repeat(201) },
          { draft: {}, x: 1 },
          { draft: {}, id: 'body-id' },
        ]) {
          await invalid('PUT', `${resource.base}/missing`, body, 'validation-failed')
        }
        const created = await request('POST', resource.base, {
          name: 'Original',
          draft: resource.draft,
          ...resource.extra,
        })
        expect(created.status, await created.clone().text()).toBe(201)
        const { id } = (await created.json()) as { id: string }
        const revised = await request('PUT', `${resource.base}/${id}`, {
          name: 'Revised',
          draft: resource.draft,
        })
        expect(revised.status, await revised.clone().text()).toBe(200)
        expect(await revised.json()).toEqual({ ok: true })
      })
    }

    test('playbook decode and content failures are distinct; valid playbook response is unchanged', async () => {
      const created = await request('POST', '/api/code/digital-employees', {
        name: 'Playbook',
        draft: {},
      })
      expect(created.status).toBe(201)
      const { id } = (await created.json()) as { id: string }
      const path = `/api/code/digital-employees/${id}/playbook`
      for (const body of [
        [],
        null,
        { x: 1 },
        { name: 'a'.repeat(201), playbook: {} },
        { id: 'body-id', playbook: {} },
      ]) {
        await invalid('PUT', path, body, 'validation-failed')
      }
      const rejected = await request('PUT', path, { playbook: {} })
      expect(rejected.status).toBe(422)
      const error = (await rejected.json()) as { code: string; details: { issues: unknown[] } }
      expect(error.code).toBe('digital-employee-draft-invalid')
      expect(error.details.issues.length).toBeGreaterThan(0)
      expect(error.details.issues.length).toBeLessThanOrEqual(10)
      const saved = await request('PUT', path, {
        playbook: {
          schemaVersion: 1,
          description: 'Valid playbook',
          supportedRepositoryFacts: [],
          capabilityRoutes: [],
          requirementSources: [],
          pipelineProviders: [],
          defaultPolicyRef: { id: 'policy', revision: 1 },
        },
      })
      expect(saved.status, await saved.clone().text()).toBe(200)
      expect(await saved.json()).toEqual({ ok: true, nextLocation: `/code/config/employees/${id}` })
    })
  },
)
