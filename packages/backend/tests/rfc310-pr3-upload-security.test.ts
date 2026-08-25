// RFC-310 PR-3 T39 —— upload 链的对抗面与 HTTP 防护。
//
// 锁：①传输上限/空体/未授权的 typed 拒绝（upload-too-large / upload-empty /
// 401）；②bytes 永不转码归一——blob 与上传（含 NUL/CRLF 的二进制）byte-identical，
// sha256 可独立复算（design §5.4「平台不得把转码/换行归一的派生内容悄悄提交」）；
// ③upload idempotency key 断线重试同 ref；④他人 ref 在 DELETE / preview /
// launch 全部与不存在同形 404（uploadRef 不是 bearer capability，§12.3——
// actor 由 server 覆盖，body 伪造无效）；⑤traversal/normalization 对抗矩阵
// （../、绝对路径、盘符、反斜杠、空段、`.` 段、NUL）在 schema 层 422；
// ⑥真实 gitBaselineReader 链路：二进制 already-present 对拍、symlink/目录/
// mode 漂移 blocked；⑦preview 只读——不 claim、不落 plan。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'

import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos, developmentRepositoryUploadPlans } from '../src/db/schema'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'
import { runGit } from '../src/util/git'
import { MISSION_UPLOAD_MAX_BYTES } from '../src/routes/missionInputUploads'
import {
  previewDirectInput,
  type LaunchDeps,
} from '../src/modules/development-automation/application/commands/launchMission'
import { createRepositoryBaselineResolver } from '../src/modules/development-automation/infrastructure/gitBaselineReader'
import { createSqliteMissionStore } from '../src/modules/development-automation/infrastructure/sqliteMissionStore'
import { createSqliteUploadSessionStore } from '../src/modules/development-automation/infrastructure/sqliteUploadSessionStore'
import { insertUploadPlan } from '../src/modules/development-automation/infrastructure/sqliteUploadPlanStore'
import { defaultAutomationPolicyContent } from '../src/modules/development-automation/domain/automationPolicy'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

let appHome: string
let previousAppHome: string | undefined

beforeEach(() => {
  previousAppHome = process.env.AGENT_WORKFLOW_HOME
  appHome = mkdtempSync(join(tmpdir(), 'aw-upsec-home-'))
  process.env.AGENT_WORKFLOW_HOME = appHome
})

afterEach(() => {
  if (previousAppHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
  else process.env.AGENT_WORKFLOW_HOME = previousAppHome
  rmSync(appHome, { recursive: true, force: true })
})

interface Harness {
  db: DbClient
  app: Hono
  tokenA: string
  tokenB: string
  userA: string
  userB: string
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const a = await createUser(db, {
    username: 'alice-310',
    displayName: 'Alice',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const b = await createUser(db, {
    username: 'bob-310',
    displayName: 'Bob',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const sa = await createSession({ db, userId: a.id })
  const sb = await createSession({ db, userId: b.id })
  return { db, app, tokenA: sa.token, tokenB: sb.token, userA: a.id, userB: b.id }
}

function authed(token: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return { ...init, headers }
}

async function uploadBytes(
  h: Harness,
  token: string,
  bytes: Uint8Array | string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const init = authed(token, { method: 'POST', body: bytes })
  for (const [k, v] of Object.entries(extraHeaders)) (init.headers as Headers).set(k, v)
  return h.app.request('/api/code/mission-input-uploads', init)
}

describe('rfc310 pr3 upload security — HTTP surface', () => {
  test('upload routes resolve their evidence store on the first request, not while mounting', async () => {
    const h = await buildHarness()
    const requestHome = mkdtempSync(join(tmpdir(), 'aw-upsec-lazy-request-'))
    process.env.AGENT_WORKFLOW_HOME = requestHome
    try {
      const evidenceRoot = join(requestHome, 'evidence')
      expect(existsSync(evidenceRoot)).toBe(false)

      const uploaded = await uploadBytes(h, h.tokenA, 'lazy evidence')
      expect(uploaded.status).toBe(201)
      expect(existsSync(evidenceRoot)).toBe(true)
    } finally {
      process.env.AGENT_WORKFLOW_HOME = appHome
      rmSync(requestHome, { recursive: true, force: true })
    }
  })

  test('unauthenticated requests are rejected before any byte lands', async () => {
    const h = await buildHarness()
    const res = await h.app.request('/api/code/mission-input-uploads', {
      method: 'POST',
      body: 'x',
    })
    expect(res.status).toBe(401)
  })

  test('oversize body → upload-too-large; empty body → upload-empty', async () => {
    const h = await buildHarness()
    const big = new Uint8Array(MISSION_UPLOAD_MAX_BYTES + 1)
    const tooLarge = await uploadBytes(h, h.tokenA, big)
    expect(tooLarge.status).toBe(422)
    expect(((await tooLarge.json()) as { code: string }).code).toBe('upload-too-large')

    const empty = await uploadBytes(h, h.tokenA, new Uint8Array(0))
    expect(empty.status).toBe(422)
    expect(((await empty.json()) as { code: string }).code).toBe('upload-empty')
  })

  test('binary bytes land byte-identical in the blob pool — no transcoding, no newline normalization', async () => {
    const h = await buildHarness()
    // NUL、CRLF、孤立 CR、0x80-0xFF——任何 utf8 归一都会破坏其一。
    const payload = new Uint8Array([0x00, 0x0d, 0x0a, 0x0d, 0x80, 0xff, 0xfe, 0x41])
    const expectedSha = createHash('sha256').update(payload).digest('hex')
    const res = await uploadBytes(h, h.tokenA, payload, { 'x-upload-name': 'blob.bin' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { uploadRef: string; sha256: string; bytes: number }
    expect(body.sha256).toBe(expectedSha)
    expect(body.bytes).toBe(payload.byteLength)
    const blobPath = join(appHome, 'evidence', 'blobs', expectedSha.slice(0, 2), expectedSha)
    expect(new Uint8Array(readFileSync(blobPath))).toEqual(payload)
  })

  test('upload idempotency key replays to the same ref (no unrecognizable duplicate rows)', async () => {
    const h = await buildHarness()
    const first = (await (
      await uploadBytes(h, h.tokenA, 'same content', { 'x-upload-idempotency-key': 'retry-key-1' })
    ).json()) as { uploadRef: string }
    const replay = (await (
      await uploadBytes(h, h.tokenA, 'same content', { 'x-upload-idempotency-key': 'retry-key-1' })
    ).json()) as { uploadRef: string }
    expect(replay.uploadRef).toBe(first.uploadRef)
  })

  test('DELETE: foreign refs 404 the same as missing; own pending deletes', async () => {
    const h = await buildHarness()
    const mine = (await (await uploadBytes(h, h.tokenA, 'mine')).json()) as { uploadRef: string }
    const foreign = await h.app.request(
      `/api/code/mission-input-uploads/${mine.uploadRef}`,
      authed(h.tokenB, { method: 'DELETE' }),
    )
    expect(foreign.status).toBe(404)
    expect(((await foreign.json()) as { code: string }).code).toBe('upload-not-found')
    const missing = await h.app.request(
      '/api/code/mission-input-uploads/does-not-exist',
      authed(h.tokenB, { method: 'DELETE' }),
    )
    expect(missing.status).toBe(404)
    const own = await h.app.request(
      `/api/code/mission-input-uploads/${mine.uploadRef}`,
      authed(h.tokenA, { method: 'DELETE' }),
    )
    expect(own.status).toBe(200)
  })

  test('launch/preview enforce the server-side actor: a forged actorUserId cannot reach foreign uploads', async () => {
    const h = await buildHarness()
    const alicesRef = (await (await uploadBytes(h, h.tokenA, 'secret doc')).json()) as {
      uploadRef: string
    }
    // Bob 的 token + body 里伪造 alice 的 actorUserId：server 覆盖 → 404 同形。
    const launch = await h.app.request(
      '/api/code/missions',
      authed(h.tokenB, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: 'idem-forged-actor-1', // gitleaks:allow（幂等/去重键测试值，非凭据）
          repositoryId: 'repo-1',
          repositoryGroupId: null,
          submission: {
            kind: 'direct',
            title: 'steal',
            body: null,
            uploads: [{ uploadRef: alicesRef.uploadRef, repositoryTargetPath: 'docs/x.md' }],
          },
          delivery: { kind: 'create-merge-request' },
          requestedEmployee: null,
          requestedPolicy: null,
          actorUserId: h.userA,
        }),
      }),
    )
    expect(launch.status).toBe(404)
    expect(((await launch.json()) as { code: string }).code).toBe('upload-not-found')

    const preview = await h.app.request(
      '/api/code/missions/direct-input/preview',
      authed(h.tokenB, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repositoryId: 'repo-1',
          repositoryGroupId: null,
          uploads: [{ uploadRef: alicesRef.uploadRef, repositoryTargetPath: 'docs/x.md' }],
          requestedEmployee: null,
          requestedPolicy: null,
          actorUserId: h.userA,
        }),
      }),
    )
    expect(preview.status).toBe(404)
    expect(((await preview.json()) as { code: string }).code).toBe('upload-not-found')
  })

  test('traversal / normalization adversarial matrix is rejected at the schema layer', async () => {
    const h = await buildHarness()
    const mine = (await (await uploadBytes(h, h.tokenA, 'payload')).json()) as {
      uploadRef: string
    }
    const evil = [
      '../escape.md',
      '/etc/passwd',
      'a//b.md',
      'a/./b.md',
      'a/../b.md',
      'C:\\windows\\evil',
      '..\\escape.md',
      'docs\\evil.md',
      'x\0y',
    ]
    for (const target of evil) {
      const res = await h.app.request(
        '/api/code/missions/direct-input/preview',
        authed(h.tokenA, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            repositoryId: 'repo-1',
            repositoryGroupId: null,
            uploads: [{ uploadRef: mine.uploadRef, repositoryTargetPath: target }],
            requestedEmployee: null,
            requestedPolicy: null,
            actorUserId: null,
          }),
        }),
      )
      expect(res.status).toBe(422)
    }
  })
})

// ——— 真实 gitBaselineReader 链路（命令层，走真 git 仓库） ———

const EMPLOYEE_CONTENT = {
  schemaVersion: 1,
  description: 'sec-test employee',
  supportedRepositoryFacts: [],
  capabilityRoutes: [
    {
      capabilityId: 'change.implement',
      rules: [],
      fallbackTemplateRef: { id: 't1', revision: 1 },
    },
  ],
  requirementSources: [],
  pipelineProviders: [],
  defaultPolicyRef: { id: 'pol-1', revision: 1 },
}

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await runGit(cwd, args)
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

async function mkRealRepo(binary: Uint8Array): Promise<string> {
  const repoPath = mkdtempSync(join(tmpdir(), 'aw-upsec-repo-'))
  await git(repoPath, ['init', '--quiet', '--initial-branch=main'])
  await git(repoPath, ['config', 'user.email', 't@example.com'])
  await git(repoPath, ['config', 'user.name', 'T'])
  writeFileSync(join(repoPath, 'binary.bin'), binary)
  writeFileSync(join(repoPath, 'run.sh'), '#!/bin/sh\n')
  chmodSync(join(repoPath, 'run.sh'), 0o755)
  mkdirSync(join(repoPath, 'docs'))
  writeFileSync(join(repoPath, 'docs/keep.md'), 'keep\n')
  symlinkSync('docs/keep.md', join(repoPath, 'link.md'))
  await git(repoPath, ['add', '-A'])
  await git(repoPath, ['commit', '--quiet', '-m', 'baseline'])
  return repoPath
}

function previewDeps(db: DbClient): LaunchDeps {
  return {
    store: createSqliteMissionStore(db),
    lookup: {
      resolveAssignment: async () => null,
      getEmployeeRevisionContent: async () => EMPLOYEE_CONTENT,
      getPolicyRevisionContent: async () => defaultAutomationPolicyContent(),
    },
    now: () => Date.now(),
    uploadAdmission: {
      sessions: createSqliteUploadSessionStore(db),
      transact: (fn) => db.transaction(() => fn()),
      resolveBaseline: createRepositoryBaselineResolver(db),
      persistPlan: (plan) => insertUploadPlan(db, plan),
    },
  }
}

describe('rfc310 pr3 upload security — real git baseline chain', () => {
  test('dispositions come from the frozen HEAD: binary already-present, symlink/dir/mode-drift blocked; preview never claims', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const binary = new Uint8Array([0x00, 0x0d, 0x0a, 0x80, 0xff])
    const repoPath = await mkRealRepo(binary)
    db.insert(cachedRepos)
      .values({
        id: 'repo-real',
        urlHash: 'deadbeef',
        localPath: repoPath,
        lastFetchedAt: 0,
        createdAt: 0,
      })
      .run()
    const deps = previewDeps(db)
    const sessions = deps.uploadAdmission!.sessions

    const mkUp = (name: string, bytes: Uint8Array) => {
      const tmp = join(appHome, name)
      writeFileSync(tmp, bytes)
      return sessions.createUpload({
        actorUserId: 'u-1',
        originalName: name,
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        blobRef: createHash('sha256').update(bytes).digest('hex'),
        idempotencyKey: null,
        now: Date.now(),
      }).id
    }
    const sameBinary = mkUp('same.bin', binary)
    const fresh = mkUp('fresh.md', new TextEncoder().encode('new\n'))
    const ontoSymlink = mkUp('l.md', new TextEncoder().encode('x'))
    const ontoDir = mkUp('d.md', new TextEncoder().encode('x'))
    const sameShellRegular = mkUp('run.sh', new TextEncoder().encode('#!/bin/sh\n'))

    const preview = await previewDirectInput(deps, {
      repositoryId: 'repo-real',
      repositoryGroupId: null,
      uploads: [
        { uploadRef: sameBinary, repositoryTargetPath: 'binary.bin' },
        { uploadRef: fresh, repositoryTargetPath: 'newdir/new.md' },
        { uploadRef: ontoSymlink, repositoryTargetPath: 'link.md' },
        { uploadRef: ontoDir, repositoryTargetPath: 'docs' },
        // 同 bytes 但 baseline 是 executable、upload 默认 regular ⇒ mode 漂移 blocked。
        { uploadRef: sameShellRegular, repositoryTargetPath: 'run.sh' },
      ],
      requestedEmployee: { id: 'emp-1', revision: 1 },
      requestedPolicy: null,
      actorUserId: 'u-1',
    })
    expect(preview.baseline.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(preview.dispositions.map((d) => d.disposition)).toEqual([
      'already-present',
      'create',
      'blocked',
      'blocked',
      'blocked',
    ])
    expect(preview.dispositions[2]!.blockedReason).toBe('target-unsupported-entry')
    expect(preview.dispositions[3]!.blockedReason).toBe('target-is-directory')
    expect(preview.dispositions[4]!.blockedReason).toBe('target-exists-with-different-content')

    // preview 只读：不 claim、不落 plan。
    expect(sessions.getUpload(sameBinary)!.state).toBe('pending')
    expect(db.select().from(developmentRepositoryUploadPlans).all()).toHaveLength(0)
    rmSync(repoPath, { recursive: true, force: true })
  })

  test('missing cached repo resolves to baseline-reader-not-wired (no default-branch guessing)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const deps = previewDeps(db)
    const ref = deps.uploadAdmission!.sessions.createUpload({
      actorUserId: 'u-1',
      originalName: 'a.md',
      bytes: 1,
      sha256: 'a'.repeat(64),
      blobRef: 'a'.repeat(64),
      idempotencyKey: null,
      now: Date.now(),
    }).id
    try {
      await previewDirectInput(deps, {
        repositoryId: 'repo-unknown',
        repositoryGroupId: null,
        uploads: [{ uploadRef: ref, repositoryTargetPath: 'a.md' }],
        requestedEmployee: { id: 'emp-1', revision: 1 },
        requestedPolicy: null,
        actorUserId: 'u-1',
      })
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('baseline-reader-not-wired')
    }
  })
})
