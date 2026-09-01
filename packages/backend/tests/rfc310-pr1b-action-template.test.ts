// RFC-310 PR-1B T13 —— ActionTemplate 资源锁。
//
// 锁四件事：①内容 codec strict（round-trip + 每层 unknown-key 全拒 + 越权
// 键如 stages/workspaceMode 被拒——模板无字段可覆盖能力合同）；②publish
// validator 拒绝目录外/超预算 compatibility predicate；③sqlite store 的
// create/revise/publish/archive 全链 + owner+name 唯一 409 + revision
// immutable（两次 publish 递增、旧行 byte 不变）；④draft 非法时 publish
// 被 422 拒且不产生 revision。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb } from '../src/db/client'
import {
  actionTemplateContentSchema,
  validateActionTemplateForPublish,
} from '../src/modules/development-automation/domain/actionTemplate'
import {
  archiveActionTemplate,
  createActionTemplate,
  publishActionTemplate,
  reviseActionTemplateDraft,
  type ActionTemplateCommandDeps,
} from '../src/modules/development-automation/application/commands/actionTemplateCommands'
import {
  getConfigResource,
  listConfigResources,
} from '../src/modules/development-automation/application/queries/configResourceQueries'
import { createSqliteActionTemplatePersistence } from '../src/modules/development-automation/infrastructure/sqliteConfigResourceStore'
import { parseOk, unknownKeySurvivors } from './helpers/rfc310UnknownKeyHarness'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const VALID_CONTENT = {
  schemaVersion: 1,
  capabilityId: 'change.implement',
  capabilityContractVersion: 1,
  labels: ['java', 'spring'],
  compatibility: [{ kind: 'set-contains-any', fact: 'repository.languages', values: ['java'] }],
  executor: { kind: 'agent', agentRef: 'agent-java@5' },
  runtimeProfileRef: 'runtime-claude@1',
  promptSupplement: 'Spring Boot 项目使用 constructor injection。',
  skillRefs: ['skill-java-style@2'],
  mcpRefs: [],
  readOnlyResourceRefs: [],
  contextProfileRef: null,
  writablePathPolicyRef: null,
  additionalProtectedPathClasses: ['generated-sources'],
  verificationProfileRef: 'verify-maven@1',
  retryDefaults: { sameSession: 2, freshSession: 1 },
} as const

function newDeps(): ActionTemplateCommandDeps {
  const db = createInMemoryDb(MIGRATIONS)
  let tick = 1_000_000
  return { store: createSqliteActionTemplatePersistence(db), now: () => ++tick }
}

describe('rfc310 pr1b action template', () => {
  test('content codec: round-trip, unknown keys rejected at every level, no contract override keys', () => {
    const parsed = parseOk(actionTemplateContentSchema, VALID_CONTENT)
    expect(parsed.capabilityId).toBe('change.implement')
    expect(unknownKeySurvivors(actionTemplateContentSchema, VALID_CONTENT)).toEqual([])
    // 能力合同字段在模板里不存在——尝试携带即 unknown key 拒绝（§3.4 不可配置清单）
    for (const forged of [
      'stages',
      'workspaceMode',
      'semanticValidatorId',
      'allowedEffectKinds',
      'outputSchemaId',
    ]) {
      expect(
        actionTemplateContentSchema.safeParse({ ...VALID_CONTENT, [forged]: 'x' }).success,
      ).toBe(false)
    }
    // 非 agent 能力不可做模板
    expect(
      actionTemplateContentSchema.safeParse({ ...VALID_CONTENT, capabilityId: 'change.publish' })
        .success,
    ).toBe(false)
    expect(
      actionTemplateContentSchema.safeParse({
        ...VALID_CONTENT,
        retryDefaults: { sameSession: 99, freshSession: 1 },
      }).success,
    ).toBe(false)
  })

  test('publish validator rejects catalog-unknown and over-budget compatibility predicates', () => {
    const parsed = parseOk(actionTemplateContentSchema, VALID_CONTENT)
    expect(validateActionTemplateForPublish(parsed)).toEqual([])
    const badFact = parseOk(actionTemplateContentSchema, {
      ...VALID_CONTENT,
      compatibility: [{ kind: 'enum-equals', fact: 'no.such.fact', value: 'x' }],
    })
    expect(validateActionTemplateForPublish(badFact).map((v) => v.code)).toEqual([
      'compatibility-predicate-invalid',
    ])
  })

  test('store lifecycle: create → revise → publish twice (immutable, increasing) → archive', async () => {
    const deps = newDeps()
    const created = await createActionTemplate(deps, {
      actorUserId: 'user-1',
      name: 'java-spring',
      capabilityId: 'change.implement',
      draft: VALID_CONTENT,
    })
    expect(created.visibility).toBe('private')
    expect(created.ownerUserId).toBe('user-1')
    expect(created.extra.capabilityId).toBe('change.implement')

    const first = await publishActionTemplate(deps, { id: created.id, actorUserId: 'user-1' })
    expect(first.revision).toBe(1)
    const rev1 = await deps.store.getRevision(created.id, 1)
    expect(rev1?.contentDigest).toBe(first.contentDigest)

    await reviseActionTemplateDraft(deps, {
      id: created.id,
      draft: { ...VALID_CONTENT, promptSupplement: 'v2 supplement' },
    })
    const second = await publishActionTemplate(deps, { id: created.id, actorUserId: 'user-1' })
    expect(second.revision).toBe(2)
    expect(second.contentDigest).not.toBe(first.contentDigest)
    // revision 1 不因第二次 publish 改变（immutable）
    expect((await deps.store.getRevision(created.id, 1))?.contentJson).toBe(rev1?.contentJson)
    expect((await deps.store.listRevisions(created.id)).map((r) => r.revision)).toEqual([1, 2])

    await archiveActionTemplate(deps, { id: created.id })
    expect((await deps.store.getById(created.id))?.archivedAt).not.toBeNull()
    await expect(
      publishActionTemplate(deps, { id: created.id, actorUserId: 'user-1' }),
    ).rejects.toThrow('archived')
  })

  test('owner+name uniqueness is a typed 409; different owners may share a name', async () => {
    const deps = newDeps()
    await createActionTemplate(deps, {
      actorUserId: 'user-1',
      name: 'dup',
      capabilityId: 'change.implement',
      draft: {},
    })
    await expect(
      createActionTemplate(deps, {
        actorUserId: 'user-1',
        name: 'dup',
        capabilityId: 'pipeline.repair',
        draft: {},
      }),
    ).rejects.toThrow('name already used')
    expect(
      (
        await createActionTemplate(deps, {
          actorUserId: 'user-2',
          name: 'dup',
          capabilityId: 'change.implement',
          draft: {},
        })
      ).name,
    ).toBe('dup')
  })

  test('invalid draft blocks publish with 422 and leaves no revision behind', async () => {
    const deps = newDeps()
    const created = await createActionTemplate(deps, {
      actorUserId: 'user-1',
      name: 'broken',
      capabilityId: 'change.implement',
      draft: { schemaVersion: 1, nonsense: true },
    })
    await expect(
      publishActionTemplate(deps, { id: created.id, actorUserId: 'user-1' }),
    ).rejects.toThrow()
    expect(await deps.store.listRevisions(created.id)).toEqual([])
    expect((await deps.store.getById(created.id))?.publishedRevision).toBeNull()
  })

  test('visibility filtering: private rows hidden from other actors, admin bypass sees all', async () => {
    const deps = newDeps()
    const mine = await createActionTemplate(deps, {
      actorUserId: 'user-1',
      name: 'mine',
      capabilityId: 'change.implement',
      draft: {},
    })
    const audienceOwner = { actorUserId: 'user-1', bypassAcl: false }
    const audienceOther = { actorUserId: 'user-2', bypassAcl: false }
    const audienceAdmin = { actorUserId: 'admin', bypassAcl: true }
    expect((await listConfigResources(deps.store, audienceOwner)).map((r) => r.id)).toEqual([
      mine.id,
    ])
    expect(await listConfigResources(deps.store, audienceOther)).toEqual([])
    expect((await listConfigResources(deps.store, audienceAdmin)).map((r) => r.id)).toEqual([
      mine.id,
    ])
    expect(await getConfigResource(deps.store, audienceOther, mine.id)).toBeNull()
    expect((await getConfigResource(deps.store, audienceOwner, mine.id))?.id).toBe(mine.id)
  })
})
