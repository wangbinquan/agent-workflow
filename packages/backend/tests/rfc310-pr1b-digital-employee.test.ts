// RFC-310 PR-1B（T14/T15）—— DigitalEmployee / AutomationPolicy 资源测试。
//
// 锁的合同：①内容 codec strict 到每层（unknown-key 全拒）；②发布闭包检查
// 的每条违规都可单独打红（缺模板/能力不匹配/重复 sourceKey/双 default/
// adapter purpose 错/policy 缺失/predicate 越目录/重复 ruleId/空 route）；
// ③identity+revisions 双表：publish 递增、revision 行 immutable、校验不过
// 不产生半个 revision；④name 冲突 typed 409。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb } from '../src/db/client'
import {
  digitalEmployeeContentSchema,
  validateDigitalEmployeeForPublish,
  type DigitalEmployeeContent,
  type EmployeePublishLookup,
} from '../src/modules/development-automation/domain/digitalEmployee'
import { defaultAutomationPolicyContent } from '../src/modules/development-automation/domain/automationPolicy'
import {
  archiveDigitalEmployee,
  createAutomationPolicy,
  createDigitalEmployee,
  getDigitalEmployee,
  getDigitalEmployeeRevision,
  publishAutomationPolicy,
  publishDigitalEmployee,
  reviseDigitalEmployeeDraft,
} from '../src/modules/development-automation/infrastructure/sqliteDigitalEmployeeStore'
import { unknownKeySurvivors } from './helpers/rfc310UnknownKeyHarness'

const MIGRATIONS = resolve(import.meta.dirname, '..', 'db', 'migrations')

const VALID_CONTENT: DigitalEmployeeContent = {
  schemaVersion: 1,
  description: 'Java Spring employee',
  supportedRepositoryFacts: [
    { kind: 'set-contains-any', fact: 'repository.languages', values: ['java'] },
  ],
  capabilityRoutes: [
    {
      capabilityId: 'change.implement',
      rules: [
        {
          ruleId: 'java',
          when: [
            {
              kind: 'set-contains-any',
              fact: 'repository.changedPathClasses',
              values: ['java-module'],
            },
          ],
          templateRef: { id: 'tpl-java', revision: 1 },
        },
      ],
      fallbackTemplateRef: null,
    },
  ],
  requirementSources: [
    { sourceKey: 'req-sys', adapterRef: { id: 'ad-req', revision: 1 }, isDefault: true },
  ],
  pipelineProviders: [{ providerKey: 'inhouse-ci', adapterRef: { id: 'ad-pipe', revision: 1 } }],
  defaultPolicyRef: { id: 'pol-1', revision: 1 },
}

const FULL_LOOKUP: EmployeePublishLookup = {
  getTemplate: (id) => (id === 'tpl-java' ? { capabilityId: 'change.implement' } : null),
  getPolicy: (id) => (id === 'pol-1' ? { exists: true } : null),
  getAdapter: (id) =>
    id === 'ad-req'
      ? { purpose: 'requirement-source' }
      : id === 'ad-pipe'
        ? { purpose: 'pipeline-gate' }
        : null,
}

describe('T14 digital employee codec + publish closure', () => {
  test('valid content round-trips and rejects unknown keys at every level', () => {
    const parsed = digitalEmployeeContentSchema.parse(VALID_CONTENT)
    expect(parsed.capabilityRoutes).toHaveLength(1)
    expect(unknownKeySurvivors(digitalEmployeeContentSchema, VALID_CONTENT)).toEqual([])
    expect(validateDigitalEmployeeForPublish(parsed, FULL_LOOKUP)).toEqual([])
  })

  test.each([
    [
      'route-empty',
      (c: DigitalEmployeeContent) => ({
        ...c,
        capabilityRoutes: [
          { capabilityId: 'change.review' as const, rules: [], fallbackTemplateRef: null },
        ],
      }),
    ],
    [
      'template-missing',
      (c: DigitalEmployeeContent) => ({
        ...c,
        capabilityRoutes: [
          {
            ...c.capabilityRoutes[0]!,
            rules: [
              { ...c.capabilityRoutes[0]!.rules[0]!, templateRef: { id: 'nope', revision: 9 } },
            ],
          },
        ],
      }),
    ],
    [
      'template-capability-mismatch',
      (c: DigitalEmployeeContent) => ({
        ...c,
        capabilityRoutes: [
          { ...c.capabilityRoutes[0]!, capabilityId: 'mr.feedback.apply' as const },
        ],
      }),
    ],
    [
      'duplicate-source-key',
      (c: DigitalEmployeeContent) => ({
        ...c,
        requirementSources: [c.requirementSources[0]!, c.requirementSources[0]!],
      }),
    ],
    [
      'multiple-default-sources',
      (c: DigitalEmployeeContent) => ({
        ...c,
        requirementSources: [
          c.requirementSources[0]!,
          { sourceKey: 'other', adapterRef: { id: 'ad-req', revision: 1 }, isDefault: true },
        ],
      }),
    ],
    [
      'adapter-missing',
      (c: DigitalEmployeeContent) => ({
        ...c,
        pipelineProviders: [{ providerKey: 'x', adapterRef: { id: 'ghost', revision: 1 } }],
      }),
    ],
    [
      'adapter-purpose-mismatch',
      (c: DigitalEmployeeContent) => ({
        ...c,
        pipelineProviders: [{ providerKey: 'x', adapterRef: { id: 'ad-req', revision: 1 } }],
      }),
    ],
    [
      'policy-missing',
      (c: DigitalEmployeeContent) => ({ ...c, defaultPolicyRef: { id: 'ghost', revision: 1 } }),
    ],
    [
      'predicate-invalid',
      (c: DigitalEmployeeContent) => ({
        ...c,
        supportedRepositoryFacts: [
          { kind: 'enum-equals' as const, fact: 'not.in.catalog', value: 'x' },
        ],
      }),
    ],
    [
      'duplicate-rule-id',
      (c: DigitalEmployeeContent) => ({
        ...c,
        capabilityRoutes: [
          {
            ...c.capabilityRoutes[0]!,
            rules: [c.capabilityRoutes[0]!.rules[0]!, c.capabilityRoutes[0]!.rules[0]!],
          },
        ],
      }),
    ],
  ] as const)('publish closure rejects: %s', (code, mutate) => {
    const mutated = digitalEmployeeContentSchema.parse(mutate(VALID_CONTENT))
    const violations = validateDigitalEmployeeForPublish(mutated, FULL_LOOKUP)
    expect(violations.map((v) => v.code)).toContain(code)
  })
})

describe('T14/T15 identity + immutable revisions store', () => {
  test('employee create → publish increments revisions; blocked publish writes nothing', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const created = await createDigitalEmployee(db, {
      name: 'java-spring',
      ownerUserId: null,
      draft: VALID_CONTENT,
    })
    expect(created.publishedRevision).toBeNull()

    await expect(
      createDigitalEmployee(db, { name: 'java-spring', ownerUserId: null, draft: VALID_CONTENT }),
    ).rejects.toMatchObject({ code: 'digital-employee-name-taken', status: 409 })

    const first = await publishDigitalEmployee(db, {
      id: created.id,
      publishedBy: 'user-1',
      lookup: FULL_LOOKUP,
    })
    expect(first.revision).toBe(1)
    const rev1 = await getDigitalEmployeeRevision(db, created.id, 1)
    expect(rev1).not.toBeNull()

    await reviseDigitalEmployeeDraft(db, {
      id: created.id,
      draft: { ...VALID_CONTENT, description: 'v2' },
    })
    const second = await publishDigitalEmployee(db, {
      id: created.id,
      publishedBy: 'user-1',
      lookup: FULL_LOOKUP,
    })
    expect(second.revision).toBe(2)
    // revision 1 保持 immutable（内容与 digest 不因后续 publish 改变）
    expect(await getDigitalEmployeeRevision(db, created.id, 1)).toEqual(rev1)

    // publish blocked：lookup 缺 policy ⇒ 无 revision 3
    await reviseDigitalEmployeeDraft(db, {
      id: created.id,
      draft: { ...VALID_CONTENT, defaultPolicyRef: { id: 'ghost', revision: 1 } },
    })
    await expect(
      publishDigitalEmployee(db, { id: created.id, publishedBy: null, lookup: FULL_LOOKUP }),
    ).rejects.toMatchObject({ code: 'digital-employee-publish-blocked', status: 422 })
    expect(await getDigitalEmployeeRevision(db, created.id, 3)).toBeNull()

    await archiveDigitalEmployee(db, created.id)
    const archived = await getDigitalEmployee(db, created.id)
    expect(archived?.archivedAt).not.toBeNull()
  })

  test('policy publish uses domain validator; duplicate rule ids are blocked', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const ok = await createAutomationPolicy(db, {
      name: 'default-policy',
      ownerUserId: null,
      draft: defaultAutomationPolicyContent(),
    })
    const published = await publishAutomationPolicy(db, { id: ok.id, publishedBy: null })
    expect(published.revision).toBe(1)

    const bad = defaultAutomationPolicyContent()
    bad.actionPriority.rules.push({ ...bad.actionPriority.rules[0]! })
    const badRow = await createAutomationPolicy(db, {
      name: 'dup-rule-policy',
      ownerUserId: null,
      draft: bad,
    })
    await expect(
      publishAutomationPolicy(db, { id: badRow.id, publishedBy: null }),
    ).rejects.toMatchObject({ code: 'automation-policy-publish-blocked' })
  })
})
