import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BundleOpSchema } from '@agent-workflow/shared'

import { buildActor } from '../src/auth/actor'
import { AuthorityClaimRegistry } from '../src/modules/identity-access/application/operationContext'
import {
  createPostgresqlResourcePackagePluginArtifactOwner,
  createPostgresqlResourcePackageSkillArtifactOwner,
} from '../src/modules/resource-catalog/infrastructure/postgresqlResourcePackageArtifacts'
import type {
  PostgresqlResourcePackageApplyReceipt,
  PostgresqlResourcePackageMutationRequestContext,
} from '../src/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationParticipants'
import {
  skillFilesAbs,
  skillVersionAbs,
} from '../src/modules/resource-catalog/infrastructure/legacy/skillIdentityPaths'

const backendRoot = resolve(import.meta.dir, '..')
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rfc349-pg-package-'))
  temporaryRoots.push(root)
  return root
}

function requestContext(
  files: Readonly<Record<string, Uint8Array>> = {},
): PostgresqlResourcePackageMutationRequestContext {
  const actor = buildActor({
    user: {
      id: 'package-owner',
      username: 'package-owner',
      displayName: 'Package Owner',
      role: 'admin',
      status: 'active',
    },
    source: 'daemon',
  })
  const authority = new AuthorityClaimRegistry().mintLocalAuthority({
    userId: actor.user.id,
    source: 'system',
  })
  const ids = new Map<string, string>()
  return Object.freeze({
    actor,
    authority,
    humanMemberMappings: Object.freeze([]),
    secretInputs: Object.freeze([]),
    readSkillFile(ref: string) {
      const bytes = files[ref]
      if (bytes === undefined) throw new Error(`missing fixture file: ${ref}`)
      return bytes
    },
    ids: Object.freeze({
      mintCreate(input: { readonly type: string; readonly localSlug: string }) {
        const key = `${input.type}:${input.localSlug}`
        const existing = ids.get(key)
        if (existing !== undefined) return existing
        const value = `id-${input.type}-${input.localSlug}`
        ids.set(key, value)
        return value
      },
      findCreate(input: { readonly type: string; readonly localSlug: string }) {
        return ids.get(`${input.type}:${input.localSlug}`) ?? null
      },
      listPending() {
        return Object.freeze([])
      },
    }),
  })
}

function receipt(operationId: string, resourceId: string): PostgresqlResourcePackageApplyReceipt {
  return Object.freeze({
    journalId: `journal-${operationId}`,
    applied: Object.freeze([
      Object.freeze({
        resourceType: 'skill' as const,
        operationId,
        resourceId,
        action: 'create' as const,
        name: 'Helper',
      }),
    ]),
  })
}

describe('RFC-349 PostgreSQL ResourcePackage bootstrap', () => {
  test('composition exposes the seven-arm provider session to the injected W6 execution owner', () => {
    const source = readFileSync(
      resolve(
        backendRoot,
        'src/modules/resource-catalog/composition/postgresqlResourcePackageCatalog.ts',
      ),
      'utf8',
    )
    for (const factory of [
      'createPostgresqlResourcePackageMutationSessionFactory',
      'composePostgresqlResourcePackageProvider',
      'createPostgresqlResourcePackagePluginArtifactOwner',
      'createPostgresqlResourcePackageSkillArtifactOwner',
    ]) {
      expect(source).toContain(`${factory}(`)
    }
    expect(source).toContain('readonly execution: ResourcePackageExecutionAdapter')
    expect(source).toContain('readonly provider: PostgresqlResourcePackageProviderComposition')
    expect(source).toContain('execution: input.execution')
    expect(source).toContain('mutationSessionFactory,')
    expect(source).toContain('createPostgresqlResourcePackageReadPort(input.db)')
    expect(source).toContain('readPostgresqlPackageSkillTree(input.db, input.appHome, skillId)')
    expect(source).not.toMatch(
      /@\/services\/(?:bundle\/legacyResourcePackageMutationDependencies|resourcePackage\/(?:commit|export|parse|preview))/,
    )
    expect(source).not.toMatch(
      /postgresql-resource-package-bootstrap-not-composed|\bas DbClient\b|\bas PostgresqlDatabaseClient\b|createSqlite|fallback|no-op/i,
    )
  })

  test('standalone package CLI binds the selected PostgreSQL owners without a SQLite fallback', () => {
    const source = readFileSync(resolve(backendRoot, 'src/main.ts'), 'utf8')
    for (const factory of [
      'composePostgresqlResourcePackageCatalog',
      'createPostgresqlResourcePackageAtomicApplyOperations',
      'createPostgresqlCapabilityTemplatePackageMutationOwner',
      'createPostgresqlMcpTransactionLifecycle',
    ]) {
      expect(source).toContain(`${factory}(`)
    }
    expect(source).not.toContain('postgresql-resource-package-bootstrap-not-composed')
  })

  test('skill owner records a request-local stage and rolls forward live plus immutable version', async () => {
    const appHome = await temporaryRoot()
    const fileRef = 'skills/helper/files/guide.bin'
    const context = requestContext({ [fileRef]: new Uint8Array([0, 1, 2, 255]) })
    const parsed = BundleOpSchema.parse({
      opId: 'op-1',
      kind: 'skill-create',
      slug: 'helper',
      payload: {
        name: 'Helper',
        description: 'PostgreSQL package skill',
        frontmatterExtra: { compatibility: 'strict' },
        bodyMd: '# Helper',
        files: [{ path: 'docs/guide.bin', ref: fileRef }],
      },
    })
    if (parsed.kind !== 'skill-create') throw new Error('fixture kind mismatch')
    const owner = createPostgresqlResourcePackageSkillArtifactOwner({ appHome })
    const plan = owner.planCreate(context, { mutation: parsed, skillId: 'skill-helper' })

    expect(existsSync(plan.artifact.stagingDirectory)).toBeFalse()
    const publication = await plan.stage()
    expect(existsSync(skillFilesAbs(appHome, 'skill-helper'))).toBeFalse()
    expect(publication).toMatchObject({
      managedPath: 'skills/skill-helper/files',
      filesPath: 'skills/skill-helper/versions/v1/files',
    })

    await owner.rollForward(context, {
      artifact: plan.artifact,
      receipt: receipt(parsed.opId, 'skill-helper'),
    })
    await owner.afterCommitted(context, receipt(parsed.opId, 'skill-helper'))

    const live = skillFilesAbs(appHome, 'skill-helper')
    const version = skillVersionAbs(appHome, 'skill-helper', 1)
    expect(readFileSync(join(live, 'SKILL.md'), 'utf8')).toContain('compatibility: strict')
    expect([...readFileSync(join(live, 'docs', 'guide.bin'))]).toEqual([0, 1, 2, 255])
    expect(readFileSync(join(version, 'SKILL.md'), 'utf8')).toBe(
      readFileSync(join(live, 'SKILL.md'), 'utf8'),
    )
    expect(existsSync(plan.artifact.stagingDirectory)).toBeFalse()
  })

  test('skill pre-commit compensation removes only its staged filesystem artifacts', async () => {
    const appHome = await temporaryRoot()
    const context = requestContext()
    const parsed = BundleOpSchema.parse({
      opId: 'op-2',
      kind: 'skill-create',
      slug: 'abortable',
      payload: {
        name: 'Abortable',
        description: '',
        frontmatterExtra: {},
        bodyMd: 'not committed',
        files: [],
      },
    })
    if (parsed.kind !== 'skill-create') throw new Error('fixture kind mismatch')
    const owner = createPostgresqlResourcePackageSkillArtifactOwner({ appHome })
    const plan = owner.planCreate(context, { mutation: parsed, skillId: 'skill-abortable' })
    await plan.stage()
    await owner.compensate(context, { artifact: plan.artifact, databaseCommitted: false })

    expect(existsSync(plan.artifact.stagingDirectory)).toBeFalse()
    expect(existsSync(skillFilesAbs(appHome, 'skill-abortable'))).toBeFalse()
    expect(existsSync(skillVersionAbs(appHome, 'skill-abortable', 1))).toBeFalse()
  })

  test('plugin owner removes failed managed generations and retains committed publications', async () => {
    const appHome = await temporaryRoot()
    const pluginsDir = join(appHome, 'plugins')
    const context = requestContext()
    const owner = createPostgresqlResourcePackagePluginArtifactOwner({
      pluginsDir,
      installer: {
        plannedGenerationDirectory(input) {
          return join(input.pluginsDir, input.pluginId, 'generations', input.generationId)
        },
        async install(input) {
          const generationDirectory = join(
            input.pluginsDir,
            input.pluginId,
            'generations',
            input.generationId,
          )
          const cachedPath = join(generationDirectory, 'node_modules', 'fixture')
          mkdirSync(cachedPath, { recursive: true })
          writeFileSync(join(cachedPath, 'package.json'), '{"name":"fixture"}')
          return {
            cachedPath,
            resolvedVersion: '1.0.0',
            sourceKind: 'npm',
            generationDirectory,
          }
        },
      },
    })
    const aborted = BundleOpSchema.parse({
      opId: 'op-3',
      kind: 'plugin-create',
      slug: 'aborted-plugin',
      payload: {
        name: 'Aborted Plugin',
        description: '',
        spec: 'fixture@1.0.0',
        sourceKind: 'npm',
      },
    })
    if (aborted.kind !== 'plugin-create') throw new Error('fixture kind mismatch')
    const abortedPlan = owner.planInstall(context, {
      mutation: aborted,
      pluginId: 'plugin-aborted',
      generationId: 'generation-aborted',
    })
    await abortedPlan.install()
    await owner.compensate(context, {
      artifact: abortedPlan.artifact,
      databaseCommitted: false,
    })
    expect(existsSync(abortedPlan.artifact.generationDirectory)).toBeFalse()

    const committed = BundleOpSchema.parse({
      opId: 'op-4',
      kind: 'plugin-create',
      slug: 'committed-plugin',
      payload: {
        name: 'Committed Plugin',
        description: '',
        spec: 'fixture@1.0.0',
        sourceKind: 'npm',
      },
    })
    if (committed.kind !== 'plugin-create') throw new Error('fixture kind mismatch')
    const committedPlan = owner.planInstall(context, {
      mutation: committed,
      pluginId: 'plugin-committed',
      generationId: 'generation-committed',
    })
    await committedPlan.install()
    const committedReceipt: PostgresqlResourcePackageApplyReceipt = Object.freeze({
      journalId: 'journal-op-4',
      applied: Object.freeze([
        Object.freeze({
          resourceType: 'plugin' as const,
          operationId: committed.opId,
          resourceId: 'plugin-committed',
          action: 'create' as const,
          name: 'Committed Plugin',
        }),
      ]),
    })
    await owner.rollForward(context, {
      artifact: committedPlan.artifact,
      receipt: committedReceipt,
    })
    await owner.afterCommitted(context, committedReceipt)
    expect(existsSync(committedPlan.artifact.generationDirectory)).toBeTrue()
  })
})
