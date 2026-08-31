// RFC-271 multipart seam regression lock.
//
// The frontend transport and commit service both have focused tests, but neither proves that the
// Hono route parses humanMemberMappings / secretInputs and forwards them into the same commit.
// This test crosses that seam with a real preview -> multipart commit request and checks durable
// effects on both sides of the contract.

import { afterEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Hono, type MiddlewareHandler } from 'hono'
import { eq } from 'drizzle-orm'
import { PACKAGE_SECRET_PLACEHOLDER } from '@agent-workflow/shared'
import { buildActor } from '../src/auth/actor'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { mcps, resourceBundleApplies, users, workgroupMembers, workgroups } from '../src/db/schema'
import type {
  CommandContext,
  QueryContext,
} from '../src/modules/identity-access/public/participants'
import { composeResourcePackageOperations } from '../src/modules/resource-catalog/composition/resourcePackageOperations'
import { registerResourcePackageRoutes } from '../src/routes/resourcePackages'
import { errorHandler } from '../src/util/errors'
import { encodeZip } from '../src/util/zip'
import { removeTempDirSync } from './fixtures/tempDir'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)
const tempDirs: string[] = []

function testCommandContext(): CommandContext {
  return Object.freeze({
    get authority(): never {
      throw new Error('rfc271-import-http-does-not-consume-request-authority')
    },
    operationId: 'rfc271-import-http',
    correlationId: 'rfc271-import-http',
    now: 0,
  })
}

function testQueryContext(): QueryContext {
  return Object.freeze({
    get authority(): never {
      throw new Error('rfc271-import-http-does-not-consume-request-authority')
    },
    operationId: 'rfc271-import-http',
    correlationId: 'rfc271-import-http',
  })
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) removeTempDirSync(dir)
})

function packageZip(): Uint8Array {
  const manifest = `formatVersion: 1
exportedAt: 0
root:
  slug: workgroup-squad
  type: workgroup
  name: squad
resources:
  - slug: agent-leader
    type: agent
    name: leader-agent
  - slug: mcp-tools
    type: mcp
    name: tools
  - slug: workgroup-squad
    type: workgroup
    name: squad
requirements:
  mcpKinds: [local]
  executables: [tool-server]
  humanMembers: [source-alice]
secrets:
  - resourceType: mcp
    resourceName: tools
    field: config.env.TOKEN
  - resourceType: mcp
    resourceName: tools
    field: config.env.OPTIONAL_TOKEN
danglingCallRefs: []
`
  const bundle = {
    bundleVersion: 1,
    ops: [
      {
        opId: 'op-1',
        kind: 'agent-create',
        slug: 'agent-leader',
        payload: {
          name: 'leader-agent',
          description: '',
          outputs: [],
          syncOutputsOnIterate: true,
          permission: {},
          skills: [],
          dependsOn: [],
          mcp: [],
          plugins: [],
          frontmatterExtra: {},
          bodyMd: '',
        },
      },
      {
        opId: 'op-2',
        kind: 'mcp-create',
        slug: 'mcp-tools',
        payload: {
          name: 'tools',
          description: 'from multipart package',
          type: 'local',
          config: {
            command: ['tool-server'],
            env: {
              TOKEN: PACKAGE_SECRET_PLACEHOLDER,
              OPTIONAL_TOKEN: PACKAGE_SECRET_PLACEHOLDER,
            },
          },
          enabled: true,
        },
      },
      {
        opId: 'op-3',
        kind: 'workgroup-create',
        slug: 'workgroup-squad',
        payload: {
          name: 'squad',
          description: '',
          instructions: '',
          mode: 'leader_worker',
          switches: { shareOutputs: true, directMessages: false, blackboard: false },
          maxRounds: 20,
          completionGate: false,
          clarifyBudget: 3,
          fanOut: false,
          members: [
            {
              memberType: 'agent',
              agentRef: 'local:agent-leader',
              displayName: 'lead',
              roleDesc: 'leads',
              sortOrder: 0,
            },
            {
              memberType: 'human',
              username: 'source-alice',
              displayName: 'reviewer',
              roleDesc: 'reviews',
              sortOrder: 1,
            },
          ],
          leaderDisplayName: 'lead',
        },
      },
    ],
    rootRef: 'local:workgroup-squad',
  }
  return encodeZip([
    { path: 'manifest.yaml', bytes: utf8(manifest) },
    { path: 'bundle.json', bytes: utf8(JSON.stringify(bundle)) },
  ])
}

function malformedManifestZip(): Uint8Array {
  return encodeZip([
    { path: 'manifest.yaml', bytes: utf8('formatVersion: [') },
    { path: 'bundle.json', bytes: utf8('{}') },
  ])
}

function seedUser(db: DbClient, id: string, username: string, role: 'admin' | 'user'): void {
  db.insert(users)
    .values({
      id,
      username,
      displayName: username,
      role,
      status: 'active',
      passwordHash: 'test-only',
      createdAt: 1,
      updatedAt: 1,
    } as never)
    .run()
}

function appWithResourcePackageRoutes(
  db: DbClient,
  appHome: string,
  actor = buildActor({
    user: {
      id: 'route-user',
      username: 'route-user',
      displayName: 'Route User',
      role: 'admin',
      status: 'active',
    },
    source: 'daemon',
  }),
): Hono {
  const box = createSecretBoxFromKey(randomBytes(32))
  const app = new Hono()
  const injectActor: MiddlewareHandler = async (c, next) => {
    c.set('actor', actor)
    await next()
  }
  app.use('*', injectActor)
  app.onError(errorHandler)
  registerResourcePackageRoutes(app, {
    catalog: composeResourcePackageOperations({ db, appHome, box }),
    commandContextFor: testCommandContext,
    queryContextFor: testQueryContext,
  })
  return app
}

function appendPackage(form: FormData, zip: Uint8Array): void {
  form.append('file', new Blob([Buffer.from(zip)]), 'fixture.awpkg.zip')
}

describe('POST /api/resource-packages/commit multipart seam', () => {
  test('preview 将损坏 manifest YAML 稳定映射为 package-invalid 422', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc271-invalid-yaml-'))
    tempDirs.push(appHome)
    const app = appWithResourcePackageRoutes(db, appHome)
    const form = new FormData()
    appendPackage(form, malformedManifestZip())

    const response = await app.request('/api/resource-packages/preview', {
      method: 'POST',
      body: form,
    })

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      code: 'package-invalid',
      message: 'manifest.yaml is not valid YAML',
    })
  })

  test('PAT preview 猜中 human username 也不泄漏用户 UUID', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedUser(db, 'route-user', 'route-user', 'admin')
    seedUser(db, 'private-user-id', 'source-alice', 'user')
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc271-pat-preview-'))
    tempDirs.push(appHome)
    const patActor = buildActor({
      user: {
        id: 'route-user',
        username: 'route-user',
        displayName: 'Route User',
        role: 'admin',
        status: 'active',
      },
      source: 'pat',
      patPurpose: 'general',
      patId: 'pat-preview',
    })
    expect(patActor.permissions.has('users:search')).toBe(false)
    const app = appWithResourcePackageRoutes(db, appHome, patActor)

    const previewForm = new FormData()
    appendPackage(previewForm, packageZip())
    const response = await app.request('/api/resource-packages/preview', {
      method: 'POST',
      body: previewForm,
    })
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).not.toContain('private-user-id')
    const preview = JSON.parse(body) as {
      humanMembers: Array<{ username: string; suggestedUserId: string | null }>
    }
    expect(preview.humanMembers.find((member) => member.username === 'source-alice')).toMatchObject(
      {
        username: 'source-alice',
        suggestedUserId: null,
      },
    )
  })

  test('forwards human mappings and per-field secret inputs into one durable commit', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedUser(db, 'route-user', 'route-user', 'admin')
    seedUser(db, 'local-alice', 'alice', 'user')
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc271-route-'))
    tempDirs.push(appHome)
    const app = appWithResourcePackageRoutes(db, appHome)
    const zip = packageZip()

    const previewForm = new FormData()
    appendPackage(previewForm, zip)
    const previewResponse = await app.request('/api/resource-packages/preview', {
      method: 'POST',
      body: previewForm,
    })
    const previewBody = await previewResponse.text()
    if (previewResponse.status !== 200) {
      throw new Error(`preview returned ${previewResponse.status}: ${previewBody}`)
    }
    const preview = JSON.parse(previewBody) as {
      previewToken: string
      entries: Array<{ localSlug: string; suggestedName: string }>
      humanMembers: Array<{
        workgroupSlug: string
        username: string
        displayName: string
        suggestedUserId: string | null
        required: boolean
      }>
      secrets: Array<{ resourceType: string; resourceName: string; field: string }>
    }
    expect(preview.humanMembers).toContainEqual({
      workgroupSlug: 'workgroup-squad',
      username: 'source-alice',
      displayName: 'reviewer',
      suggestedUserId: null,
      required: false,
    })
    expect(preview.secrets).toHaveLength(2)

    const commitForm = new FormData()
    appendPackage(commitForm, zip)
    commitForm.set('previewToken', preview.previewToken)
    commitForm.set(
      'decisions',
      JSON.stringify(
        preview.entries.map((entry) => ({
          localSlug: entry.localSlug,
          action: 'new',
          finalName: entry.suggestedName,
        })),
      ),
    )
    commitForm.set(
      'humanMemberMappings',
      JSON.stringify([
        {
          workgroupSlug: 'workgroup-squad',
          username: 'source-alice',
          userId: 'local-alice',
        },
      ]),
    )
    commitForm.set(
      'secretInputs',
      JSON.stringify([
        {
          resourceType: 'mcp',
          resourceName: 'tools',
          field: 'config.env.TOKEN',
          value: 'secret-from-http',
        },
        {
          resourceType: 'mcp',
          resourceName: 'tools',
          field: 'config.env.OPTIONAL_TOKEN',
          value: '',
        },
      ]),
    )

    const commitResponse = await app.request('/api/resource-packages/commit', {
      method: 'POST',
      body: commitForm,
    })
    const commitBody = await commitResponse.text()
    if (commitResponse.status !== 200) {
      throw new Error(`commit returned ${commitResponse.status}: ${commitBody}`)
    }
    const receipt = JSON.parse(commitBody) as {
      journalId: string
      skippedSecrets?: Array<{ resourceType: string; resourceName: string; field: string }>
      root?: { resourceType: string; resourceId: string; name: string; action: string }
    }
    expect(receipt.skippedSecrets).toEqual([
      { resourceType: 'mcp', resourceName: 'tools', field: 'config.env.OPTIONAL_TOKEN' },
    ])
    const storedReceipt = JSON.parse(
      db
        .select({ receiptJson: resourceBundleApplies.receiptJson })
        .from(resourceBundleApplies)
        .where(eq(resourceBundleApplies.id, receipt.journalId))
        .get()?.receiptJson ?? '{}',
    ) as { skippedSecrets?: unknown }
    expect(storedReceipt.skippedSecrets).toEqual(receipt.skippedSecrets)

    const landedMcp = db.select().from(mcps).where(eq(mcps.name, 'tools')).get()
    expect(landedMcp).toBeDefined()
    const config = JSON.parse(landedMcp?.config ?? '{}') as {
      env?: Record<string, string>
    }
    expect(config.env).toEqual({ TOKEN: 'secret-from-http' })
    expect(JSON.stringify(config)).not.toContain(PACKAGE_SECRET_PLACEHOLDER)

    const landedWorkgroup = db.select().from(workgroups).where(eq(workgroups.name, 'squad')).get()
    expect(landedWorkgroup).toBeDefined()
    const landedMembers = db
      .select()
      .from(workgroupMembers)
      .where(eq(workgroupMembers.workgroupId, landedWorkgroup!.id))
      .all()
    const landedHuman = landedMembers.find((member) => member.memberType === 'human')
    expect(landedMembers).toHaveLength(2)
    expect(landedHuman).toMatchObject({
      memberType: 'human',
      displayName: 'reviewer',
      userId: 'local-alice',
    })
    expect(receipt.root).toEqual({
      resourceType: 'workgroup',
      resourceId: landedWorkgroup!.id,
      name: 'squad',
      action: 'create',
    })
  })
})
