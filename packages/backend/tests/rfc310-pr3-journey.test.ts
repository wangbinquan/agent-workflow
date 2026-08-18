// RFC-310 PR-3 —— 收口 journey：HTTP 面 + composition 装配的连接组织。
//
// fork 交付的部件测试（materialize/placement/questions/adapter-runner/...）
// 各自锁部件；本文件锁**接线**：
//   1. route 装配 composeDevelopmentAutomation：launch 成功后 direct 正文由
//      路由层 stash 为 evidence（digest 与 mission 冻结值对上）、mutation 后
//      fire-and-forget reconcile；
//   2. PR-3 正向三形态（plan.md §5）：正文-only／文件-only·正文+文件逐项指定
//      目标路径（claim + UploadPlan receipt）／sourceKey+externalId → mock
//      provider 三文件 bundle；三类都 pin 唯一 digest；
//   3. manifest / 逐文件 ranged-read HTTP 面（无 host path、mission 归属检查）；
//   4. source-refresh preview/apply（mock 换 revision 实测）与平台渠道
//      answers 提交；
//   5. 诚实接线边界：PR-3 无 repository facts collector/agent launcher，
//      mission 最终 blocked `collector-not-wired:repository`——「开单 ≠ 在跑」。
//   6. composition 的 sweepWakes（fireWake CAS 认领 + wake hint 消费）、
//      sweepUploads（TTL 回收）、recover 冒烟。
//
// 决定论：route 的 fire-and-forget reconcile 每次 mutation 只跑一轮 arm；
// 测试用同参 composition 实例做显式泵（OCC/decision 去重保证并发收敛），
// 对「必须尚未发生」的断言（manifest 404）用 admission-blocked mission
// （policy-content-missing 早退，materialize 永不运行）。

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { ulid } from 'ulid'

import {
  startRequirementProviderMock,
  type StartedRequirementProviderMock,
} from '@agent-workflow/system-mocks/development/requirement-provider'

import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos } from '../src/db/schema'
import {
  composeDevelopmentAutomation,
  type DevelopmentAutomationModule,
} from '../src/modules/development-automation/composition'
import { composeRequirementSourceRunner } from '../src/modules/integration/composition/requirementSource'
import type { MissionRow } from '../src/modules/development-automation/application/ports/missionStore'
import {
  createSqliteUploadSessionStore,
  UPLOAD_SESSION_TTL_MS,
} from '../src/modules/development-automation/infrastructure/sqliteUploadSessionStore'
import {
  createAutomationPolicy,
  publishAutomationPolicy,
} from '../src/modules/development-automation/infrastructure/sqliteDigitalEmployeeStore'
import { defaultAutomationPolicyContent } from '../src/modules/development-automation/domain/automationPolicy'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'
import { buildPr3Fixture, type Pr3Fixture } from './helpers/rfc310Pr3Fixture'

setDefaultTimeout(120_000)

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// 路由装配读 Paths.root / AW_REQUIREMENT_MOCK_URL 都发生在 createApp（mount）
// 时——两者必须先于 beforeAll 里的 createApp 就位。
const HOME = mkdtempSync(resolve(tmpdir(), 'rfc310-journey-home-'))
process.env.AGENT_WORKFLOW_HOME = HOME

let mock: StartedRequirementProviderMock
let db: DbClient
let fx: Pr3Fixture
let app: Hono
let token: string
let automation: DevelopmentAutomationModule
/** answers 用例专用 policy：规则只读 requirement facts（见该用例注释）。 */
let requirementOnlyPolicyId = ''

function seedExternal(externalId: string, revision: string, note: string): void {
  mock.mock.seed({
    externalId,
    revision,
    title: 'External demand',
    files: [
      {
        fileId: 'f1',
        name: 'body.md',
        role: 'body',
        mediaType: 'text/markdown',
        content: `# demand ${note}\n`,
      },
      {
        fileId: 'f2',
        name: 'design.md',
        role: 'design',
        mediaType: 'text/markdown',
        content: `design ${note}\n`,
      },
      {
        fileId: 'f3',
        name: 'notes.txt',
        role: 'attachment',
        mediaType: 'text/plain',
        content: `note ${note}\n`,
      },
    ],
  })
}

async function reqAs(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return app.request(path, { ...init, headers })
}

function launchBody(
  idempotencyKey: string,
  submission: unknown,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    idempotencyKey,
    repositoryId: 'repo-1',
    repositoryGroupId: null,
    submission,
    delivery: { kind: 'create-merge-request' },
    requestedEmployee: { id: fx.employeeId, revision: 1 },
    requestedPolicy: null,
    ...overrides,
  })
}

/** 显式泵：反复 reconcile 直到谓词满足（与路由 fire-and-forget 并发收敛）。 */
async function pumpUntil(
  missionId: string,
  predicate: (mission: MissionRow) => boolean,
  // 预算按最慢 arm 放：adapter CLI 首跑要过 bun 编译，秒级；400×25ms ≈ 10s。
  rounds = 400,
): Promise<MissionRow> {
  let lastError: unknown = null
  for (let i = 0; i < rounds; i += 1) {
    const mission = fx.store.getMission(missionId)
    if (mission === null) throw new Error(`mission disappeared: ${missionId}`)
    if (predicate(mission)) return mission
    try {
      await automation.reconcile(missionId)
    } catch (err) {
      // 与路由 fire-and-forget reconcile 并发时允许单轮竞态输家（OCC/dedup），
      // 下一轮重试；持续失败由 rounds 耗尽兜底暴露。
      lastError = err
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 25))
  }
  const last = fx.store.getMission(missionId)
  throw new Error(
    `pumpUntil exhausted: status=${last?.status ?? 'gone'} blockCode=${last?.blockCode ?? 'null'}` +
      (lastError instanceof Error ? ` lastError=${lastError.message}` : ''),
  )
}

/** 被动等待（不 reconcile）：等 route fire-and-forget 的那一轮 arm 落定。 */
async function waitFor(predicate: () => boolean, rounds = 400): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (predicate()) return
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 25))
  }
  throw new Error('waitFor exhausted')
}

beforeAll(async () => {
  mock = await startRequirementProviderMock()
  process.env.AW_REQUIREMENT_MOCK_URL = mock.url
  seedExternal('REQ-7', 'r1', 'v1')
  db = createInMemoryDb(MIGRATIONS)
  fx = await buildPr3Fixture({ db, external: { mockUrl: mock.url } })

  // repo-1 需要可解析的 baseline（uploads 的 plan/placement 链）：真 git 仓 +
  // cached_repos 行。README 是 baseline 既有文件，docs/* 目标留空走 create。
  const repoPath = resolve(HOME, 'repo-src')
  const git = (...args: string[]): void => {
    const proc = Bun.spawnSync({ cmd: ['git', ...args], cwd: repoPath })
    if (proc.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`)
    }
  }
  mkdirSync(repoPath, { recursive: true })
  git('init', '-q')
  writeFileSync(resolve(repoPath, 'README.md'), '# baseline\n')
  git('add', 'README.md')
  git('-c', 'user.email=journey@test', '-c', 'user.name=journey', 'commit', '-q', '-m', 'baseline')
  db.insert(cachedRepos)
    .values({
      id: 'repo-1',
      urlHash: 'deadbeef',
      localPath: repoPath,
      lastFetchedAt: Date.now(),
      createdAt: Date.now(),
    })
    .run()
  app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const admin = await createUser(db, {
    username: 'admin-journey',
    displayName: 'Admin',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  token = (await createSession({ db, userId: admin.id })).token

  const requirementOnlyPolicy = await createAutomationPolicy(db, {
    name: 'pol-journey-requirement-only',
    ownerUserId: admin.id,
    draft: {
      ...defaultAutomationPolicyContent(),
      actionPriority: {
        rules: [
          {
            ruleId: 'impl-when-bundle-ready',
            when: [{ kind: 'boolean-is', fact: 'requirement.bundleComplete', value: true }],
            capabilityId: 'change.implement',
          },
        ],
      },
    },
  })
  await publishAutomationPolicy(db, { id: requirementOnlyPolicy.id, publishedBy: admin.id })
  requirementOnlyPolicyId = requirementOnlyPolicy.id
  automation = composeDevelopmentAutomation({
    db,
    appHome: HOME,
    requirementSource: composeRequirementSourceRunner(db),
  })
})

afterAll(async () => {
  await mock.close()
  delete process.env.AW_REQUIREMENT_MOCK_URL
  rmSync(HOME, { recursive: true, force: true })
})

describe('rfc310 pr3 journey — direct body-only', () => {
  // bun test --randomize 会打乱同 describe 内的用例顺序：一条 journey 的先后
  // 步骤必须收在同一个 test 里，不得跨 test 共享 missionId。
  test('HTTP launch → stash → manifest → file streaming faces → honest facts-collector block', async () => {
    const res = await reqAs('/api/code/missions', {
      method: 'POST',
      body: launchBody('journey-direct-1', {
        kind: 'direct',
        title: 'Add feature',
        body: 'do the thing',
        uploads: [],
      }),
    })
    expect(res.status).toBe(201)
    const launched = (await res.json()) as { missionId: string; status: string; created: boolean }
    expect(launched.created).toBe(true)
    expect(launched.status).toBe('working')
    const missionId = launched.missionId

    // digest 在 launch 冻结；route stash 的 doc 必须与之对上（对不上 launch 就
    // 已 409，能走到这里即配对成立）。
    expect(fx.store.getMission(missionId)!.sourceContentDigest).toMatch(/^[0-9a-f]{64}$/)

    const blocked = await pumpUntil(missionId, (m) => m.status === 'blocked')
    expect(blocked.blockCode).toBe('collector-not-wired:repository')

    const manifestRes = await reqAs(`/api/code/missions/${missionId}/requirement-manifest`)
    expect(manifestRes.status).toBe(200)
    const { manifest } = (await manifestRes.json()) as {
      manifest: {
        source: { kind: string }
        manifestDigest: string
        files: { relativePath: string; sha256: string; bytes: number; mediaType: string }[]
        totals: { files: number }
      }
    }
    expect(manifest.source.kind).toBe('direct')
    expect(manifest.manifestDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.totals.files).toBe(1)
    expect(manifest.files[0]!.relativePath).toBe('body.md')

    const sha = manifest.files[0]!.sha256
    const base = `/api/code/missions/${missionId}/requirement-files/${sha}`

    const full = await reqAs(base)
    expect(full.status).toBe(200)
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(await full.text()).toBe('do the thing')

    const head = await reqAs(base, { headers: { range: 'bytes=0-1' } })
    expect(head.status).toBe(206)
    expect(head.headers.get('content-range')).toBe('bytes 0-1/12')
    expect(await head.text()).toBe('do')

    const tail = await reqAs(base, { headers: { range: 'bytes=-5' } })
    expect(tail.status).toBe(206)
    expect(await tail.text()).toBe('thing')

    const openEnd = await reqAs(base, { headers: { range: 'bytes=3-' } })
    expect(openEnd.status).toBe(206)
    expect(await openEnd.text()).toBe('the thing')

    const bad = await reqAs(base, { headers: { range: 'bytes=99-' } })
    expect(bad.status).toBe(416)
    expect(((await bad.json()) as { code: string }).code).toBe('range-not-satisfiable')

    // blob 池全局去重 ⇒ 归属检查必须挡「拿别的 mission 的 manifest 探不属于
    // 自己的 hash」；不在本 mission manifest 里的 hash 与不存在同形。
    const foreign = await reqAs(
      `/api/code/missions/${missionId}/requirement-files/${'0'.repeat(64)}`,
    )
    expect(foreign.status).toBe(404)
    expect(((await foreign.json()) as { code: string }).code).toBe('requirement-file-not-found')

    // 盘上 blob 丢失（备份还原不完整等）→ 诚实 404，不 500。放在最后：破坏性。
    unlinkSync(automation.evidence.blobPath(sha))
    const gone = await reqAs(base)
    expect(gone.status).toBe(404)
    expect(((await gone.json()) as { code: string }).code).toBe('evidence-blob-missing')
  })

  test('manifest 404 while nothing has materialized (admission-blocked mission)', async () => {
    // 无 assignment、无 requestedEmployee ⇒ launch 即 blocked；reconcile 走
    // policy-content-missing 早退，materialize 永不运行——404 是确定性的。
    const res = await reqAs('/api/code/missions', {
      method: 'POST',
      body: launchBody(
        'journey-direct-unadmitted-1',
        { kind: 'direct', title: 'orphan', body: 'no employee', uploads: [] },
        { requestedEmployee: null, repositoryId: 'repo-without-assignment' },
      ),
    })
    expect(res.status).toBe(201)
    const launched = (await res.json()) as { missionId: string; status: string }
    expect(launched.status).toBe('blocked')
    const manifestRes = await reqAs(`/api/code/missions/${launched.missionId}/requirement-manifest`)
    expect(manifestRes.status).toBe(404)
    expect(((await manifestRes.json()) as { code: string }).code).toBe(
      'requirement-manifest-not-found',
    )
  })
})

describe('rfc310 pr3 journey — direct uploads (file-only / body+file)', () => {
  async function uploadBytes(
    name: string,
    content: string,
  ): Promise<{ uploadRef: string; sha256: string }> {
    const res = await reqAs('/api/code/mission-input-uploads', {
      method: 'POST',
      headers: { 'x-upload-name': name, 'content-type': 'application/octet-stream' },
      body: content,
    })
    expect(res.status).toBe(201)
    return (await res.json()) as { uploadRef: string; sha256: string }
  }

  test('file-only launch claims the upload and pins plan + digest; replay is idempotent', async () => {
    const upload = await uploadBytes('spec.md', 'SPEC-CONTENT-1')
    const body = launchBody('journey-file-only-1', {
      kind: 'direct',
      title: 'Spec drop',
      body: null,
      uploads: [{ uploadRef: upload.uploadRef, repositoryTargetPath: 'docs/spec.md' }],
    })
    const res = await reqAs('/api/code/missions', { method: 'POST', body })
    expect(res.status).toBe(201)
    const launched = (await res.json()) as { missionId: string; created: boolean }

    const mission = fx.store.getMission(launched.missionId)!
    expect(mission.sourceContentDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(mission.uploadPlanRef).not.toBeNull()
    expect(createSqliteUploadSessionStore(db).getUpload(upload.uploadRef)!.state).toBe('claimed')

    // 同 idempotencyKey 重放：200 + created:false + 同 mission，不重复 claim。
    const replay = await reqAs('/api/code/missions', { method: 'POST', body })
    expect(replay.status).toBe(200)
    const replayed = (await replay.json()) as { missionId: string; created: boolean }
    expect(replayed.created).toBe(false)
    expect(replayed.missionId).toBe(launched.missionId)
  })

  test('body+file launch materializes the body manifest (uploads ride the seed chain)', async () => {
    const upload = await uploadBytes('notes.md', 'NOTES-CONTENT-1')
    const res = await reqAs('/api/code/missions', {
      method: 'POST',
      body: launchBody('journey-body-file-1', {
        kind: 'direct',
        title: 'Body plus file',
        body: 'body text here',
        uploads: [{ uploadRef: upload.uploadRef, repositoryTargetPath: 'docs/notes.md' }],
      }),
    })
    expect(res.status).toBe(201)
    const launched = (await res.json()) as { missionId: string }
    await pumpUntil(launched.missionId, (m) => m.status === 'blocked')
    const manifestRes = await reqAs(`/api/code/missions/${launched.missionId}/requirement-manifest`)
    expect(manifestRes.status).toBe(200)
    const { manifest } = (await manifestRes.json()) as {
      manifest: { files: { relativePath: string }[]; totals: { files: number } }
    }
    // 现状（fork-H 判断，plan.md 交付注记）：direct manifest 只含正文文件；
    // 上传文件经 UploadPlan/SeedChangeRef 链入 workspace，不进 requirement
    // bundle 的 files 列表。repositoryPlacement 对齐留 PR-5。
    expect(manifest.totals.files).toBe(1)
    expect(manifest.files[0]!.relativePath).toBe('body.md')
  })
})

describe('rfc310 pr3 journey — external reference + source refresh', () => {
  // 同一条 journey 的先后步骤收在一个 test 里（--randomize 会打乱 test 顺序）。
  test('external three-file bundle → facts block → refresh preview/apply; non-external 422', async () => {
    const res = await reqAs('/api/code/missions', {
      method: 'POST',
      body: launchBody('journey-external-1', { kind: 'external-reference', externalId: 'REQ-7' }),
    })
    expect(res.status).toBe(201)
    const missionId = ((await res.json()) as { missionId: string }).missionId

    const blocked = await pumpUntil(missionId, (m) => m.status === 'blocked')
    expect(blocked.blockCode).toBe('collector-not-wired:repository')

    const manifestRes = await reqAs(`/api/code/missions/${missionId}/requirement-manifest`)
    expect(manifestRes.status).toBe(200)
    const { manifest } = (await manifestRes.json()) as {
      manifest: {
        source: { kind: string; sourceRevision: string }
        files: { relativePath: string; role: string }[]
        totals: { files: number }
      }
    }
    expect(manifest.source.kind).toBe('external')
    expect(manifest.source.sourceRevision).toBe('r1')
    expect(manifest.totals.files).toBe(3)
    expect(manifest.files.map((f) => f.role).sort()).toEqual(['attachment', 'body', 'design'])

    const same = await reqAs(`/api/code/missions/${missionId}/source-refresh/preview`, {
      method: 'POST',
    })
    expect(same.status).toBe(200)
    const samePreview = (await same.json()) as { changed: boolean; currentSourceRevision: string }
    expect(samePreview.changed).toBe(false)
    expect(samePreview.currentSourceRevision).toBe('r1')

    seedExternal('REQ-7', 'r2', 'v2')
    const changed = await reqAs(`/api/code/missions/${missionId}/source-refresh/preview`, {
      method: 'POST',
    })
    expect(changed.status).toBe(200)
    const changedPreview = (await changed.json()) as { changed: boolean; newSourceRevision: string }
    expect(changedPreview.changed).toBe(true)
    expect(changedPreview.newSourceRevision).toBe('r2')

    const applied = await reqAs(`/api/code/missions/${missionId}/source-refresh`, {
      method: 'POST',
    })
    expect(applied.status).toBe(200)
    expect((await applied.json()) as object).toMatchObject({ changed: true, sourceRevision: 'r2' })

    // apply 重置 requirement cells → 泵到重新物化出 r2 的 manifest。
    await pumpUntil(missionId, () => {
      const manifest = automation.materializer.getRequirementManifest(missionId)
      return manifest !== null && manifest.source.kind === 'external'
        ? manifest.source.sourceRevision === 'r2'
        : false
    })

    // 非 external mission：invalid-user-input → 422 not-external-source。
    const directRes = await reqAs('/api/code/missions', {
      method: 'POST',
      body: launchBody('journey-direct-for-refresh-1', {
        kind: 'direct',
        title: 'not external',
        body: 'x',
        uploads: [],
      }),
    })
    const directId = ((await directRes.json()) as { missionId: string }).missionId
    const refused = await reqAs(`/api/code/missions/${directId}/source-refresh/preview`, {
      method: 'POST',
    })
    expect(refused.status).toBe(422)
    expect(((await refused.json()) as { code: string }).code).toBe('not-external-source')

    const missing = await reqAs('/api/code/missions/01ARZ3NDEKTSV4RRFFQ69G5FAV/source-refresh', {
      method: 'POST',
    })
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { code: string }).code).toBe('mission-not-found')
  })
})

describe('rfc310 pr3 journey — platform-channel answers over HTTP', () => {
  test('publish → wrong ref 422 → submit → working → route block', async () => {
    // 澄清重派只拦截 block/run-agent-action，不拦 facts-collect（未澄清的需求
    // 不该起动作，但事实采集不必等澄清）。fixture 默认规则第二谓词读
    // repository.languages，会先落 collector-not-wired——本用例换成只读
    // requirement facts 的 policy，让规则直达 run-agent-action 被澄清拦下。
    const res = await reqAs('/api/code/missions', {
      method: 'POST',
      body: launchBody(
        'journey-answers-1',
        { kind: 'direct', title: 'Ask me things', body: 'ambiguous ask', uploads: [] },
        { requestedPolicy: { id: requirementOnlyPolicyId, revision: 1 } },
      ),
    })
    expect(res.status).toBe(201)
    const missionId = ((await res.json()) as { missionId: string }).missionId

    // 被动等 launch 的那一轮后台 reconcile 物化 bundle（它只跑一个 arm，之后
    // mission 停在 working）——绝不能自己泵：多泵一轮就推进到 facts-collect
    // blocked，问题集发布只对非 blocked 状态生效（blocked 出口是 retry 命令）。
    await waitFor(() => automation.materializer.getRequirementManifest(missionId) !== null)
    const stashed = await automation.materializer.stashQuestionSet({
      missionId,
      origin: 'platform',
      channel: 'platform',
      questions: [
        { questionId: 'q1', text: 'which module?', answerKind: 'text', choices: null },
        {
          questionId: 'q2',
          text: 'blocking?',
          answerKind: 'single-choice',
          choices: ['yes', 'no'],
        },
      ],
    })
    expect(stashed.ok).toBe(true)
    if (!stashed.ok) return
    await pumpUntil(missionId, (m) => m.status === 'awaiting-information')

    const wrongRef = await reqAs(`/api/code/missions/${missionId}/answers`, {
      method: 'POST',
      body: JSON.stringify({
        questionSetRef: 'not-the-pending-one',
        answers: [{ questionId: 'q1', answer: 'billing' }],
      }),
    })
    expect(wrongRef.status).toBe(422)
    expect(((await wrongRef.json()) as { code: string }).code).toBe('question-set-not-pending')

    const submitted = await reqAs(`/api/code/missions/${missionId}/answers`, {
      method: 'POST',
      body: JSON.stringify({
        questionSetRef: stashed.questionSetRef,
        answers: [
          { questionId: 'q1', answer: 'billing' },
          { questionId: 'q2', answer: 'yes' },
        ],
      }),
    })
    expect(submitted.status).toBe(200)
    const answer = (await submitted.json()) as { status: string; answerRevision: string }
    expect(answer.status).toBe('working')
    expect(answer.answerRevision).toMatch(/^[0-9a-f]{64}$/)

    // 提交即冻结：mission 已回 working，重放同 ref 撞 admissibility 关（409），
    // 不产生第二份 answer set。
    const replay = await reqAs(`/api/code/missions/${missionId}/answers`, {
      method: 'POST',
      body: JSON.stringify({
        questionSetRef: stashed.questionSetRef,
        answers: [{ questionId: 'q1', answer: 'billing' }],
      }),
    })
    expect(replay.status).toBe(409)
    expect(((await replay.json()) as { code: string }).code).toBe(
      'mission-command-not-awaiting-information',
    )

    // 答毕规则命中 run-agent-action；员工 route 读 repository.languages（无
    // facts collector ⇒ indeterminate）→ 诚实 template-route block。
    const blocked = await pumpUntil(missionId, (m) => m.status === 'blocked')
    expect(blocked.blockCode).toStartWith('template-route:')

    const trace = await reqAs(`/api/code/missions/${missionId}/decision-trace`)
    expect(trace.status).toBe(200)
    expect(((await trace.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0)
  })
})

describe('rfc310 pr3 journey — composition sweeps and recovery', () => {
  test('sweepWakes claims due wakes once and drains wake hints; sweepUploads reaps TTL; recover smokes', async () => {
    const missionId = await fx.launchDirect('journey-sweep-1')
    const now = Date.now()

    fx.store.armWake({
      id: ulid(),
      missionId,
      decisionId: 'journey-decision-1',
      reason: 'poll',
      resumeAt: now - 1_000,
      wakeSources: ['manual'],
      attemptOrdinal: 0,
      now,
    })
    const first = await automation.sweepWakes()
    expect(first.reconciled).toBeGreaterThanOrEqual(1)
    expect(fx.store.getWake(missionId, 'journey-decision-1')!.state).toBe('fired')
    // fired 行不再 due：安静 tick 恒 0（无 hint 时）。
    expect((await automation.sweepWakes()).reconciled).toBe(0)

    expect(
      fx.store.recordWakeHint({
        id: ulid(),
        missionId,
        source: 'webhook',
        deliveryKey: 'journey-delivery-1',
        now: Date.now(),
      }).accepted,
    ).toBe(true)
    expect((await automation.sweepWakes()).reconciled).toBe(1)
    expect((await automation.sweepWakes()).reconciled).toBe(0)

    const uploads = createSqliteUploadSessionStore(db)
    uploads.createUpload({
      actorUserId: 'admin',
      originalName: 'stale.bin',
      bytes: 4,
      sha256: 'e'.repeat(64),
      blobRef: 'e'.repeat(64),
      idempotencyKey: null,
      now: Date.now() - UPLOAD_SESSION_TTL_MS - 60_000,
    })
    expect(automation.sweepUploads().swept).toBeGreaterThanOrEqual(1)

    const recovered = await automation.recover()
    expect(recovered.settledFences).toBeGreaterThanOrEqual(0)
    expect(recovered.invalidatedEffects).toBeGreaterThanOrEqual(0)
    expect(recovered.firedWakes).toBeGreaterThanOrEqual(0)
  })
})
