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
import { createSqliteActionTemplateStore } from '../src/modules/development-automation/infrastructure/sqliteConfigResourceStore'
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
  return { store: createSqliteActionTemplateStore(db), now: () => ++tick }
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

  test('store lifecycle: create → revise → publish twice (immutable, increasing) → archive', () => {
    const deps = newDeps()
    const created = createActionTemplate(deps, {
      actorUserId: 'user-1',
      name: 'java-spring',
      capabilityId: 'change.implement',
      draft: VALID_CONTENT,
    })
    expect(created.visibility).toBe('private')
    expect(created.ownerUserId).toBe('user-1')
    expect(created.extra.capabilityId).toBe('change.implement')

    const first = publishActionTemplate(deps, { id: created.id, actorUserId: 'user-1' })
    expect(first.revision).toBe(1)
    const rev1 = deps.store.getRevision(created.id, 1)
    expect(rev1?.contentDigest).toBe(first.contentDigest)

    reviseActionTemplateDraft(deps, {
      id: created.id,
      draft: { ...VALID_CONTENT, promptSupplement: 'v2 supplement' },
    })
    const second = publishActionTemplate(deps, { id: created.id, actorUserId: 'user-1' })
    expect(second.revision).toBe(2)
    expect(second.contentDigest).not.toBe(first.contentDigest)
    // revision 1 不因第二次 publish 改变（immutable）
    expect(deps.store.getRevision(created.id, 1)?.contentJson).toBe(rev1?.contentJson)
    expect(deps.store.listRevisions(created.id).map((r) => r.revision)).toEqual([1, 2])

    archiveActionTemplate(deps, { id: created.id })
    expect(deps.store.getById(created.id)?.archivedAt).not.toBeNull()
    expect(() => publishActionTemplate(deps, { id: created.id, actorUserId: 'user-1' })).toThrow(
      'archived',
    )
  })

  test('owner+name uniqueness is a typed 409; different owners may share a name', () => {
    const deps = newDeps()
    createActionTemplate(deps, {
      actorUserId: 'user-1',
      name: 'dup',
      capabilityId: 'change.implement',
      draft: {},
    })
    expect(() =>
      createActionTemplate(deps, {
        actorUserId: 'user-1',
        name: 'dup',
        capabilityId: 'pipeline.repair',
        draft: {},
      }),
    ).toThrow('name already used')
    expect(
      createActionTemplate(deps, {
        actorUserId: 'user-2',
        name: 'dup',
        capabilityId: 'change.implement',
        draft: {},
      }).name,
    ).toBe('dup')
  })

  test('invalid draft blocks publish with 422 and leaves no revision behind', () => {
    const deps = newDeps()
    const created = createActionTemplate(deps, {
      actorUserId: 'user-1',
      name: 'broken',
      capabilityId: 'change.implement',
      draft: { schemaVersion: 1, nonsense: true },
    })
    expect(() => publishActionTemplate(deps, { id: created.id, actorUserId: 'user-1' })).toThrow()
    expect(deps.store.listRevisions(created.id)).toEqual([])
    expect(deps.store.getById(created.id)?.publishedRevision).toBeNull()
  })

  test('visibility filtering: private rows hidden from other actors, admin bypass sees all', () => {
    const deps = newDeps()
    const mine = createActionTemplate(deps, {
      actorUserId: 'user-1',
      name: 'mine',
      capabilityId: 'change.implement',
      draft: {},
    })
    const audienceOwner = { actorUserId: 'user-1', bypassAcl: false }
    const audienceOther = { actorUserId: 'user-2', bypassAcl: false }
    const audienceAdmin = { actorUserId: 'admin', bypassAcl: true }
    expect(listConfigResources(deps.store, audienceOwner).map((r) => r.id)).toEqual([mine.id])
    expect(listConfigResources(deps.store, audienceOther)).toEqual([])
    expect(listConfigResources(deps.store, audienceAdmin).map((r) => r.id)).toEqual([mine.id])
    expect(getConfigResource(deps.store, audienceOther, mine.id)).toBeNull()
    expect(getConfigResource(deps.store, audienceOwner, mine.id)?.id).toBe(mine.id)
  })
})
