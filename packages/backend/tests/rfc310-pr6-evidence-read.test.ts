// RFC-310 PR-6 T67 —— pipeline evidence 的 bounded/ranged 读。
//
// 锁：①区间读精确（offset/limit/尾部/超尾/clamp），截断返回可定位 receipt
// （totalBytes/nextOffset），不伪装完整；②HTTP 面的归属纪律——blob 池全局
// 去重，只有本 mission bundle manifest 点名的 sha 才可读（白名单外 404）、
// `__pipeline.manifestRef` cells 缺失 = 尚未采集（404 evidence-not-collected）。
// createApp harness 读 Paths.root，AGENT_WORKFLOW_HOME 必须先于 import 就位
// （journey 同款）。

import { beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'

const HOME = mkdtempSync(resolve(tmpdir(), 'rfc310-pr6-read-home-'))
process.env.AGENT_WORKFLOW_HOME = HOME

import type { Hono } from 'hono'

import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { createSession } from './helpers/auth/sessionStore'
import { createUser } from '../src/services/users'
import {
  EVIDENCE_READ_MAX_BYTES,
  readEvidenceFileRange,
} from '../src/modules/development-automation/application/pipelineEvidenceRead'
import {
  canonicalDigest,
  canonicalStringify,
} from '../src/modules/development-automation/domain/canonicalJson'
import type { FactCell } from '../src/modules/development-automation/domain/factCell'
import type { FactCellValue } from '../src/modules/development-automation/domain/facts'
import { EvidenceStore } from '../src/modules/development-automation/infrastructure/evidenceStore'
import { createMissionPersistence } from '../src/modules/development-automation/infrastructure/missionStore'
import { buildPr3Fixture, type ProviderPr3Fixture } from './helpers/rfc310Pr3Fixture'

setDefaultTimeout(120_000)

const DAEMON_TOKEN = 'a'.repeat(64)

let db: ProviderNeutralDatabase
let fx: ProviderPr3Fixture
let app: Hono
let token: string
let evidence: EvidenceStore
let logSha = ''
let straySha = ''
let missionId = ''

function cell(value: FactCellValue): FactCell<FactCellValue> {
  return { state: 'known', value, sourceRevision: 'pr6-test' }
}

async function putBlobText(text: string): Promise<string> {
  const tmp = join(mkdtempSync(join(tmpdir(), 'rfc310-pr6-blob-')), 'blob')
  writeFileSync(tmp, text)
  return (await evidence.putBlobFromFile(tmp)).sha256
}

async function reqAs(path: string): Promise<Response> {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${token}`)
  return app.request(path, { headers })
}

// RFC-359 AC-6：两个引擎各跑一遍。
describe('rfc310 pr6 T67 — readEvidenceFileRange', () => {
  test('exact ranges, tail, past-end, clamp, and honest truncation receipts', async () => {
    const tmp = join(mkdtempSync(join(tmpdir(), 'rfc310-pr6-range-')), 'f')
    writeFileSync(tmp, 'ABCDEFGHIJ') // 10 bytes
    const deps = { blobPath: () => tmp }

    const head = readEvidenceFileRange(deps, { sha256: 'x', offsetBytes: 0, limitBytes: 4 })
    expect(head).toMatchObject({ ok: true, totalBytes: 10, truncated: true, nextOffset: 4 })
    expect(new TextDecoder().decode((head as { bytes: Uint8Array }).bytes)).toBe('ABCD')

    const middle = readEvidenceFileRange(deps, { sha256: 'x', offsetBytes: 4, limitBytes: 4 })
    expect(new TextDecoder().decode((middle as { bytes: Uint8Array }).bytes)).toBe('EFGH')
    expect(middle).toMatchObject({ truncated: true, nextOffset: 8 })

    // 尾部：读到文件尾 → 不截断、无 nextOffset。
    const tail = readEvidenceFileRange(deps, { sha256: 'x', offsetBytes: 8, limitBytes: 100 })
    expect(new TextDecoder().decode((tail as { bytes: Uint8Array }).bytes)).toBe('IJ')
    expect(tail).toMatchObject({ truncated: false, nextOffset: null })

    // 超尾：空读 + 明确终点，不是错误。
    const past = readEvidenceFileRange(deps, { sha256: 'x', offsetBytes: 10, limitBytes: 4 })
    expect(past).toMatchObject({
      ok: true,
      totalBytes: 10,
      truncated: false,
      nextOffset: null,
    })
    expect((past as { bytes: Uint8Array }).bytes.byteLength).toBe(0)

    // clamp：limit 超硬上限按 EVIDENCE_READ_MAX_BYTES 收（文件小照常全读）。
    expect(EVIDENCE_READ_MAX_BYTES).toBe(4 * 1024 * 1024)
    const clamped = readEvidenceFileRange(deps, {
      sha256: 'x',
      offsetBytes: 0,
      limitBytes: Number.MAX_SAFE_INTEGER,
    })
    expect((clamped as { bytes: Uint8Array }).bytes.byteLength).toBe(10)

    // 非法区间与缺失文件是 typed code。
    expect(readEvidenceFileRange(deps, { sha256: 'x', offsetBytes: -1, limitBytes: 4 })).toEqual({
      ok: false,
      code: 'range-invalid',
    })
    expect(readEvidenceFileRange(deps, { sha256: 'x', offsetBytes: 0, limitBytes: 0 })).toEqual({
      ok: false,
      code: 'range-invalid',
    })
    expect(
      readEvidenceFileRange(
        { blobPath: () => '/nonexistent/blob' },
        { sha256: 'x', offsetBytes: 0, limitBytes: 4 },
      ),
    ).toEqual({ ok: false, code: 'evidence-file-missing' })
  })
})

// RFC-359 AC-6：两个引擎各跑一遍。
// RFC-359 AC-6：HTTP 面两个引擎各跑一遍。夹具的 `beforeAll` 搬进作用域内——它要 `scope`，
// 而且每个引擎都要各自 seed 一次。原来的 `afterAll` 里 `db.$client.close()` 一并删掉：
// 库归 harness 所有，用例不再自己关它。
describeEachProviderHttpApplication(
  'rfc310 pr6 T67 — pipeline evidence HTTP face',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-evidence-read-',
  },
  (scope) => {
    // `beforeAll` 在这里不成立：harness 每个用例前**重置库**，`scope.harness.db` 也只在
    // test 体内（beforeEach 之后）可读。原文件用 `beforeAll` 是因为它自建了一份整文件共用的
    // 内存库；接上双引擎之后 seed 必须每个用例各做一次。
    beforeEach(async () => {
      db = scope.harness.db
      fx = await buildPr3Fixture({ db })
      // 证据目录必须落在**应用实际使用的那个 app home** 下——作用域现建的那一个，
      // 不是模块加载时建的 `HOME`（后者只为 import 期的 `Paths.root` 存在）。写错地方的后果
      // 是路由一路 404，而夹具自己看起来一切正常。
      const opened = await scope.open()
      app = opened.app
      evidence = new EvidenceStore(join(opened.appHome, 'evidence'))
      const admin = await createUser(db, {
        username: 'admin-pr6-read',
        displayName: 'Admin',
        role: 'admin',
        password: 'longEnoughPassword',
      })
      token = (await createSession({ db, userId: admin.id })).token

      logSha = await putBlobText('0123456789abcdefghij') // 20 bytes
      straySha = await putBlobText('not-in-any-manifest')

      const missionNow = Date.now()
      missionId = ulid()
      const store = createMissionPersistence(db)
      await store.createMission({
        id: missionId,
        revision: 0,
        epoch: 0,
        status: 'working',
        automationMode: 'active',
        transitionFence: 'none',
        repositoryId: 'repo-pr6',
        sourceKind: 'direct',
        sourceContentDigest: 'a'.repeat(64),
        requestedSourceKey: null,
        externalId: null,
        resolvedSourceKey: null,
        resolvedAdapterId: null,
        resolvedAdapterRevision: null,
        deliveryKind: 'create-merge-request',
        deliveryTargetRef: null,
        deliverySourceBranch: null,
        adoptedMrRef: null,
        assignmentId: null,
        employeeId: null,
        employeeRevision: null,
        policyId: fx.policyId,
        policyRevision: 1,
        requirementBundleRef: null,
        repositoryFactsRef: null,
        uploadPlanRef: null,
        uploadPlacementRef: null,
        uploadPublicationRef: null,
        mrClaimId: null,
        currentActionRunId: null,
        readinessJson: null,
        blockCode: null,
        blockDetail: null,
        terminalKind: null,
        terminalUploadFulfillment: null,
        terminalAt: null,
        launchIdempotencyKey: `idem-${missionId}`,
        createdBy: null,
        createdAt: missionNow,
        updatedAt: missionNow,
      })
      const manifest = {
        schemaVersion: 1,
        bundleId: 'bundle-pr6',
        providerKey: 'ci-mock',
        headSha: 'a'.repeat(40),
        targetSha: 'b'.repeat(40),
        completeness: 'complete',
        gates: [
          {
            gateKey: 'unit',
            required: true,
            status: 'fail',
            runRef: 'run-1',
            attempt: 1,
            finishedAt: null,
            retryability: 'safe',
            failureCategories: ['unit-test'],
            evidenceFileIds: ['f-log'],
          },
        ],
        files: [
          {
            fileId: 'f-log',
            relativePath: 'logs/unit/console.log',
            mediaType: 'text/plain',
            bytes: 20,
            sha256: logSha,
            redaction: 'none',
          },
        ],
        totals: { files: 1, bytes: 20 },
        redaction: 'complete',
        manifestDigest: 'd'.repeat(64),
      }
      const manifestRef = await putBlobText(JSON.stringify(manifest))
      const cells = { '__pipeline.manifestRef': cell(manifestRef) }
      const snapshotId = ulid()
      await store.insertFactSnapshot({
        id: snapshotId,
        missionId,
        missionRevision: 0,
        capturedAt: new Date().toISOString().replace('Z', '+00:00'),
        cellsJson: canonicalStringify(cells),
        refsJson: '{}',
        digest: canonicalDigest(cells),
        now: missionNow,
      })
      await store.occUpdate(missionId, 0, 0, { requirementBundleRef: snapshotId })
    })

    test('manifest whitelist, missing-collection 404, ranged headers', async () => {
      // 白名单命中：区间读 + 截断头。
      const partial = await reqAs(
        `/api/code/missions/${missionId}/pipeline-evidence/${logSha}?offset=0&limit=10`,
      )
      expect(partial.status).toBe(200)
      expect(await partial.text()).toBe('0123456789')
      expect(partial.headers.get('x-evidence-total-bytes')).toBe('20')
      expect(partial.headers.get('x-evidence-truncated')).toBe('true')
      expect(partial.headers.get('x-evidence-next-offset')).toBe('10')

      const rest = await reqAs(
        `/api/code/missions/${missionId}/pipeline-evidence/${logSha}?offset=10&limit=100`,
      )
      expect(await rest.text()).toBe('abcdefghij')
      expect(rest.headers.get('x-evidence-truncated')).toBe('false')
      expect(rest.headers.get('x-evidence-next-offset')).toBeNull()

      // blob 池里存在、但不在本 mission manifest 白名单 → 404（不可探池）。
      const stray = await reqAs(`/api/code/missions/${missionId}/pipeline-evidence/${straySha}`)
      expect(stray.status).toBe(404)
      expect(((await stray.json()) as { code: string }).code).toBe(
        'pipeline-evidence-file-not-found',
      )

      // 未采集（无 __pipeline.manifestRef cells）的 mission → 404 evidence-not-collected。
      const bare = await fx.launchDirect('pr6-read-bare')
      const uncollected = await reqAs(`/api/code/missions/${bare}/pipeline-evidence/${logSha}`)
      expect(uncollected.status).toBe(404)
      expect(((await uncollected.json()) as { code: string }).code).toBe('evidence-not-collected')

      // manifest blob 丢失（GC/损坏）与内容非法 → 各自 typed 404，不冒充未采集
      // 也不 500（route-error-code coverage 点名这两个 code）。
      const store = createMissionPersistence(db)
      const pointRef = async (target: string, ref: string): Promise<void> => {
        const cells = { '__pipeline.manifestRef': cell(ref) }
        const snapshotId = ulid()
        const mission = (await store.getMission(target))!
        await store.insertFactSnapshot({
          id: snapshotId,
          missionId: target,
          missionRevision: mission.revision,
          capturedAt: new Date().toISOString().replace('Z', '+00:00'),
          cellsJson: canonicalStringify(cells),
          refsJson: '{}',
          digest: canonicalDigest(cells),
          now: Date.now(),
        })
        await store.occUpdate(target, mission.revision, mission.epoch, {
          requirementBundleRef: snapshotId,
        })
      }
      await pointRef(bare, 'e'.repeat(64))
      const missingBlob = await reqAs(`/api/code/missions/${bare}/pipeline-evidence/${logSha}`)
      expect(missingBlob.status).toBe(404)
      expect(((await missingBlob.json()) as { code: string }).code).toBe('evidence-blob-missing')

      await pointRef(bare, await putBlobText('not a manifest json'))
      const badManifest = await reqAs(`/api/code/missions/${bare}/pipeline-evidence/${logSha}`)
      expect(badManifest.status).toBe(404)
      expect(((await badManifest.json()) as { code: string }).code).toBe(
        'pipeline-manifest-invalid',
      )

      // 非法区间 → 422 range-invalid。
      const bad = await reqAs(
        `/api/code/missions/${missionId}/pipeline-evidence/${logSha}?offset=-3`,
      )
      expect(bad.status).toBe(422)
    })
  },
)
