// RFC-348 D2 (AC-17, user ruling ②) — remote MCP `oauth` is authorable from an
// intent changeset: `clientSecret` is a closed carrier (sentinel in, server
// issued slot out, real value in at confirm), `false` disables OAuth, omitting
// it on an update keeps the stored configuration, and an explicit value on an
// update REPLACES the stored one (Codex r12 P1#1 — the old carry-forward
// overwrote every explicit edit).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { canonicalIntentJson, INTENT_REDACTED, parseIntentChangeset } from '@agent-workflow/shared'
import type { Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { intentDrafts, intentSessions, users } from '../src/db/schema'
import { applyIntentChangeset, type ApplyIntentDeps } from '../src/services/intent/applyChangeset'
import {
  buildIntentDumpForTest as buildIntentDump,
  intentResourceCatalogBinding,
} from './helpers/intentResourceCatalogBinding'
import { buildMcpFence, type IntentContextManifest } from '../src/services/intent/manifest'
import { intentResourceVisibility } from '../src/services/intent/resourceCatalog'
import { deriveIntentSlots, validateDraftChangeset } from '../src/services/intent/resolveChangeset'
import { createIntentSession } from '../src/services/intent/session'
import { intentApplyResourceBinding } from './helpers/intentApplyResourceBinding'
import { composeSqliteIntentPersistence } from '../src/modules/intent/composition/persistence'
import type {
  IntentDumpAuxiliaryQueries,
  IntentPersistence,
} from '../src/modules/intent/public/operations'
import { composeSqliteIntentContextResourceAuthorizationSyncFactory } from '../src/modules/resource-catalog/composition/intentContextAuthorization'
import { getMcpFixtureById } from './helpers/mcpServiceBinding'

const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')
const OWNER = 'user_owner_oauth_0000000000'

let db: DbClient
let appHome: string
let persistence: IntentPersistence

const actor: Actor = {
  user: { id: OWNER, username: 'owner', displayName: 'Owner', role: 'user', status: 'active' },
  source: 'session',
  permissions: new Set(['resource-acl:private']),
}

beforeEach(async () => {
  db = createInMemoryDb(MIGRATIONS)
  persistence = composeSqliteIntentPersistence({
    db,
    contextAuthorization: composeSqliteIntentContextResourceAuthorizationSyncFactory(),
  })
  appHome = mkdtempSync(join(tmpdir(), 'aw-intent-oauth-'))
  mkdirSync(join(appHome, 'skills'), { recursive: true })
  await db.insert(users).values({
    id: OWNER,
    username: 'owner',
    displayName: 'owner',
    role: 'user',
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as typeof users.$inferInsert)
})
afterEach(() => {
  rmSync(appHome, { recursive: true, force: true })
})

function installDraft(
  sessionId: string,
  changeset: unknown,
  manifest: IntentContextManifest,
): { draftRevision: number; draftHash: string } {
  const parsed = parseIntentChangeset(JSON.stringify(changeset))
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  const canonical = canonicalIntentJson(parsed.changeset)
  const draftHash = `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
  const draftId = ulid()
  db.insert(intentDrafts)
    .values({
      id: draftId,
      sessionId,
      revision: 1,
      changesetJson: canonical,
      validationJson: '{"errors":[],"credentialFindings":[]}',
      draftHash,
      contextRevision: 0,
      createdAt: Date.now(),
    })
    .run()
  db.update(intentSessions)
    .set({ currentDraftId: draftId, contextManifestJson: JSON.stringify(manifest) })
    .where(eq(intentSessions.id, sessionId))
    .run()
  return { draftRevision: 1, draftHash }
}

const deps = (): ApplyIntentDeps => ({
  db,
  appHome,
  actor,
  ...intentApplyResourceBinding(db, actor),
})

const dumpAuxiliary: IntentDumpAuxiliaryQueries = Object.freeze({
  runtimeInventory: Object.freeze({
    async list(): Promise<
      readonly { readonly name: string; readonly protocol: 'opencode'; readonly enabled: boolean }[]
    > {
      return [{ name: 'opencode', protocol: 'opencode', enabled: true }]
    },
    async resolveDefault(): Promise<{ readonly name: string; readonly protocol: 'opencode' }> {
      return { name: 'opencode', protocol: 'opencode' }
    },
  }),
  async loadAgentPorts() {
    return new Map()
  },
  platformInventory: Object.freeze({
    async listRows() {
      return []
    },
  }),
})

function createSession(message: string) {
  const catalog = intentResourceCatalogBinding(db, actor, appHome)
  return createIntentSession(persistence, intentResourceVisibility(catalog), actor, { message })
}

const remoteCreate = (config: Record<string, unknown>, name = 'remote-svc') => ({
  $schema_version: 1,
  ops: [
    {
      opId: 'op-1',
      action: 'create',
      resourceType: 'mcp',
      tempRef: '$new:remote-svc',
      payload: {
        type: 'remote',
        name,
        description: 'remote server',
        config: { url: 'https://mcp.example.com/sse', ...config },
      },
    },
  ],
})

async function createRemote(
  config: Record<string, unknown>,
  slots: Array<{ slotId: string; value: string }> = [],
  name = 'remote-svc',
): Promise<string> {
  const { session } = await createSession('add a remote mcp')
  const draft = installDraft(session.id, remoteCreate(config, name), [])
  const receipt = await applyIntentChangeset(deps(), {
    sessionId: session.id,
    clientMutationId: ulid(),
    ...draft,
    decisions: slots.length === 0 ? [] : [{ opId: 'op-1', slots }],
  })
  const id = receipt.applied[0]?.resourceId
  if (id === undefined) throw new Error('create did not apply')
  return id
}

async function updateRemote(
  id: string,
  config: Record<string, unknown>,
  slots: Array<{ slotId: string; value: string }> = [],
): Promise<void> {
  const existing = await getMcpFixtureById(db, id)
  if (existing === null) throw new Error('mcp missing')
  const { session } = await createSession('edit the remote mcp')
  const manifest: IntentContextManifest = [
    {
      handle: 'res#mcp#1',
      resourceType: 'mcp',
      resourceId: id,
      root: true,
      detail: true,
      fence: buildMcpFence(existing),
      dumpHash: 'x',
    },
  ]
  const changeset = {
    $schema_version: 1,
    ops: [
      {
        opId: 'op-1',
        action: 'update',
        resourceType: 'mcp',
        target: 'res#mcp#1',
        payload: {
          type: 'remote',
          name: 'remote-svc',
          description: 'remote server (edited)',
          config: { url: 'https://mcp.example.com/sse', ...config },
        },
      },
    ],
  }
  const draft = installDraft(session.id, changeset, manifest)
  await applyIntentChangeset(deps(), {
    sessionId: session.id,
    clientMutationId: ulid(),
    ...draft,
    decisions: slots.length === 0 ? [] : [{ opId: 'op-1', slots }],
  })
}

const storedConfig = async (id: string): Promise<Record<string, unknown>> => {
  const row = await getMcpFixtureById(db, id)
  if (row === null) throw new Error('mcp missing')
  return row.config as Record<string, unknown>
}

describe('RFC-348 — remote MCP oauth through the intent seams', () => {
  test('a sentinel clientSecret becomes a confirm-time slot; a literal is rejected at draft time', () => {
    const ok = parseIntentChangeset(
      JSON.stringify(remoteCreate({ oauth: { clientId: 'cid', clientSecret: '‹secret›' } })),
    )
    if (!ok.ok) throw new Error(ok.errors.join('; '))
    const { slots } = deriveIntentSlots([], ok.changeset)
    expect(slots.map((s) => s.slotId)).toContain('secret:op-1:/config/oauth/clientSecret')

    const bad = parseIntentChangeset(
      JSON.stringify(remoteCreate({ oauth: { clientId: 'cid', clientSecret: 'hunter2' } })),
    )
    if (!bad.ok) throw new Error(bad.errors.join('; '))
    const report = validateDraftChangeset([], bad.changeset)
    expect(report.errors.join('\n')).toContain('intent-secret-value-forbidden')
    expect(report.errors.join('\n')).toContain('/payload/config/oauth/clientSecret')
  })

  test('create stores the slot value; `oauth:false` is stored as false', async () => {
    const id = await createRemote({ oauth: { clientId: 'cid', clientSecret: '‹secret›' } }, [
      { slotId: 'secret:op-1:/config/oauth/clientSecret', value: 'real-client-secret' },
    ])
    expect(await storedConfig(id)).toMatchObject({
      url: 'https://mcp.example.com/sse',
      oauth: { clientId: 'cid', clientSecret: 'real-client-secret' },
    })
    const disabled = await createRemote({ oauth: false }, [], 'remote-off')
    expect((await storedConfig(disabled)).oauth).toBe(false)
  })

  test('update omitting oauth keeps the stored block; an explicit false / object replaces it', async () => {
    const id = await createRemote({ oauth: { clientId: 'cid', clientSecret: '‹secret›' } }, [
      { slotId: 'secret:op-1:/config/oauth/clientSecret', value: 'real-client-secret' },
    ])
    await updateRemote(id, {})
    expect(await storedConfig(id)).toMatchObject({
      oauth: { clientId: 'cid', clientSecret: 'real-client-secret' },
    })
    await updateRemote(id, { oauth: false })
    expect((await storedConfig(id)).oauth).toBe(false)
    await updateRemote(id, { oauth: { clientId: 'cid-2', clientSecret: '‹secret›' } }, [
      { slotId: 'secret:op-1:/config/oauth/clientSecret', value: 'rotated-secret' },
    ])
    expect(await storedConfig(id)).toMatchObject({
      oauth: { clientId: 'cid-2', clientSecret: 'rotated-secret' },
    })
  })

  test('the dump redacts only clientSecret', async () => {
    const id = await createRemote({ oauth: { clientId: 'cid', clientSecret: '‹secret›' } }, [
      { slotId: 'secret:op-1:/config/oauth/clientSecret', value: 'real-client-secret' },
    ])
    const dump = await buildIntentDump({
      db,
      actor,
      appHome,
      mounts: [{ resourceType: 'mcp', resourceId: id }],
      ...dumpAuxiliary,
    })
    const text = dump.seedFiles
      .filter((f) => f.path.startsWith('mounted/'))
      .map((f) => f.content)
      .join('\n')
    expect(text).toContain('cid')
    expect(text).toContain(INTENT_REDACTED)
    expect(text).not.toContain('real-client-secret')
  })
})
