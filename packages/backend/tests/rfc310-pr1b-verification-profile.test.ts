// RFC-310 PR-1B T13a —— VerificationProfile 资源锁。
//
// 锁：①内容 codec strict（round-trip + unknown-key 全拒 + timeout/parallel
// 硬上限）；②publish validator 拒空 steps 与重复 stepId；③sqlite store 全链
// （publish 递增 + revision immutable + name 409 + 非法 draft 不产 revision）。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb } from '../src/db/client'
import {
  validateVerificationProfileForPublish,
  verificationProfileContentSchema,
  VERIFICATION_STEP_TIMEOUT_CAP_MS,
} from '../src/modules/development-automation/domain/verificationProfile'
import {
  archiveVerificationProfile,
  createVerificationProfile,
  publishVerificationProfile,
  reviseVerificationProfileDraft,
  type VerificationProfileCommandDeps,
} from '../src/modules/development-automation/application/commands/verificationProfileCommands'
import { createSqliteVerificationProfileStore } from '../src/modules/development-automation/infrastructure/sqliteConfigResourceStore'
import { parseOk, unknownKeySurvivors } from './helpers/rfc310UnknownKeyHarness'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const VALID_CONTENT = {
  schemaVersion: 1,
  steps: [
    {
      stepId: 'build',
      programRef: 'program-maven-build@1',
      argsRef: null,
      timeoutMs: 10 * 60 * 1000,
      networkProfileRef: 'network-offline@1',
      successExitCodes: [0],
      evidenceSelectors: [{ kind: 'file-glob', value: 'target/surefire-reports/*.xml' }],
    },
    {
      stepId: 'test',
      programRef: 'program-maven-test@1',
      argsRef: 'args-fast@1',
      timeoutMs: 20 * 60 * 1000,
      networkProfileRef: 'network-offline@1',
      successExitCodes: [0],
      evidenceSelectors: [{ kind: 'stdout-tail', value: 20_000 }],
    },
  ],
  stopPolicy: 'first-failure',
  maxParallel: 1,
} as const

function newDeps(): VerificationProfileCommandDeps {
  const db = createInMemoryDb(MIGRATIONS)
  let tick = 2_000_000
  return { store: createSqliteVerificationProfileStore(db), now: () => ++tick }
}

describe('rfc310 pr1b verification profile', () => {
  test('content codec: round-trip, unknown keys rejected, hard caps enforced', () => {
    const parsed = parseOk(verificationProfileContentSchema, VALID_CONTENT)
    expect(parsed.steps).toHaveLength(2)
    expect(unknownKeySurvivors(verificationProfileContentSchema, VALID_CONTENT)).toEqual([])
    expect(
      verificationProfileContentSchema.safeParse({
        ...VALID_CONTENT,
        steps: [{ ...VALID_CONTENT.steps[0], timeoutMs: VERIFICATION_STEP_TIMEOUT_CAP_MS + 1 }],
      }).success,
    ).toBe(false)
    expect(
      verificationProfileContentSchema.safeParse({ ...VALID_CONTENT, maxParallel: 9 }).success,
    ).toBe(false)
  })

  test('publish validator: empty steps and duplicate stepId are blocked', () => {
    expect(
      validateVerificationProfileForPublish(
        parseOk(verificationProfileContentSchema, { ...VALID_CONTENT, steps: [] }),
      ).map((v) => v.code),
    ).toEqual(['no-steps'])
    const dup = parseOk(verificationProfileContentSchema, {
      ...VALID_CONTENT,
      steps: [VALID_CONTENT.steps[0], { ...VALID_CONTENT.steps[1], stepId: 'build' }],
    })
    expect(validateVerificationProfileForPublish(dup).map((v) => v.code)).toEqual([
      'duplicate-step-id',
    ])
  })

  test('store lifecycle: publish increments, revisions immutable, archive blocks publish', () => {
    const deps = newDeps()
    const created = createVerificationProfile(deps, {
      actorUserId: 'user-1',
      name: 'maven',
      draft: VALID_CONTENT,
    })
    const first = publishVerificationProfile(deps, { id: created.id, actorUserId: 'user-1' })
    expect(first.revision).toBe(1)
    reviseVerificationProfileDraft(deps, {
      id: created.id,
      draft: { ...VALID_CONTENT, stopPolicy: 'collect-all' },
    })
    const second = publishVerificationProfile(deps, { id: created.id, actorUserId: 'user-1' })
    expect(second.revision).toBe(2)
    expect(deps.store.getRevision(created.id, 1)?.contentJson).toContain('first-failure')
    archiveVerificationProfile(deps, { id: created.id })
    expect(() =>
      publishVerificationProfile(deps, { id: created.id, actorUserId: 'user-1' }),
    ).toThrow('archived')
  })

  test('name conflict is typed 409; invalid draft leaves no revision', () => {
    const deps = newDeps()
    createVerificationProfile(deps, { actorUserId: 'u', name: 'dup', draft: {} })
    expect(() =>
      createVerificationProfile(deps, { actorUserId: 'u', name: 'dup', draft: {} }),
    ).toThrow('name already used')
    const broken = createVerificationProfile(deps, {
      actorUserId: 'u',
      name: 'broken',
      draft: { schemaVersion: 1, steps: 'nope' },
    })
    expect(() => publishVerificationProfile(deps, { id: broken.id, actorUserId: 'u' })).toThrow()
    expect(deps.store.listRevisions(broken.id)).toEqual([])
  })
})
