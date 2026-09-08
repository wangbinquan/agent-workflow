// RFC-355 T1 —— apply 层「存下来的 changeset 非法」在两个 provider 上的行为必须一致。
//
// 这条用例存在的理由（**先红**，由 T4 转绿）：
//
//   PostgreSQL 的 apply 会 `parseIntentChangeset(claim.draft.changesetJson)`，不合法就抛
//   `ValidationError('intent-changeset-invalid', …)`，带上具体的 parse 错误；
//   SQLite 的 apply 是**裸 `JSON.parse`**（`sqliteIntentApplyOperations.ts` 的 preflight 段），
//   于是同一份坏 draft 在两种部署上表现不同：
//     · 不可解析的 JSON → SQLite 抛未分类的 `SyntaxError`（对客户端是 500，不是带码的 4xx）；
//     · 可解析但 schema 非法 → SQLite **完全不校验**，直接把它喂进 preflight / resolveIntentBundle。
//
// 既有覆盖只在 turn-engine 层（`rfc234-turn-engine.test.ts` 断言 agent 产出非法 changeset 时报
// `intent-changeset-invalid`），**apply 层这条从来没测过**——draft 落库之后再损坏 / 或由更早版本
// 写入的非法内容，就是这条路径。
//
// `parseIntentChangeset` 本来就在 `@agent-workflow/shared`，两侧都能用；SQLite 只是没用。

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { afterEach, beforeEach, expect, test } from 'bun:test'

import type { DbClient } from '../src/db/client'
import type { ProviderNeutralDatabase } from '../src/db/query'
import type { PostgresqlDatabaseClient } from '../src/platform/persistence/postgresqlDatabaseClient'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { intentDrafts, intentSessions, users } from '../src/db/schema'
import type { Actor } from '../src/auth/actor'
import {
  composeSqliteIntentApplyOperations,
  composeSqliteIntentApplyArtifactLifecycle,
  composePostgresqlIntentApplyOperations,
} from '../src/modules/intent/composition/apply'
import { createIntentSession as createSession } from '../src/modules/intent/application/session'
import { intentResourceVisibility } from '../src/modules/intent/application/resourceCatalog'
import { composeIntentPersistence } from '../src/modules/intent/composition/persistence'
import type { IntentApplyInput } from '../src/modules/intent/application/ports/intentApplyOperations'
import { createPostgresqlIntentApplyOperations } from '../src/modules/intent/infrastructure/postgresqlIntentApplyOperations'
import { createPostgresqlIntentApplyArtifactLifecycle } from '../src/modules/intent/infrastructure/postgresqlIntentApplyArtifactLifecycle'
import { composeIdentityAccess } from '../src/modules/identity-access/composition'
import {
  composePostgresqlIntentApplyResourceBinding,
  composePostgresqlSkillArtifactCompensation,
  createPostgresqlIntentPluginArtifactLifecycle,
  createPostgresqlIntentSkillArtifactLifecycle,
} from '../src/modules/resource-catalog/composition/intentApply'
import { composeIntentContextResourceAuthorizationFactory } from '../src/modules/resource-catalog/composition/intentContextAuthorization'
import { composeResourceCatalogFor } from '../src/modules/resource-catalog/composition/providerResourceCatalog'
import { createMcpTransactionLifecycle } from '../src/modules/resource-catalog/infrastructure/mcpTransactionLifecycle'
import { admitTestDirectAuthority } from './helpers/identityAccessAuthority'
import { intentApplyResourceBinding } from './helpers/intentApplyResourceBinding'

const OWNER = 'user_owner_rfc355_00000000'

let db: ProviderNeutralDatabase
let harness: ProviderHarness
let appHome: string

const actor: Actor = {
  user: { id: OWNER, username: 'owner', displayName: 'Owner', role: 'user', status: 'active' },
  source: 'session',
  permissions: new Set(['resource-acl:private']),
}

function deps() {
  if (harness.capabilities.isolation === 'exclusive') {
    const sqlite = db as DbClient
    const binding = intentApplyResourceBinding(sqlite, actor)
    return {
      authority: binding.authority,
      operations: composeSqliteIntentApplyOperations({
        db: sqlite,
        appHome,
        resources: binding.resourceApply,
        artifacts: composeSqliteIntentApplyArtifactLifecycle({ db: sqlite, appHome }),
      }),
    }
  }
  const postgresql = db as PostgresqlDatabaseClient
  const pluginsDir = join(appHome, 'plugins')
  const { authority } = composeIdentityAccess(db).contexts.fromAuthenticatedPrincipal(
    { userId: actor.user.id, source: actor.source },
    'http',
  )
  return {
    authority,
    operations: composePostgresqlIntentApplyOperations(
      createPostgresqlIntentApplyOperations({
        db: postgresql,
        resources: composePostgresqlIntentApplyResourceBinding({
          db: postgresql,
          mcpLifecycle: createMcpTransactionLifecycle(),
          pluginArtifacts: createPostgresqlIntentPluginArtifactLifecycle({ pluginsDir }),
          skillArtifacts: createPostgresqlIntentSkillArtifactLifecycle({ appHome }),
          aclIdentities: composeResourceCatalogFor({ db }).persistence.identities,
        }),
        artifacts: createPostgresqlIntentApplyArtifactLifecycle({
          db: postgresql,
          appHome,
          pluginsDir,
          skillArtifacts: composePostgresqlSkillArtifactCompensation(),
        }),
      }),
    ),
  }
}

function applyIntentChangeset(binding: ReturnType<typeof deps>, command: IntentApplyInput) {
  return binding.operations.apply({ actor, authority: binding.authority, command })
}

async function createIntentSession(
  db: ProviderNeutralDatabase,
  actor: Actor,
  input: Parameters<typeof createSession>[3],
  _appHome: string,
): ReturnType<typeof createSession> {
  const identityAccess = composeIdentityAccess(db)
  const current = await admitTestDirectAuthority(identityAccess.directAuthority, {
    userId: actor.user.id,
    source: 'session',
  })
  if (current === null) throw new Error('intent-fixture-actor-missing')
  const context = identityAccess.contexts.queryFromAuthority(current.authority, 'http')
  const unusedDetail = (): never => {
    throw new Error('invalid-draft-fixture-does-not-request-resource-details')
  }
  return createSession(
    composeIntentPersistence({
      db,
      contextAuthorization: composeIntentContextResourceAuthorizationFactory(),
    }),
    intentResourceVisibility({
      context,
      currentAuthority: { authority: context.authority, actor: current.actor },
      query: composeResourceCatalogFor({ db }).createQuery({ resolveActor: () => actor }),
      // Both original inputs have no mounts. A detail request must fail this fixture.
      details: {
        agents: { get: unusedDetail },
        skills: { content: unusedDetail },
        skillFiles: { list: unusedDetail, read: unusedDetail },
        mcps: { get: unusedDetail },
        plugins: { get: unusedDetail },
        workflows: { get: unusedDetail },
        workgroups: { get: unusedDetail },
      },
    }),
    actor,
    input,
  )
}

/** 把一段**原样的**文本塞进 draft，绕过 turn 引擎的校验——模拟「落库之后才坏掉」。 */
async function installRawDraft(
  sessionId: string,
  changesetJson: string,
): Promise<{ draftHash: string }> {
  const draftHash = `sha256:${createHash('sha256').update(changesetJson, 'utf8').digest('hex')}`
  const draftId = ulid()
  await db
    .insert(intentDrafts)
    .values({
      id: draftId,
      sessionId,
      revision: 1,
      changesetJson,
      validationJson: '{"errors":[],"credentialFindings":[]}',
      draftHash,
      contextRevision: 0,
      createdAt: Date.now(),
    })
    .run()
  await db
    .update(intentSessions)
    .set({
      currentDraftId: draftId,
      contextManifestJson: JSON.stringify({ version: 1, entries: [] }),
    })
    .where(eq(intentSessions.id, sessionId))
    .run()
  return { draftHash }
}

describeEachProvider(
  'RFC-355 —— apply 层对存量 changeset 的校验（双 provider 必须一致）',
  (providerHarness) => {
    beforeEach(async () => {
      harness = providerHarness
      db = harness.db
      appHome = mkdtempSync(join(tmpdir(), 'aw-rfc355-'))
      mkdirSync(join(appHome, 'skills'), { recursive: true })
      await db
        .insert(users)
        .values({
          id: OWNER,
          username: 'owner',
          displayName: 'Owner',
          role: 'user',
          status: 'active',
          passwordHash: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .run()
    })
    afterEach(() => {
      rmSync(appHome, { recursive: true, force: true })
    })

    test('不可解析的 changeset 报 intent-changeset-invalid，而不是未分类的 SyntaxError', async () => {
      const { session } = await createIntentSession(db, actor, { message: 'rfc355' }, appHome)
      const { draftHash } = await installRawDraft(session.id, '{not json')
      await expect(
        applyIntentChangeset(deps(), {
          sessionId: session.id,
          clientMutationId: ulid(),
          draftRevision: 1,
          draftHash,
          decisions: [],
        }),
      ).rejects.toMatchObject({ code: 'intent-changeset-invalid' })
    })

    test('可解析但 schema 非法的 changeset 同样被挡下，而不是喂进 preflight', async () => {
      const { session } = await createIntentSession(db, actor, { message: 'rfc355' }, appHome)
      // 合法 JSON、但不是一个 IntentChangeset（缺 ops / version 等必填结构）。
      const { draftHash } = await installRawDraft(session.id, '{"totally":"not a changeset"}')
      await expect(
        applyIntentChangeset(deps(), {
          sessionId: session.id,
          clientMutationId: ulid(),
          draftRevision: 1,
          draftHash,
          decisions: [],
        }),
      ).rejects.toMatchObject({ code: 'intent-changeset-invalid' })
    })
  },
)
