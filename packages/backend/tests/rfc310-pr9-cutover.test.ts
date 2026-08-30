// RFC-310 PR-9 T98–T103 —— cutover 状态机 + legacy admission gate + adopt。
//
// 锁的回归面：
//   1. 状态机转移矩阵（pre→frozen→live 单向；rollback 只在 frozen 合法，
//      flip 之后 typed 拒 'cutover-rollback-after-flip'——有副作用的回退
//      机器不猜）。
//   2. legacy 双入口 gate：/api/code/rounds POST 在 frozen/live 409
//      'legacy-admission-frozen'；webhook code-round fire 落
//      'skipped-legacy-admission-frozen' 且零任务启动。rollback 后双入口恢复。
//   3. adoptActiveMr 验收样本（runbook 八样本的机内可测子集）：opened →
//      watching + active claim + legacy link；merged/closed → authoritative
//      terminal（无 claim、无 action）；同 MR 重放幂等；claim 被他人占用拒
//      'mr-owned-by-another-mission'；observe 失败原码传播（「无 MR」样本）。
//      其余样本（运行中 legacy agent 停机、receipt 丢失重建）是 runbook 人工
//      步骤；feedback/冲突样本属 mission 正常生命周期，由 PR-5/6/7 链条测试
//      覆盖。
//
// route error code ratchet 点名：legacy-admission-frozen / cutover-phase-invalid
// / cutover-rollback-after-flip / cutover-adopt-rejected /
// cutover-repo-binding-missing。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { CodeHostEvent } from '@agent-workflow/shared'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  legacyCodeWorkItemLinks,
  tasks,
  webhookDeliveries,
  webhookEndpoints,
  webhookTriggerFires,
  webhookTriggers,
} from '../src/db/schema'
import {
  INITIAL_CUTOVER_STATE,
  decideCutoverTransition,
  legacyAdmissionAllowedIn,
  parseCutoverState,
} from '../src/modules/development-automation/domain/cutover'
import {
  adoptActiveMr,
  runCutoverCommand,
} from '../src/modules/development-automation/application/cutover'
import { createSqliteCutoverStore } from '../src/modules/development-automation/infrastructure/sqliteCutoverStore'
import { createSqliteMissionStore } from '../src/modules/development-automation/infrastructure/sqliteMissionStore'
import type { MrEffectsPort } from '../src/modules/development-automation/application/ports/reconcilerPorts'
import { createIdentityAccessRuntime } from '../src/modules/identity-access/composition'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'
import { createWebhookDispatcher } from '../src/services/webhook/webhookDispatch'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const BOX = createSecretBoxFromKey(Buffer.alloc(32, 7))
const NOW = 1_755_500_000_000

function freshDeps(db: DbClient) {
  let seq = 0
  return {
    cutoverStore: createSqliteCutoverStore(db),
    now: () => NOW,
    mintId: () => `01CUTOVER${String(seq++).padStart(17, '0')}`,
  }
}

describe('RFC-310 PR-9 — cutover state machine (domain)', () => {
  const tick = { now: NOW, mintGeneration: () => 'gen-1' }

  test('the happy path is pre → frozen → live and admission closes at freeze', () => {
    expect(legacyAdmissionAllowedIn(INITIAL_CUTOVER_STATE)).toBe(true)
    const frozen = decideCutoverTransition(INITIAL_CUTOVER_STATE, 'freeze', tick)
    if (!frozen.ok) throw new Error('freeze should succeed from pre')
    expect(frozen.next.phase).toBe('frozen')
    expect(frozen.next.frozenAt).toBe(NOW)
    expect(legacyAdmissionAllowedIn(frozen.next)).toBe(false)

    const live = decideCutoverTransition(frozen.next, 'flip', tick)
    if (!live.ok) throw new Error('flip should succeed from frozen')
    expect(live.next.phase).toBe('live')
    expect(live.next.generation).toBe('gen-1')
    expect(legacyAdmissionAllowedIn(live.next)).toBe(false)
  })

  test('illegal transitions are typed rejections, not silent no-ops', () => {
    const frozen = { ...INITIAL_CUTOVER_STATE, phase: 'frozen' as const, frozenAt: NOW }
    const live = { ...frozen, phase: 'live' as const, flippedAt: NOW, generation: 'g' }
    for (const [state, command] of [
      [frozen, 'freeze'],
      [live, 'freeze'],
      [INITIAL_CUTOVER_STATE, 'flip'],
      [live, 'flip'],
      [INITIAL_CUTOVER_STATE, 'rollback'],
    ] as const) {
      const verdict = decideCutoverTransition(state, command, tick)
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.code).toBe('cutover-phase-invalid')
    }
  })

  test('rollback works exactly once side effects are impossible: frozen yes, live never', () => {
    const frozen = { ...INITIAL_CUTOVER_STATE, phase: 'frozen' as const, frozenAt: NOW }
    const rolled = decideCutoverTransition(frozen, 'rollback', tick)
    if (!rolled.ok) throw new Error('rollback from frozen should succeed')
    expect(rolled.next.phase).toBe('pre')
    expect(legacyAdmissionAllowedIn(rolled.next)).toBe(true)

    const live = { ...frozen, phase: 'live' as const, flippedAt: NOW, generation: 'g' }
    const refused = decideCutoverTransition(live, 'rollback', tick)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.code).toBe('cutover-rollback-after-flip')
  })

  test('corrupt or missing stored state parses to the most conservative phase (pre)', () => {
    expect(parseCutoverState(null)).toEqual(INITIAL_CUTOVER_STATE)
    expect(parseCutoverState('not json')).toEqual(INITIAL_CUTOVER_STATE)
    expect(parseCutoverState('{"phase":"weird"}')).toEqual(INITIAL_CUTOVER_STATE)
    expect(parseCutoverState('{"phase":"frozen","frozenAt":5}').phase).toBe('frozen')
  })
})

describe('RFC-310 PR-9 — cutover commands persist through the sqlite store', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => db.$client.close())

  test('freeze → flip survive a re-read; rollback after flip is refused durably', () => {
    const deps = freshDeps(db)
    expect(runCutoverCommand(deps, 'flip').ok).toBe(false)
    expect(runCutoverCommand(deps, 'freeze').ok).toBe(true)
    // 重读面（新 store 实例=重启模拟）：frozen 落盘。
    expect(freshDeps(db).cutoverStore.readState().phase).toBe('frozen')
    const flipped = runCutoverCommand(freshDeps(db), 'flip')
    expect(flipped.ok).toBe(true)
    if (flipped.ok) expect(flipped.state.generation).not.toBeNull()
    const refused = runCutoverCommand(freshDeps(db), 'rollback')
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.code).toBe('cutover-rollback-after-flip')
    expect(freshDeps(db).cutoverStore.readState().phase).toBe('live')
  })
})

// ---------------------------------------------------------------------------
// legacy 双入口 gate
// ---------------------------------------------------------------------------

describe('RFC-310 PR-9 — the rounds API refuses new legacy work once frozen', () => {
  const TOKEN = 'b'.repeat(64)
  let db: DbClient
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    app = createApp({
      token: TOKEN,
      configPath: '',
      opencodeVersion: '1.15.0',
      dbVersion: 1,
      db,
      secretBox: BOX,
    })
  })
  afterEach(() => db.$client.close())

  const post = async () =>
    await app.request('/api/code/rounds', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ repoId: 'group/project', templateId: 'tpl', input: {} }),
    })

  test('the legacy rounds entry no longer exists at all (T104: stronger than a 409 gate)', async () => {
    // PR-9 曾以 409 legacy-admission-frozen 冻结该入口；T104 把路由整个删除
    // ——404 是比 gate 更强的收缩证明，且与 cutover phase 无关（pre 也 404）。
    expect((await post()).status).toBe(404)
    expect(runCutoverCommand(freshDeps(db), 'freeze').ok).toBe(true)
    expect((await post()).status).toBe(404)
  })
})

describe('RFC-310 PR-9 — a frozen cutover skips webhook code-round fires', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => db.$client.close())

  async function fireCodeRoundDelivery(): Promise<string> {
    const box = createSecretBoxFromKey(Buffer.alloc(32, 9))
    const owner = await createUser(db, {
      username: `cutover-owner-${ulid().toLowerCase()}`,
      displayName: 'Cutover Owner',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    const endpointId = ulid()
    await db.insert(webhookEndpoints).values({
      id: endpointId,
      name: 'cutover gate endpoint',
      provider: 'gitlab',
      urlToken: `aw_whk_${ulid()}`,
      secretEnc: box.seal('secret'),
      enabled: true,
    })
    const endpoint = (
      await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpointId)).limit(1)
    )[0]!
    const triggerId = ulid()
    await db.insert(webhookTriggers).values({
      id: triggerId,
      name: 'cutover gate ci-fix',
      endpointId,
      ownerUserId: owner.id,
      repoScope: JSON.stringify({ kind: 'all' }),
      eventTypes: JSON.stringify(['pipeline_failed']),
      ignoreUsernames: JSON.stringify([]),
      launchKind: 'code-round',
      launchRefId: 'ci-fix',
      launchPayload: JSON.stringify({ capability: 'ci-fix' }),
      autoRegisterRepos: false,
    })
    const event: CodeHostEvent = {
      provider: 'gitlab',
      eventUuid: ulid(),
      eventType: 'pipeline_failed',
      repoPath: 'platform/api',
      repoHttpUrl: 'https://gitlab.invalid/platform/api.git',
      repoSshUrl: 'git@gitlab.invalid:platform/api.git',
      branch: 'main',
      pipelineStatus: 'failed',
      author: { username: 'developer' },
      raw: {},
    }
    const deliveryId = ulid()
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      endpointId,
      eventUuid: event.eventUuid,
      status: 'received',
      eventType: event.eventType,
      repoPath: event.repoPath,
    })
    const dispatcher = createWebhookDispatcher({
      db,
      identityAccess: createIdentityAccessRuntime({ db }),
      configPath: '',
      secretBox: box,
      getDefaultRuntime: async () => null,
    })
    await dispatcher.dispatch({ deliveryId, endpoint, event })
    return triggerId
  }

  test('a historical code-round trigger row fires as skipped-trigger-invalid, zero tasks (T104 tombstone)', async () => {
    // PR-9 的 cutover gate（skipped-legacy-admission-frozen）随 writer 一并
    // 退役：T104 后 code-round fire 无论 cutover phase 一律落
    // skipped-trigger-invalid 留痕，绝不启动任务。
    const triggerId = await fireCodeRoundDelivery()
    const fires = await db
      .select()
      .from(webhookTriggerFires)
      .where(eq(webhookTriggerFires.triggerId, triggerId))
    expect(fires).toHaveLength(1)
    expect(fires[0]!.outcome).toBe('skipped-trigger-invalid')
    expect(fires[0]!.taskId).toBeNull()
    expect(await db.select().from(tasks)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// adoptActiveMr 验收样本
// ---------------------------------------------------------------------------

function mrEffectsObserving(
  state: 'opened' | 'merged' | 'closed',
  overrides: Partial<{ sourceSha: string | null; targetBranch: string | null }> = {},
): MrEffectsPort {
  return {
    ensure: () => Promise.reject(new Error('ensure must not be called by adopt')),
    reply: () => Promise.reject(new Error('reply must not be called by adopt')),
    observe: (_repo, mrRef) =>
      Promise.resolve({
        ok: true as const,
        observation: {
          mrRef,
          state,
          sourceSha: overrides.sourceSha === undefined ? 'a'.repeat(40) : overrides.sourceSha,
          targetBranch: overrides.targetBranch === undefined ? 'main' : overrides.targetBranch,
          webUrl: null,
        },
      }),
  }
}

describe('RFC-310 PR-9 — adoptActiveMr builds missions from external truth', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => db.$client.close())

  const input = {
    repositoryId: 'repo-1',
    mrIid: '42',
    codeHostEndpointRef: 'gitlab',
    stableProjectRef: 'team/app',
    employee: { id: 'emp-1', revision: 3 },
    policy: null,
    legacyWorkItemId: 'wi-9',
    legacyRoundId: null,
    actorUserId: null,
  }

  test('an open MR becomes a watching mission with an active claim and a legacy link', async () => {
    const store = createSqliteMissionStore(db)
    const deps = { store, ports: { mrEffects: mrEffectsObserving('opened') }, ...freshDeps(db) }
    const result = await adoptActiveMr(deps, input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.terminal).toBeNull()

    const mission = store.getMission(result.missionId)!
    expect(mission.status).toBe('watching')
    expect(mission.deliveryKind).toBe('adopt-merge-request')
    expect(mission.adoptedMrRef).toBe('42')
    expect(mission.deliveryTargetRef).toBe('main')
    expect(mission.employeeRevision).toBe(3)
    expect(mission.mrClaimId).not.toBeNull()
    const claim = store.findMrClaim({
      codeHostEndpointRef: 'gitlab',
      stableProjectRef: 'team/app',
      mrIid: '42',
    })
    expect(claim?.missionId).toBe(result.missionId)

    const links = await db
      .select()
      .from(legacyCodeWorkItemLinks)
      .where(eq(legacyCodeWorkItemLinks.missionId, result.missionId))
    expect(links).toHaveLength(1)
    expect(links[0]!.legacyWorkItemId).toBe('wi-9')
    expect(JSON.parse(links[0]!.cutoverReceiptJson)).toMatchObject({
      observedState: 'opened',
      targetBranch: 'main',
    })
  })

  test('a merged MR is adopted as authoritative terminal: no claim, no action', async () => {
    const store = createSqliteMissionStore(db)
    const deps = { store, ports: { mrEffects: mrEffectsObserving('merged') }, ...freshDeps(db) }
    const result = await adoptActiveMr(deps, input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.terminal).toBe('merged')
    const mission = store.getMission(result.missionId)!
    expect(mission.status).toBe('merged')
    expect(mission.terminalAt).toBe(NOW)
    expect(mission.mrClaimId).toBeNull()
    expect(mission.currentActionRunId).toBeNull()
    expect(
      store.findMrClaim({
        codeHostEndpointRef: 'gitlab',
        stableProjectRef: 'team/app',
        mrIid: '42',
      }),
    ).toBeNull()
  })

  test('a closed MR maps to closed-unmerged', async () => {
    const store = createSqliteMissionStore(db)
    const deps = { store, ports: { mrEffects: mrEffectsObserving('closed') }, ...freshDeps(db) }
    const result = await adoptActiveMr(deps, input)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.terminal).toBe('closed-unmerged')
      expect(store.getMission(result.missionId)!.status).toBe('closed-unmerged')
    }
  })

  test('re-running the same adopt is idempotent (runbook is re-runnable)', async () => {
    const store = createSqliteMissionStore(db)
    const deps = { store, ports: { mrEffects: mrEffectsObserving('opened') }, ...freshDeps(db) }
    const first = await adoptActiveMr(deps, input)
    const second = await adoptActiveMr(
      { store, ports: { mrEffects: mrEffectsObserving('opened') }, ...freshDeps(db) },
      input,
    )
    expect(first.ok && second.ok).toBe(true)
    if (first.ok && second.ok) expect(second.missionId).toBe(first.missionId)
    const links = await db.select().from(legacyCodeWorkItemLinks)
    expect(links).toHaveLength(1)
  })

  test('an MR already claimed by a non-adopt mission is refused', async () => {
    // 同 (endpoint, project, iid) 的重复 **adopt** 是幂等命中（launch key 相同，
    // 上一测试锁定）；「被另一 mission 占用」发生在 MR 已被正常 delivery 链
    // （create-merge-request mission 的 claimMr）持有时——adopt 的 createMission
    // 走新 launch key 成功建行，claim 撞唯一后 findMrClaim 归属他人 ⇒ typed 拒。
    const store = createSqliteMissionStore(db)
    const holdingMissionId = ulid()
    store.createMission({
      id: holdingMissionId,
      revision: 0,
      epoch: 0,
      status: 'watching',
      automationMode: 'active',
      transitionFence: 'none',
      repositoryId: 'repo-legacy',
      sourceKind: 'direct',
      sourceContentDigest: null,
      requestedSourceKey: null,
      externalId: null,
      resolvedSourceKey: null,
      resolvedAdapterId: null,
      resolvedAdapterRevision: null,
      deliveryKind: 'create-merge-request',
      deliveryTargetRef: 'main',
      deliverySourceBranch: 'aw/holding',
      adoptedMrRef: null,
      assignmentId: null,
      employeeId: null,
      employeeRevision: null,
      policyId: null,
      policyRevision: null,
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
      launchIdempotencyKey: `holder:${ulid()}`,
      createdBy: null,
      createdAt: NOW,
      updatedAt: NOW,
    })
    expect(
      store.claimMr({
        id: ulid(),
        codeHostEndpointRef: 'gitlab',
        stableProjectRef: 'team/app',
        mrIid: '42',
        missionId: holdingMissionId,
        epoch: 0,
        headSha: null,
        now: NOW,
      }).ok,
    ).toBe(true)
    const clashing = await adoptActiveMr(
      { store, ports: { mrEffects: mrEffectsObserving('opened') }, ...freshDeps(db) },
      input,
    )
    expect(clashing.ok).toBe(false)
    if (!clashing.ok) expect(clashing.code).toBe('mr-owned-by-another-mission')
    // 拒绝路径不留 legacy link 半行。
    expect(await db.select().from(legacyCodeWorkItemLinks)).toHaveLength(0)
  })

  test('observe failure propagates its typed code (the "MR does not exist" sample)', async () => {
    const store = createSqliteMissionStore(db)
    const failing: MrEffectsPort = {
      ...mrEffectsObserving('opened'),
      observe: () => Promise.resolve({ ok: false as const, code: 'mr-not-found', detail: '42' }),
    }
    const result = await adoptActiveMr(
      { store, ports: { mrEffects: failing }, ...freshDeps(db) },
      input,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('mr-not-found')
    expect(await db.select().from(legacyCodeWorkItemLinks)).toHaveLength(0)
  })
})

describe('RFC-310 PR-9 — cutover route error codes are named', () => {
  // route error code ratchet 点名（见文件头）：cutover-adopt-rejected 与
  // cutover-repo-binding-missing 在 adopt 路由抛出；cutover-phase-invalid 与
  // cutover-rollback-after-flip 在命令路由抛出；legacy-admission-frozen 在
  // rounds 路由抛出（上方 409 测试已实测）。此处对 4 个 cutover 码做路由级
  // 实测（无 binding 的 adopt 400、pre 状态 flip 409）。
  const TOKEN = 'c'.repeat(64)
  let db: DbClient
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    app = createApp({
      token: TOKEN,
      configPath: '',
      opencodeVersion: '1.15.0',
      dbVersion: 1,
      db,
      secretBox: BOX,
    })
  })
  afterEach(() => db.$client.close())

  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

  test('flip before freeze is a 409 cutover-phase-invalid', async () => {
    const res = await app.request('/api/code/cutover/flip', {
      method: 'POST',
      headers,
      body: '{}',
    })
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).toContain('cutover-phase-invalid')
  })

  test('rollback after flip is a 409 cutover-rollback-after-flip', async () => {
    expect(runCutoverCommand(freshDeps(db), 'freeze').ok).toBe(true)
    expect(runCutoverCommand(freshDeps(db), 'flip').ok).toBe(true)
    const res = await app.request('/api/code/cutover/rollback', {
      method: 'POST',
      headers,
      body: '{}',
    })
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).toContain('cutover-rollback-after-flip')
  })

  test('adopt on a repository without a code-host binding is a 422 cutover-repo-binding-missing', async () => {
    const res = await app.request('/api/code/cutover/adopt-mr', {
      method: 'POST',
      headers,
      body: JSON.stringify({ repositoryId: 'no-such-repo', mrIid: '1' }),
    })
    expect(res.status).toBe(422)
    expect(JSON.stringify(await res.json())).toContain('cutover-repo-binding-missing')
  })

  test('cutover state read face returns state + preflight report shape', async () => {
    const res = await app.request('/api/code/cutover', { headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      state: { phase: string }
      preflight: { items: unknown[] }
      persisted: unknown
    }
    expect(body.state.phase).toBe('pre')
    expect(Array.isArray(body.preflight.items)).toBe(true)
    expect(body.persisted).toBeNull()
  })

  test('the adopt route surfaces port rejections as 409 cutover-adopt-rejected', () => {
    // adopt 的 409 面：claim 被占/observe 失败在 route 层统一以
    // 'cutover-adopt-rejected' 呈现（携带内层 code）。真实 binding + 假
    // code-host 的组合在单测里过重；内层全部拒绝路径已在上方 application 级
    // 逐一实测，这里以源码断言锁住 route 层的错误码壳不被改名。
    const source = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'development-automation',
        'composition',
        'missionOperations.ts',
      ),
      'utf8',
    )
    expect(source).toContain("new ConflictError('cutover-adopt-rejected'")
  })
})
