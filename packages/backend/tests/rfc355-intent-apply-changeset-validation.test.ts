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
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { intentDrafts, intentSessions, users } from '../src/db/schema'
import type { Actor } from '../src/auth/actor'
import { applyIntentChangeset, type ApplyIntentDeps } from '../src/services/intent/applyChangeset'
import { createIntentSessionForTest as createIntentSession } from './helpers/intentResourceCatalogBinding'
import { intentApplyResourceBinding } from './helpers/intentApplyResourceBinding'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')
const OWNER = 'user_owner_rfc355_00000000'

let db: DbClient
let appHome: string

const actor: Actor = {
  user: { id: OWNER, username: 'owner', displayName: 'Owner', role: 'user', status: 'active' },
  source: 'session',
  permissions: new Set(['resource-acl:private']),
}

function deps(): ApplyIntentDeps {
  const resolved = { db, appHome, actor }
  return { ...resolved, ...intentApplyResourceBinding(db, actor) }
}

/** 把一段**原样的**文本塞进 draft，绕过 turn 引擎的校验——模拟「落库之后才坏掉」。 */
function installRawDraft(sessionId: string, changesetJson: string): { draftHash: string } {
  const draftHash = `sha256:${createHash('sha256').update(changesetJson, 'utf8').digest('hex')}`
  const draftId = ulid()
  db.insert(intentDrafts)
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
  db.update(intentSessions)
    .set({
      currentDraftId: draftId,
      contextManifestJson: JSON.stringify({ version: 1, entries: [] }),
    })
    .where(eq(intentSessions.id, sessionId))
    .run()
  return { draftHash }
}

beforeEach(async () => {
  db = createInMemoryDb(MIGRATIONS)
  appHome = mkdtempSync(join(tmpdir(), 'aw-rfc355-'))
  mkdirSync(join(appHome, 'skills'), { recursive: true })
  db.insert(users)
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

describe('RFC-355 —— apply 层对存量 changeset 的校验（双 provider 必须一致）', () => {
  test('不可解析的 changeset 报 intent-changeset-invalid，而不是未分类的 SyntaxError', async () => {
    const { session } = await createIntentSession(db, actor, { message: 'rfc355' }, appHome)
    const { draftHash } = installRawDraft(session.id, '{not json')
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
    const { draftHash } = installRawDraft(session.id, '{"totally":"not a changeset"}')
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
})
