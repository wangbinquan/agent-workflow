// RFC-349 回归防护 —— 崩溃后接着跑的「排队中工作上下文」必须以**被正式 admit 的**属主身份跑。
//
// 为什么这条测试存在：`resumeQueuedIntentWorkingSets` 原先自己捏一个 actor
// （`legacyProjection.fromResolvedSubject(...)`）。RFC-345 之后 Resource Catalog 只
// 认注册表自己铸出来的授权：`authorityForLegacyProjection` 拿不到对应句柄就抛
// `foreign-legacy-actor-projection`，而 `resourceCatalogFor(actor)` 在组装时**立刻**
// 就要这对句柄。于是 daemon 每次崩在生成中、重启后想把排队的那条变更接着做完时，
// 第一步就炸，只在日志里留下一行 `queued intent working-set admission failed`：
// 那行变更永远停在 queued，没有任何人会再碰它，用户的会话就永远停在「生成中」。
// e2e `rfc319-intent-timeline-and-turns` INTENT-X8 死在这条上。
//
// 判据：①按**生产同款**接线（authorityFor / contextFor 都走注册表）组装的目录，能接住
// 启动恢复递给它的 actor，排队那条变更真的推进到 applied；②当年那种手捏投影**确实**
// 会被同一个目录拒掉——这条把「为什么不能手捏」钉在测试里，而不是靠注释。

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { buildActor, type Actor } from '../src/auth/actor'
import { admitDurableWorkOwner } from '../src/auth/session'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { intentSessions, intentWorkingSetChanges } from '../src/db/schema'
import { createIdentityAccessRuntime } from '../src/modules/identity-access/composition'
import {
  composeSqliteIntentPersistence,
  createSqliteIntentPersistence,
} from '../src/modules/intent/composition/persistence'
import {
  composeIntentDumpAuxiliaryQueries,
  composeIntentTurnRuntimeResolver,
} from '../src/modules/intent/composition/auxiliaryQueries'
import type {
  IntentContextResourceAuthorization,
  IntentPersistence,
} from '../src/modules/intent/public/operations'
import { composeSqliteResourceCatalog } from '../src/modules/resource-catalog/composition/providerResourceCatalog'
import { composeSqliteIntentContextResourceAuthorizationSyncFactory } from '../src/modules/resource-catalog/composition/intentContextAuthorization'
import { directOperationAuthority, directRequestAuthority } from '../src/routes/operationAuthority'
import { resumeQueuedIntentWorkingSets } from '../src/services/intent/dispatcher'
import {
  composeIntentResourceCatalogFor,
  intentResourceVisibility,
  type IntentResourceCatalogFor,
} from '../src/services/intent/resourceCatalog'
import { createIntentSession, insertUserTurnAndReserve } from '../src/services/intent/session'
import { cancelIntentTurn } from '../src/services/intent/turnEngine'
import { submitIntentWorkingSetChange } from '../src/services/intent/workingSet'
import { createAgent } from '../src/services/agent'
import { seedBuiltinRuntimes } from '../src/services/runtimeRegistry'
import { emptySystemAgentOutputEvidence } from '../src/services/systemAgentRun'
import type { SystemAgentRunOptions, SystemAgentRunResult } from '../src/services/systemAgentRun'
import { intentResourceCatalogBinding } from './helpers/intentResourceCatalogBinding'
import { runtimeRegistryPersistence } from './helpers/runtimeRegistryPersistence'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

let db: DbClient
let actor: Actor
let persistence: IntentPersistence
let visibility: IntentContextResourceAuthorization
let identityAccess: ReturnType<typeof createIdentityAccessRuntime>
let mountedAgentId: string

/**
 * 与 `cli/start.ts` / `cli/postgresqlDaemonApplication.ts` 同款接线：授权与查询上下文
 * 都必须由 identity-access 注册表铸出，不接受调用方自带的 actor 对象。
 * `catalogs` 只喂给逐资源的 detail 查询，本条路径不会碰——碰了就说明判据跑偏了。
 */
function productionShapedResourceCatalogFor(): IntentResourceCatalogFor {
  const catalog = composeSqliteResourceCatalog({ db })
  const actorsByContext = new WeakMap<object, Actor>()
  // 逐资源 detail 查询由被派发的那一轮（intent dump）使用；本用例的判据在激活那一步，
  // 所以给它们一个良性返回，别让 dump 的失败盖住真正要看的东西。
  const unusedDetail = async () => null
  return composeIntentResourceCatalogFor({
    query: catalog.createQuery({
      resolveActor(context) {
        const bound = actorsByContext.get(context)
        if (bound === undefined) throw new Error('intent-resource-catalog-context-not-bound')
        return bound
      },
    }),
    contextFor(candidate) {
      const context = identityAccess.contexts.queryFromAuthority(
        directRequestAuthority(identityAccess.directAuthority, candidate),
        'http',
      )
      actorsByContext.set(context, candidate)
      return context
    },
    authorityFor: (candidate) =>
      directOperationAuthority(identityAccess.directAuthority, candidate),
    catalogs: {
      agents: { get: unusedDetail },
      skills: {
        content: async () => ({
          name: '',
          description: '',
          frontmatterExtra: {},
          bodyMd: '',
        }),
      },
      skillFiles: { list: async () => [], read: async () => ({ path: '', content: '' }) },
      mcps: { get: unusedDetail },
      plugins: { get: unusedDetail },
      workflows: { get: unusedDetail },
      workgroups: { get: unusedDetail },
    },
  })
}

const runFn = async (opts: SystemAgentRunOptions): Promise<SystemAgentRunResult> => {
  const nonce = /nonce="([^"]+)"/.exec(opts.prompt)?.[1] ?? ''
  return {
    status: 'ok',
    exitCode: 0,
    eventText:
      `<workflow-output nonce="${nonce}">` +
      '<port name="summary">resumed</port>' +
      `<port name="changeset">${JSON.stringify({ $schema_version: 1, ops: [] })}</port>` +
      '</workflow-output>',
    stderrTail: '',
    durationMs: 1,
    scratchDir: '/tmp/rfc349-intent-resume',
    scratchRetained: false,
    outputEvidence: emptySystemAgentOutputEvidence(),
  }
}

beforeEach(async () => {
  db = createInMemoryDb(MIGRATIONS)
  identityAccess = createIdentityAccessRuntime({ db })
  persistence = composeSqliteIntentPersistence({
    db,
    contextAuthorization: composeSqliteIntentContextResourceAuthorizationSyncFactory(),
  })
  await seedBuiltinRuntimes(runtimeRegistryPersistence(db))
  const { createUser } = await import('../src/services/users')
  const owner = await createUser(db, {
    username: `owner-${ulid().toLowerCase()}`,
    displayName: 'Owner',
    role: 'user',
    password: 'longEnoughPassword',
  })
  actor = buildActor({
    user: {
      id: owner.id,
      username: owner.username,
      displayName: owner.displayName,
      role: 'user',
      status: 'active',
    },
    source: 'session',
  })
  visibility = intentResourceVisibility(intentResourceCatalogBinding(db, actor))
  const agent = await createAgent(
    db,
    {
      name: `mounted-${ulid().toLowerCase()}`,
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: 'mounted fixture',
    },
    { ownerUserId: owner.id },
  )
  mountedAgentId = agent.id
})

/**
 * 生成中被 kill：一行 queued 变更 + 一个已经没人驱动的会话。
 *
 * 变更里**必须有 addition**：只删不加的 delta 根本不会触发事务内的资源鉴权，
 * 而那正是这条用例要锁的那一段（初版夹具只写 removals，于是把生产里必炸的
 * `intent-context-authorization-not-composed` 整个漏掉了）。
 */
async function seedQueuedSuccessor(): Promise<{ sessionId: string; changeId: string }> {
  const session = (
    await createIntentSession(persistence, visibility, actor, { message: 'build it' })
  ).session
  db.update(intentSessions)
    .set({
      contextManifestJson: JSON.stringify([
        {
          handle: 'res#agent#1',
          resourceType: 'agent',
          resourceId: 'legacy-resource',
          root: true,
          detail: false,
        },
      ]),
      handleWatermarkJson: JSON.stringify({ agent: 1 }),
    })
    .where(eq(intentSessions.id, session.id))
    .run()
  await insertUserTurnAndReserve(persistence, actor, session.id, 'message', { message: 'run' }, 50)
  const running = db.select().from(intentSessions).where(eq(intentSessions.id, session.id)).get()!
  const queued = await submitIntentWorkingSetChange(
    persistence,
    visibility,
    actor,
    session.id,
    {
      clientMutationId: ulid(),
      expectedTurnSeq: running.turnSeq,
      expectedContextRevision: running.contextRevision,
      mode: 'after-current',
      delta: {
        additions: [{ resourceType: 'agent', resourceId: mountedAgentId }],
        removals: ['res#agent#1'],
      },
    },
    50,
  )
  expect(queued.change.state, '夹具没排上队 ⇒ 下面测的就不是这条路径').toBe('queued')
  // 崩溃留下的是「排队中 + 那一轮再也不会完成」；取消当前轮等价于孤儿轮已被结算。
  expect(await cancelIntentTurn(persistence, actor, session.id)).toBe(true)
  return { sessionId: session.id, changeId: queued.change.id }
}

describe('RFC-349 intent boot resume authority', () => {
  test('boot recovery finishes the queued successor through the production catalog seam', async () => {
    const { sessionId, changeId } = await seedQueuedSuccessor()
    const resumed = await resumeQueuedIntentWorkingSets({
      persistence,
      identityAccess,
      appHome: '/tmp',
      configSnapshot: DEFAULT_CONFIG,
      runtimeResolver: composeIntentTurnRuntimeResolver(persistence),
      dumpAuxiliary: composeIntentDumpAuxiliaryQueries({
        persistence,
        platformInventory: Object.freeze({
          async listRows() {
            return []
          },
        }),
      }),
      resourceCatalogFor: productionShapedResourceCatalogFor(),
      runFn,
    })
    expect(
      resumed,
      '启动恢复一条都没领走 ⇒ 排队的变更永远停在 queued，会话永远停在「生成中」',
    ).toBe(1)
    expect(
      db
        .select()
        .from(intentWorkingSetChanges)
        .where(eq(intentWorkingSetChanges.id, changeId))
        .get()?.state,
    ).toBe('applied')
    expect(sessionId).not.toBe('')
  })

  test('the plain SQLite runner cannot authorize a context mutation — the daemon must not dispatch with it', async () => {
    // 这条锁的是「为什么 start.ts 必须用 authorized 组装」：换成 plain runner，
    // 同一条排队变更会以 `intent-context-authorization-not-composed` 收场——正是
    // e2e INTENT-X8 在生产二进制里看到的那一幕（变更被判 failed，会话永远转圈）。
    const { changeId } = await seedQueuedSuccessor()
    await resumeQueuedIntentWorkingSets({
      persistence: createSqliteIntentPersistence(db),
      identityAccess,
      appHome: '/tmp',
      configSnapshot: DEFAULT_CONFIG,
      runtimeResolver: composeIntentTurnRuntimeResolver(persistence),
      dumpAuxiliary: composeIntentDumpAuxiliaryQueries({
        persistence,
        platformInventory: Object.freeze({
          async listRows() {
            return []
          },
        }),
      }),
      resourceCatalogFor: productionShapedResourceCatalogFor(),
      runFn,
    })
    const row = db
      .select()
      .from(intentWorkingSetChanges)
      .where(eq(intentWorkingSetChanges.id, changeId))
      .get()
    expect(row?.state).toBe('failed')
    expect(row?.error ?? '').toContain('intent-context-authorization-not-composed')
  })

  test('the SQLite daemon composes the authorized intent persistence, like the app and the PostgreSQL daemon', () => {
    const source = readFileSync(resolve(import.meta.dir, '..', 'src', 'cli', 'start.ts'), 'utf8')
    // 只把那一段截出来断言：整份 start.ts 进断言消息会把失败输出淹掉。
    const at = source.indexOf('const intentPersistence =')
    expect(at, 'start.ts 里找不到 intentPersistence 的组装（结构变了？）').toBeGreaterThan(-1)
    const composition = source.slice(at, at + 300)
    expect(
      composition,
      'daemon 又用回了不带资源鉴权的 runner ⇒ 任何「加资源」的工作上下文变更都会在事务里炸',
    ).toContain('composeSqliteIntentPersistence({')
    expect(composition).toContain('contextAuthorization:')
    expect(source.includes('createSqliteIntentPersistence(')).toBe(false)
  })

  test('a hand-built projection is exactly what the catalog refuses', async () => {
    const resourceCatalogFor = productionShapedResourceCatalogFor()
    const admitted = await admitDurableWorkOwner(identityAccess, actor.user.id)
    expect(admitted, '属主还在，却 admit 不出来').not.toBeNull()
    expect(() => resourceCatalogFor(admitted!.actor as unknown as Actor)).not.toThrow()

    // 当年那条路径就是这个形状：账号事实齐全、但没有任何注册表句柄与之配对。
    const current = await identityAccess.resolveAuthority.resolveCurrentSubject(actor.user.id)
    const handBuilt = Object.freeze({
      user: Object.freeze({
        id: current!.userId,
        username: current!.username,
        displayName: current!.displayName,
        role: current!.role,
        status: current!.status,
      }),
      userId: current!.userId,
      source: 'daemon' as const,
      permissions: new Set<never>(),
      authorityRevision: current!.accessRevision,
    })
    expect(
      () => resourceCatalogFor(handBuilt as unknown as Actor),
      '手捏的投影居然被目录接受了 ⇒ 上面那条「必须正式 admit」的判据失去意义',
    ).toThrow('foreign-legacy-actor-projection')
  })
})
