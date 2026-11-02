// RFC-401 A2 —— MCP 与 plugin 写入的错误矩阵（AC-2 的 MCP / plugin 部分，design §9.3）。
//
// 同一非法输入经三条入口、两种 provider 得到同一 code / status / message / details：普通编辑（目录模块的命令）、
// Intent（确认后的 apply）、资源包（parse → preview → commit）。proposal §5 第 1 项（名称冲突），用户 2026-11-02 确认以
// 普通编辑现行行为为准。RFC-401 A2 之前 Intent 与资源包的 stale / 类型不可变措辞与 details 各不相同，更新从不判 no-op。
//
// 资源包的已选目标基线先于资源层 stale（proposal §5 第 11 项），stale 一例单独断言。

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ResourceBundle } from '@agent-workflow/shared'

import { buildActor } from '@/auth/actor'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import { composeIntentApplyOperations } from '@/modules/intent/composition/apply'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { parseResourcePackage } from '@/services/resourcePackage/parse'
import { collectPackageRequirements } from '@/services/resourcePackage/requirements'
import { encodeZip } from '@/util/zip'
import { removeTempDirSync } from './fixtures/tempDir'
import { describeEachProvider } from './helpers/eachProvider'
import {
  composeMcpServiceBindingForTest,
  createMcpForTest,
  getMcpByIdForTest,
} from './helpers/mcpServiceBinding'
import { composePluginServiceBindingForTest, createPlugin } from './helpers/pluginServiceBinding'
import { commitResourcePackageForTest } from './helpers/resourcePackageApply'
import { buildPackagePreview } from './helpers/resourcePackageProvider'

const OWNER = 'rfc401-a2-owner'
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)
const roots: string[] = []

const actor = buildActor({
  user: { id: OWNER, username: OWNER, displayName: OWNER, role: 'user', status: 'active' },
  source: 'session',
})

interface Projection {
  readonly code: unknown
  readonly status: unknown
  readonly message: unknown
  readonly details: unknown
}

async function failureOf(run: () => Promise<unknown>): Promise<Projection> {
  try {
    await run()
  } catch (error) {
    const value = error as {
      code?: unknown
      status?: unknown
      message?: unknown
      details?: unknown
    }
    return {
      code: value.code,
      status: value.status,
      message: value.message,
      details: value.details,
    }
  }
  throw new Error('expected the write to be rejected')
}

afterEach(() => {
  while (roots.length > 0) removeTempDirSync(roots.pop()!)
})

type IntentType = 'mcp' | 'plugin'

describeEachProvider('RFC-401 A2 MCP / plugin error matrix', (harness) => {
  let db: PersistenceDb
  let appHome: string
  let pluginSource: string
  const box = createSecretBoxFromKey(randomBytes(32))

  beforeEach(async () => {
    db = harness.db
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc401-a2-'))
    roots.push(appHome)
    mkdirSync(join(appHome, 'skills'), { recursive: true })
    pluginSource = join(appHome, 'plugin-source')
    mkdirSync(pluginSource, { recursive: true })
    writeFileSync(join(pluginSource, 'package.json'), '{"name":"rfc401-plugin","version":"1.0.0"}')
    writeFileSync(join(pluginSource, 'index.js'), 'export const ok = true\n')
    const { users } = tablesOf(db)
    await insertOne(db, users, {
      id: OWNER,
      username: OWNER,
      displayName: OWNER,
      role: 'user',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    } as PersistenceTables['users']['$inferInsert'])
  })

  // ── 普通编辑 ───────────────────────────────────────────────────────────────
  const mcpCatalog = () => composeMcpServiceBindingForTest(db, { actor })
  const pluginCatalog = () =>
    composePluginServiceBindingForTest(db, { actor, pluginsDir: join(appHome, 'plugins') })

  async function seedMcp(name: string) {
    const created = await createMcpForTest(mcpCatalog(), {
      type: 'local',
      name,
      description: 'seeded',
      enabled: true,
      config: { command: ['node', 'server.js'] },
    })
    return (await getMcpByIdForTest(mcpCatalog(), created.id))!
  }

  async function seedPlugin(name: string) {
    const created = await createPlugin(pluginCatalog(), {
      name,
      spec: `file:${pluginSource}`,
      description: 'p',
    })
    const binding = pluginCatalog()
    return (await binding.catalog.queries.get(binding.authority, { id: created.id }))!
  }

  // ── Intent ────────────────────────────────────────────────────────────────
  interface IntentOp {
    readonly type: IntentType
    readonly action: 'create' | 'update'
    readonly id?: string
    readonly configHash?: string
    readonly payload: Record<string, unknown>
  }

  async function intentApply(op: IntentOp): Promise<unknown> {
    const manifest =
      op.action === 'update'
        ? [
            {
              handle: `res#${op.type}#1`,
              resourceType: op.type,
              resourceId: op.id,
              root: true,
              detail: true,
              fence: { kind: op.type, configHash: op.configHash },
            },
          ]
        : []
    const changeset = {
      $schema_version: 1,
      ops: [
        {
          opId: 'op-1',
          action: op.action,
          resourceType: op.type,
          ...(op.action === 'create' ? { tempRef: '$new:a' } : { target: `res#${op.type}#1` }),
          payload: op.payload,
        },
      ],
    }
    const sessionId = ulid()
    const draftId = ulid()
    const changesetJson = JSON.stringify(changeset)
    const draftHash = `sha256:${createHash('sha256').update(changesetJson, 'utf8').digest('hex')}`
    const { intentSessions, intentDrafts } = tablesOf(db)
    await insertOne(db, intentSessions, {
      id: sessionId,
      ownerUserId: OWNER,
      title: 'rfc401-a2',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as PersistenceTables['intentSessions']['$inferInsert'])
    await insertOne(db, intentDrafts, {
      id: draftId,
      sessionId,
      revision: 1,
      changesetJson,
      validationJson: '{"errors":[],"credentialFindings":[]}',
      draftHash,
      contextRevision: 0,
      createdAt: Date.now(),
    } as PersistenceTables['intentDrafts']['$inferInsert'])
    await db
      .update(intentSessions)
      .set({ currentDraftId: draftId, contextManifestJson: JSON.stringify(manifest) })
      .where(eq(intentSessions.id, sessionId))
    const { authority } = composeIdentityAccess(db).contexts.fromAuthenticatedPrincipal(
      { userId: OWNER, source: 'session' },
      'http',
    )
    return composeIntentApplyOperations({
      db,
      appHome,
      aclIdentities: composeResourceCatalogFor({ db }).persistence.identities,
    }).apply({
      actor,
      authority,
      command: {
        sessionId,
        clientMutationId: ulid(),
        draftRevision: 1,
        draftHash,
        decisions: [],
      },
    })
  }

  // ── 资源包 ────────────────────────────────────────────────────────────────
  async function packageApply(
    type: IntentType,
    payload: Record<string, unknown>,
    overwrite?: string,
    beforeCommit?: () => Promise<void>,
  ): Promise<unknown> {
    const ops = [{ opId: 'op-1', kind: `${type}-create`, slug: 'candidate', payload }]
    const bundle = { bundleVersion: 1, ops, rootRef: 'local:candidate' }
    const requirements = collectPackageRequirements(bundle as unknown as ResourceBundle)
    const bytes = encodeZip([
      {
        path: 'manifest.yaml',
        bytes: utf8(`formatVersion: 1
exportedAt: 0
root:
  slug: candidate
  type: ${type}
  name: ${String(payload.name)}
resources:
  - slug: candidate
    type: ${type}
    name: ${String(payload.name)}
requirements: ${JSON.stringify(requirements)}
secrets: []
danglingCallRefs: []
builtins: []
`),
      },
      { path: 'bundle.json', bytes: utf8(JSON.stringify(bundle)) },
    ])
    const pkg = await parseResourcePackage(bytes)
    const preview = await buildPackagePreview(db, actor, pkg, { box, importId: ulid() })
    await beforeCommit?.()
    return commitResourcePackageForTest({ db, appHome, box }, actor, {
      pkg,
      previewToken: preview.previewToken,
      decisions: [
        overwrite === undefined
          ? { localSlug: 'candidate', action: 'new' as const }
          : { localSlug: 'candidate', action: 'overwrite' as const, targetId: overwrite },
      ],
    })
  }

  async function expectSameFailure(
    expected: Projection,
    runs: Readonly<Record<string, () => Promise<unknown>>>,
  ): Promise<void> {
    const actual: Record<string, Projection> = {}
    for (const [entry, run] of Object.entries(runs)) actual[entry] = await failureOf(run)
    expect(actual).toEqual(Object.fromEntries(Object.keys(runs).map((entry) => [entry, expected])))
  }

  const localMcp = (name: string, extra: Record<string, unknown> = {}) => ({
    type: 'local',
    name,
    description: 'seeded',
    enabled: true,
    config: { command: ['node', 'server.js'] },
    ...extra,
  })

  test('MCP with a name the owner already uses → mcp-name-in-use / 409', async () => {
    await seedMcp('m-taken')
    await expectSameFailure(
      {
        code: 'mcp-name-in-use',
        status: 409,
        message: "mcp 'm-taken' already exists",
        details: undefined,
      },
      {
        ordinary: () =>
          createMcpForTest(mcpCatalog(), {
            type: 'local',
            name: 'm-taken',
            description: '',
            enabled: true,
            config: { command: ['node', 'other.js'] },
          }),
        intent: () => intentApply({ type: 'mcp', action: 'create', payload: localMcp('m-taken') }),
        resourcePackage: () => packageApply('mcp', localMcp('m-taken')),
      },
    )
  })

  test('changing an MCP type → mcp-type-immutable with both types', async () => {
    const seeded = await seedMcp('m-local')
    const remote = {
      type: 'remote',
      name: 'm-local',
      description: 'seeded',
      enabled: true,
      config: { url: 'https://example.test/mcp' },
    }
    await expectSameFailure(
      {
        code: 'mcp-type-immutable',
        status: 422,
        message: "mcp 'm-local' type cannot change",
        details: { currentType: 'local', requestedType: 'remote' },
      },
      {
        ordinary: async () =>
          mcpCatalog().catalog.operations.update.invoke(mcpCatalog().authority, {
            id: seeded.id,
            update: {
              type: 'remote',
              config: { url: 'https://example.test/mcp' },
              expectedConfigHash: seeded.operationConfigHash,
            },
          }),
        intent: () =>
          intentApply({
            type: 'mcp',
            action: 'update',
            id: seeded.id,
            configHash: seeded.operationConfigHash,
            payload: remote,
          }),
        resourcePackage: () => packageApply('mcp', remote, seeded.id),
      },
    )
  })

  test('stale MCP revision → resource-operation-stale (package: its selected-target baseline first)', async () => {
    const seeded = await seedMcp('m-stale')
    const current = await getMcpByIdForTest(mcpCatalog(), seeded.id)
    await expectSameFailure(
      {
        code: 'resource-operation-stale',
        status: 409,
        message: 'the MCP changed; reload before modifying it',
        details: {
          resource: 'mcp',
          expectedConfigHash: 'stale-hash',
          currentConfigHash: current!.operationConfigHash,
        },
      },
      {
        ordinary: async () =>
          mcpCatalog().catalog.operations.update.invoke(mcpCatalog().authority, {
            id: seeded.id,
            update: { description: 'changed', expectedConfigHash: 'stale-hash' },
          }),
        intent: () =>
          intentApply({
            type: 'mcp',
            action: 'update',
            id: seeded.id,
            configHash: 'stale-hash',
            payload: localMcp('m-stale', { description: 'changed' }),
          }),
      },
    )
    expect(
      await failureOf(() =>
        packageApply(
          'mcp',
          localMcp('m-stale', { description: 'changed' }),
          seeded.id,
          async () => {
            const { mcps } = tablesOf(db)
            await db.update(mcps).set({ description: 'raced' }).where(eq(mcps.id, seeded.id))
          },
        ),
      ),
    ).toMatchObject({ code: 'package-selected-target-changed', status: 409 })
  })

  // 普通编辑的语义 no-op：内容不变就不写（updatedAt 不动）。此前 Intent 与资源包每次都写。
  test('an MCP update that changes nothing writes nothing on every entry', async () => {
    const seeded = await seedMcp('m-same')
    const unchanged = async () => {
      const row = await getMcpByIdForTest(mcpCatalog(), seeded.id)
      expect(row?.updatedAt).toBe(seeded.updatedAt)
      return row!
    }
    await mcpCatalog().catalog.operations.update.invoke(mcpCatalog().authority, {
      id: seeded.id,
      update: { description: 'seeded', expectedConfigHash: seeded.operationConfigHash },
    })
    await unchanged()
    await intentApply({
      type: 'mcp',
      action: 'update',
      id: seeded.id,
      configHash: seeded.operationConfigHash,
      payload: localMcp('m-same'),
    })
    await unchanged()
    await packageApply('mcp', localMcp('m-same'), seeded.id)
    await unchanged()
  })

  test('plugin with a name the owner already uses → plugin-name-in-use / 409', async () => {
    await seedPlugin('p-taken')
    const payload = { name: 'p-taken', spec: `file:${pluginSource}`, description: 'again' }
    await expectSameFailure(
      {
        code: 'plugin-name-in-use',
        status: 409,
        message: "plugin 'p-taken' already exists",
        details: undefined,
      },
      {
        ordinary: () => createPlugin(pluginCatalog(), payload),
        intent: () => intentApply({ type: 'plugin', action: 'create', payload }),
        resourcePackage: () =>
          packageApply('plugin', {
            ...payload,
            options: {},
            enabled: true,
            sourceKind: 'file',
          }),
      },
    )
  })

  test('stale plugin revision → resource-operation-stale with both config hashes', async () => {
    const seeded = await seedPlugin('p-stale')
    await expectSameFailure(
      {
        code: 'resource-operation-stale',
        status: 409,
        message: 'plugin changed since this operation was prepared; reload and retry',
        details: {
          resource: 'plugin',
          expectedConfigHash: 'stale-hash',
          currentConfigHash: seeded.operationConfigHash,
        },
      },
      {
        ordinary: async () =>
          pluginCatalog().catalog.operations.update.invoke(pluginCatalog().authority, {
            id: seeded.id,
            update: { description: 'changed', expectedConfigHash: 'stale-hash' },
          }),
        intent: () =>
          intentApply({
            type: 'plugin',
            action: 'update',
            id: seeded.id,
            configHash: 'stale-hash',
            payload: { name: 'p-stale', spec: `file:${pluginSource}`, description: 'changed' },
          }),
      },
    )
  })
})
