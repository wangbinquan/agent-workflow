// RFC-359 W11 —— 两台 apply 编排机的**事务边界**双引擎对拍。
//
// # 为什么这些用例存在
//
// `rfc359-w5-t18-bare-transaction.test.ts` 的账本里，这两台编排机是最后还直接调驱动
// `.transaction(` 的业务代码（各 2 处：认领事务 + 提交事务）。裸驱动事务的危害不是
// 「不好看」，是**它把整段编排钉死在一个引擎上**：`bun:sqlite` 的 `Database.transaction`
// 是同步包装器，async 回调在第一个 `await` 处被当作已返回并当场 COMMIT，之后的语句全在
// autocommit 里跑、再抛错什么也回滚不了。也就是说同一段代码换个客户端就**静默失去原子性**
// ——不报错、happy path 还全绿，只有在「事务体中途失败」时才第一次现形。
//
// 所以本文件的判据全部是**中途失败后的残留**，而不是 happy path 的返回值：
//
//   ① 认领事务：journal 行已插入、事务尚未提交时抛 ⇒ 该行必须不存在（认领同生共死）。
//   ② 提交事务：事务体内已经写过东西（provenance 行 / 参与者经事务句柄写的行）之后抛 ⇒
//      那些写必须一并消失。
//
// 两条判据在**两个引擎上都必须成立**——这正是「一个事务体、两个 provider、一份实现」的
// 可观测面。改造前实测：PostgreSQL 全绿（驱动事务本来就是 async 原子的），SQLite 全红
// （同步包装器提前 COMMIT），红的正是「这段编排此刻只有一个 provider 能跑」这件事。
//
// # 为什么用替身驱动真实管线
//
// 两台编排机的资源会话都是**注入的接口**。这里测的是编排层自己的事务边界，不是资源目录的
// 六条提交臂，所以资源会话用替身：替身在提交事务里经**它拿到的那个事务句柄**写一行标记，
// 于是「这一行有没有留下」就直接回答了「参与者的写在不在这笔事务里」。

import { randomBytes, createHash } from 'node:crypto'
import { beforeEach, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  INTENT_CHANGESET_SCHEMA_VERSION,
  canonicalIntentJson,
  parseIntentChangeset,
} from '@agent-workflow/shared'

import type { Actor } from '@/auth/actor'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import {
  intentApplyJournal,
  intentDrafts,
  intentProvenance,
  intentSessions,
  resourceBundleApplies,
  users,
} from '@/db/schema'
import type { IntentApplyInput } from '@/modules/intent/application/ports/intentApplyOperations'
import { createPostgresqlIntentApplyOperations } from '@/modules/intent/infrastructure/postgresqlIntentApplyOperations'
import type { PostgresqlIntentApplyResourceSession } from '@/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlIntentApplyResourceParticipants'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createPostgresqlResourcePackageAtomicApplyOperations } from '@/platform/persistence/postgresqlResourcePackageAtomicApply'
import { parseResourcePackage } from '@/services/resourcePackage/parse'
import { signPreviewToken } from '@/services/resourcePackage/preview'
import { encodeZip } from '@/util/zip'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

// ─────────────────────────────────────────────────────────────────────────────
// 公共夹具
// ─────────────────────────────────────────────────────────────────────────────

const OWNER = 'user_rfc359_w11_owner'
const AUTHORITY = Object.freeze({}) as ResourceRequestContext
const WRITE_ALL = ['agents', 'skills', 'mcps', 'plugins', 'workflows', 'workgroups'].flatMap(
  (type) => [`${type}:create`, `${type}:update`],
)

const ACTOR: Actor = {
  user: {
    id: OWNER,
    username: 'w11-owner',
    displayName: 'W11 owner',
    role: 'user',
    status: 'active',
  },
  source: 'session',
  permissions: new Set<string>(['resource-acl:private', ...WRITE_ALL]),
} as unknown as Actor

async function seedOwner(harness: ProviderHarness): Promise<void> {
  const now = Date.now()
  await harness.db.insert(users).values({
    id: OWNER,
    username: 'w11-owner',
    displayName: 'W11 owner',
    role: 'user',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  } as typeof users.$inferInsert)
}

/** 事务体内抛出的哨兵：断言只关心「残留」，不关心错误怎么冒泡。 */
class Boom extends Error {
  constructor(where: string) {
    super(`w11-boom:${where}`)
  }
}

async function rejects(run: () => Promise<unknown>): Promise<unknown> {
  return await run().then(
    () => {
      throw new Error('expected the apply to reject, but it resolved')
    },
    (error: unknown) => error,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Intent apply 编排：认领事务 / 提交事务
// ─────────────────────────────────────────────────────────────────────────────

function intentChangeset(name: string) {
  return {
    $schema_version: INTENT_CHANGESET_SCHEMA_VERSION,
    ops: [
      {
        opId: 'op-1',
        action: 'create',
        resourceType: 'agent',
        tempRef: '$new:worker',
        payload: {
          name,
          description: 'w11 conformance worker',
          outputs: ['out'],
          skills: [],
          mcp: [],
          plugins: [],
          dependsOn: [],
          bodyMd: 'You work.',
        },
      },
    ],
  }
}

interface IntentFixture {
  readonly sessionId: string
  readonly draftId: string
  readonly draftRevision: number
  readonly draftHash: string
}

async function seedIntentSession(harness: ProviderHarness, name: string): Promise<IntentFixture> {
  const now = Date.now()
  const sessionId = ulid()
  const draftId = ulid()
  await harness.db.insert(intentSessions).values({
    id: sessionId,
    ownerUserId: OWNER,
    title: 'RFC-359 W11 apply',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  } as typeof intentSessions.$inferInsert)

  const parsed = parseIntentChangeset(JSON.stringify(intentChangeset(name)))
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  const canonical = canonicalIntentJson(parsed.changeset)
  const draftHash = `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
  await harness.db.insert(intentDrafts).values({
    id: draftId,
    sessionId,
    revision: 1,
    changesetJson: canonical,
    validationJson: '{"errors":[],"credentialFindings":[]}',
    draftHash,
    contextRevision: 0,
    createdAt: now,
  } as typeof intentDrafts.$inferInsert)
  await harness.db
    .update(intentSessions)
    .set({ currentDraftId: draftId })
    .where(eq(intentSessions.id, sessionId))
  return { sessionId, draftId, draftRevision: 1, draftHash }
}

function intentCommand(fixture: IntentFixture): IntentApplyInput {
  return {
    sessionId: fixture.sessionId,
    clientMutationId: ulid(),
    draftRevision: fixture.draftRevision,
    draftHash: fixture.draftHash,
    decisions: [],
  }
}

/** 最小资源会话替身：正向全通过，提交臂只回一张收据（不写库）。 */
function intentResourceSession(): PostgresqlIntentApplyResourceSession {
  return {
    async preflight() {
      return Object.freeze({
        occupiedNames: new Map(),
        copyOnlyTargets: new Map<string, string>(),
      })
    },
    async prepare() {},
    async prestage() {},
    createTransactionAttempt() {
      return Object.freeze({
        participant: {
          authorizeAndCommit: async () => ({
            kind: 'agent',
            operationId: 'op-1',
            resourceId: 'r',
            action: 'create',
            revision: {},
          }),
        },
        commitSucceeded() {},
      })
    },
    async rollForwardCommitted() {},
    async broadcastCommitted() {},
    async abortPrepared() {},
  } as unknown as PostgresqlIntentApplyResourceSession
}

function intentApplyPort(harness: ProviderHarness) {
  const session = intentResourceSession()
  return createPostgresqlIntentApplyOperations({
    db: harness.db as PostgresqlDatabaseClient,
    resources: { createSession: () => session },
    artifacts: {
      compensate: async () => {},
      rollForward: async () => true,
    } as never,
  })
}

describeEachProvider('RFC-359 W11 Intent apply 编排 · 事务边界', (harness) => {
  beforeEach(async () => {
    await seedOwner(harness)
  })

  test('认领事务：journal 已插入后抛 ⇒ 整笔回滚，那一行不存在', async () => {
    const fixture = await seedIntentSession(harness, 'w11-claim')
    const operations = intentApplyPort(harness)

    const error = await rejects(
      async () =>
        await operations.apply({
          actor: ACTOR,
          authority: AUTHORITY,
          command: intentCommand(fixture),
          faults: {
            inClaimTxAfterJournal: () => {
              throw new Boom('claim')
            },
          },
        }),
    )
    expect((error as Error).message).toContain('w11-boom:claim')

    const journal = await harness.db
      .select()
      .from(intentApplyJournal)
      .where(eq(intentApplyJournal.sessionId, fixture.sessionId))
    expect(
      journal,
      '认领事务体内抛错后 journal 行仍在：这笔事务没有回滚——编排机此刻只有一个引擎跑得对',
    ).toEqual([])
  })

  test('提交事务：provenance 已写入后抛 ⇒ 整笔回滚，provenance 与会话代次都不前进', async () => {
    const fixture = await seedIntentSession(harness, 'w11-commit')
    const operations = intentApplyPort(harness)

    const error = await rejects(
      async () =>
        await operations.apply({
          actor: ACTOR,
          authority: AUTHORITY,
          command: intentCommand(fixture),
          faults: {
            inTxAfterOps: () => {
              throw new Boom('commit')
            },
          },
        }),
    )
    expect((error as Error).message).toContain('w11-boom:commit')

    const provenance = await harness.db
      .select()
      .from(intentProvenance)
      .where(eq(intentProvenance.sessionId, fixture.sessionId))
    expect(
      provenance,
      '提交事务体内抛错后 provenance 行仍在：事务体内的写没有回滚（同步包装器已提前 COMMIT）',
    ).toEqual([])

    const [session] = await harness.db
      .select()
      .from(intentSessions)
      .where(eq(intentSessions.id, fixture.sessionId))
      .limit(1)
    expect(session?.commitSeq ?? 0, '提交失败后会话代次不应前进').toBe(0)
    expect(session?.currentDraftId, '提交失败后当前草稿不应被关闭').toBe(fixture.draftId)
  })

  test('认领事务成功路径：journal 落在 prepared，认领与四道读判据同生共死', async () => {
    const fixture = await seedIntentSession(harness, 'w11-claim-ok')
    const operations = intentApplyPort(harness)

    const error = await rejects(
      async () =>
        await operations.apply({
          actor: ACTOR,
          authority: AUTHORITY,
          command: intentCommand(fixture),
          faults: {
            beforeTx: () => {
              throw new Boom('before-commit-tx')
            },
          },
        }),
    )
    expect((error as Error).message).toContain('w11-boom:before-commit-tx')

    const journal = await harness.db
      .select()
      .from(intentApplyJournal)
      .where(eq(intentApplyJournal.sessionId, fixture.sessionId))
    expect(journal.length, '认领事务已提交 ⇒ journal 行必须留下来给收敛看见').toBe(1)
    expect(journal[0]?.state).toBe('failed')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B. 资源包原子导入编排：认领事务 / 提交事务
// ─────────────────────────────────────────────────────────────────────────────

const PACKAGE_SLUG = 'mcp-tools'
const MINTED_MCP_ID = 'mcp_w11_minted'
/** 参与者在提交事务里经它拿到的事务句柄写下的标记行；回滚后必须消失。 */
const MARKER_SCOPE = 'w11-marker'

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

function packageZip(): Uint8Array {
  return encodeZip([
    {
      path: 'manifest.yaml',
      bytes: utf8(`formatVersion: 1
exportedAt: 0
root:
  slug: ${PACKAGE_SLUG}
  type: mcp
  name: tools
resources:
  - slug: ${PACKAGE_SLUG}
    type: mcp
    name: tools
requirements:
  mcpKinds:
    - remote
secrets: []
danglingCallRefs: []
`),
    },
    {
      path: 'bundle.json',
      bytes: utf8(
        JSON.stringify({
          bundleVersion: 1,
          ops: [
            {
              opId: 'op-1',
              kind: 'mcp-create',
              slug: PACKAGE_SLUG,
              payload: {
                name: 'tools',
                description: 'from package',
                type: 'remote',
                config: { url: 'https://pkg.test/mcp' },
                enabled: true,
              },
            },
          ],
          rootRef: `local:${PACKAGE_SLUG}`,
        }),
      ),
    },
  ])
}

interface PackageSessionOptions {
  /** 参与者提交后、`resolveRoot` 取根资源时的返回：null ⇒ 提交事务体在写之后抛。 */
  readonly rootExists: boolean
}

/**
 * 资源包变更会话替身。`commit` 经**它拿到的事务句柄**写一行标记——那一行在不在，
 * 就是「参与者的写在不在这笔事务里」的直接答案。
 */
function packageMutationSessionFactory(options: PackageSessionOptions) {
  return {
    create() {
      return {
        request: {
          ids: {
            mintCreate() {},
            findCreate: () => MINTED_MCP_ID,
          },
        },
        participants: {
          mcps: {
            prepareOpaque: async (operation: { readonly opId: string }) =>
              Object.freeze({
                mutation: { kind: 'mcp-create' as const },
                operationId: operation.opId,
              }),
          },
        },
        bindTransaction(transaction: {
          insert: (table: unknown) => { values: (row: unknown) => Promise<unknown> }
        }) {
          return {
            reader: {
              assertSelected: async () => ({ id: MINTED_MCP_ID, name: 'tools' }),
              assertVisible: async () => {},
              findBuiltin: async () => null,
              findActiveUsersByIds: async () => [],
              getById: async () =>
                options.rootExists ? { id: MINTED_MCP_ID, name: 'tools' } : null,
            },
            participants: {
              mcps: {
                commit: async (prepared: { readonly operationId: string }) => {
                  const at = Date.now()
                  await transaction.insert(resourceBundleApplies).values({
                    id: ulid(),
                    scope: MARKER_SCOPE,
                    key: ulid(),
                    actorUserId: OWNER,
                    state: 'committed',
                    preparedArtifactsJson: '[]',
                    createdAt: at,
                    updatedAt: at,
                  } as typeof resourceBundleApplies.$inferInsert)
                  return Object.freeze({
                    resourceType: 'mcp' as const,
                    operationId: prepared.operationId,
                    resourceId: MINTED_MCP_ID,
                    action: 'create' as const,
                    name: 'tools',
                  })
                },
              },
            },
          }
        },
        async prestage() {},
        async compensate() {},
        async rollForward() {},
        async afterCommitted() {},
      }
    },
  }
}

async function markerRows(harness: ProviderHarness) {
  return await harness.db
    .select()
    .from(resourceBundleApplies)
    .where(eq(resourceBundleApplies.scope, MARKER_SCOPE))
}

describeEachProvider('RFC-359 W11 资源包原子导入编排 · 事务边界', (harness) => {
  beforeEach(async () => {
    await seedOwner(harness)
  })

  async function applyPackage(options: PackageSessionOptions) {
    const box = createSecretBoxFromKey(randomBytes(32))
    const pkg = await parseResourcePackage(packageZip())
    const operations = createPostgresqlResourcePackageAtomicApplyOperations({
      db: harness.db as PostgresqlDatabaseClient,
      box,
    })
    const previewToken = signPreviewToken(box, {
      importId: ulid(),
      actorUserId: OWNER,
      packageDigest: pkg.digest,
      expiresAt: Date.now() + 600_000,
      baseline: [
        {
          localSlug: PACKAGE_SLUG,
          candidateIds: [],
          expectByCandidateId: {},
          allowedActions: ['new'],
        },
      ],
      humanBaseline: [],
    })
    return await operations.apply({
      authority: AUTHORITY,
      actor: ACTOR,
      package: pkg,
      previewToken,
      decisions: [{ localSlug: PACKAGE_SLUG, action: 'new' }] as never,
      humanMemberMappings: [],
      secretInputs: [],
      mutationSessionFactory: packageMutationSessionFactory(options) as never,
    })
  }

  test('提交事务：参与者已经写过之后抛 ⇒ 那一行随整笔回滚消失', async () => {
    const error = await rejects(async () => await applyPackage({ rootExists: false }))
    expect((error as Error).message).toContain('resource-package-root-not-persisted')

    expect(
      await markerRows(harness),
      '参与者在提交事务里写的行还在：那笔写没有落在事务内（同步包装器已提前 COMMIT）',
    ).toEqual([])
  })

  test('提交事务成功路径：收据落库、参与者的写与 journal 同一笔提交', async () => {
    const receipt = await applyPackage({ rootExists: true })
    expect(receipt.root).toMatchObject({
      resourceType: 'mcp',
      resourceId: MINTED_MCP_ID,
      action: 'create',
    })

    expect((await markerRows(harness)).length, '成功路径上参与者的写必须落库').toBe(1)
    const [journal] = await harness.db
      .select()
      .from(resourceBundleApplies)
      .where(
        and(
          eq(resourceBundleApplies.scope, 'package'),
          eq(resourceBundleApplies.state, 'committed'),
        ),
      )
      .limit(1)
    expect(journal?.receiptJson, 'journal 必须与参与者的写在同一笔事务里落到 committed').toContain(
      MINTED_MCP_ID,
    )
  })

  test('认领事务：同一个 importId 第二次进来走回放，不再开第二条 journal', async () => {
    const box = createSecretBoxFromKey(randomBytes(32))
    const pkg = await parseResourcePackage(packageZip())
    const operations = createPostgresqlResourcePackageAtomicApplyOperations({
      db: harness.db as PostgresqlDatabaseClient,
      box,
    })
    const previewToken = signPreviewToken(box, {
      importId: ulid(),
      actorUserId: OWNER,
      packageDigest: pkg.digest,
      expiresAt: Date.now() + 600_000,
      baseline: [
        {
          localSlug: PACKAGE_SLUG,
          candidateIds: [],
          expectByCandidateId: {},
          allowedActions: ['new'],
        },
      ],
      humanBaseline: [],
    })
    const input = {
      authority: AUTHORITY,
      actor: ACTOR,
      package: pkg,
      previewToken,
      decisions: [{ localSlug: PACKAGE_SLUG, action: 'new' }] as never,
      humanMemberMappings: [],
      secretInputs: [],
      mutationSessionFactory: packageMutationSessionFactory({ rootExists: true }) as never,
    }

    const first = await operations.apply(input)
    const replay = await operations.apply(input)
    expect(replay, '同一 importId 的第二次导入必须回放第一次的收据').toEqual(first)

    const journals = await harness.db
      .select()
      .from(resourceBundleApplies)
      .where(eq(resourceBundleApplies.scope, 'package'))
    expect(journals.length, '幂等键上只应有一条 journal').toBe(1)
  })
})
