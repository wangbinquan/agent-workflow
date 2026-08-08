// RFC-271 T6 —— `ResourceBundle` 的 op union 与闭合性校验。
//
// 两条承重断言，各对应一次设计门 finding：
//
//  ① **12 分支 discriminated union**（R4-P1-4）：`{kind:'mcp-update'}` 不带 `expect`
//     必须 parse 失败。宽松 schema 放它过去之后，`commitMcpUpdateInTx` 只在
//     `expectedConfigHash !== undefined` 时才 CAS ⇒ **无栅栏覆盖**。
//
//  ② **`ops` 允许为空 + `rootRef` 可 external**（R4-P1-3 / R6-P1-1）：全 reuse 的包
//     翻译结果就是零 op。要求 `.min(1)` 会让它在 parse 阶段就失败、根本进不了
//     journal。但空 bundle **不等于免检**——引擎仍要跑 selectedExternalFence。

import { describe, expect, test } from 'bun:test'
import { BundleSchema, collectBundleRefIssues } from '../src/bundle/bundle'
import { BUNDLE_MAX_OPS, BundleOpSchema } from '../src/bundle/op'

const agentPayload = {
  name: 'auditor',
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
}

const mcpPayload = {
  name: 'github',
  description: '',
  type: 'local' as const,
  enabled: true,
  config: { command: ['tool'] },
}

describe('① op union 是 12 分支 discriminated —— 不是 optional 全开', () => {
  test('mcp-update 不带 expect 必须被拒（R4-P1-4 的具体反例）', () => {
    const bad = {
      opId: 'op-1',
      kind: 'mcp-update',
      target: 'external:01JMCP',
      payload: mcpPayload,
    }
    expect(BundleOpSchema.safeParse(bad).success).toBe(false)
  })

  test('mcp-update 带 expect 通过', () => {
    const good = {
      opId: 'op-1',
      kind: 'mcp-update',
      target: 'external:01JMCP',
      expect: { expectedConfigHash: 'h1' },
      payload: mcpPayload,
    }
    expect(BundleOpSchema.safeParse(good).success).toBe(true)
  })

  test('create 禁止带 target / expect', () => {
    for (const extra of [{ target: 'external:x' }, { expect: { expectedConfigHash: 'h' } }]) {
      const bad = {
        opId: 'op-1',
        kind: 'agent-create',
        slug: 'a1',
        payload: agentPayload,
        ...extra,
      }
      expect(BundleOpSchema.safeParse(bad).success).toBe(false)
    }
  })

  test('update 禁止带 slug，且 target 必须是 external', () => {
    const withSlug = {
      opId: 'op-1',
      kind: 'agent-update',
      slug: 'a1',
      target: 'external:01JA',
      expect: { expectedUpdatedAt: 1, expectedAclRevision: 0 },
      payload: agentPayload,
    }
    expect(BundleOpSchema.safeParse(withSlug).success).toBe(false)

    const localTarget = {
      opId: 'op-1',
      kind: 'agent-update',
      target: 'local:a1',
      expect: { expectedUpdatedAt: 1, expectedAclRevision: 0 },
      payload: agentPayload,
    }
    expect(BundleOpSchema.safeParse(localTarget).success).toBe(false)
  })

  test('expect 与资源类型绑定：agent 要 updatedAt+aclRevision，不接受 configHash', () => {
    const wrongToken = {
      opId: 'op-1',
      kind: 'agent-update',
      target: 'external:01JA',
      expect: { expectedConfigHash: 'h' },
      payload: agentPayload,
    }
    expect(BundleOpSchema.safeParse(wrongToken).success).toBe(false)
  })

  test('agent 的 expect 少一半也不行（R7-P2-13：两个都要）', () => {
    const half = {
      opId: 'op-1',
      kind: 'agent-update',
      target: 'external:01JA',
      expect: { expectedUpdatedAt: 1 },
      payload: agentPayload,
    }
    expect(BundleOpSchema.safeParse(half).success).toBe(false)
  })
})

describe('② ops 可空 + rootRef 可 external', () => {
  test('零 op 的 bundle 合法（全 reuse 的包）', () => {
    const empty = {
      bundleVersion: 1,
      ops: [],
      rootRef: 'external:01JAGENT',
      rootType: 'agent',
    }
    expect(BundleSchema.safeParse(empty).success).toBe(true)
  })

  test('external rootRef 缺 rootType 必须被拒（receipt 报不出根的类型）', () => {
    const noType = { bundleVersion: 1, ops: [], rootRef: 'external:01JAGENT' }
    const issues = collectBundleRefIssues(noType)
    expect(issues.map((i) => i.code)).toContain('bundle-root-type-missing')
    expect(BundleSchema.safeParse(noType).success).toBe(false)
  })

  test('local rootRef 指向不存在的 slug → 悬空', () => {
    const dangling = {
      bundleVersion: 1,
      ops: [{ opId: 'op-1', kind: 'agent-create' as const, slug: 'a1', payload: agentPayload }],
      rootRef: 'local:nope',
    }
    expect(collectBundleRefIssues(dangling).map((i) => i.code)).toContain('bundle-dangling-root')
  })
})

describe('闭合性：重复 slug / 悬空 local 引用 / op 上限', () => {
  test('两个 create op 用同一个 slug', () => {
    const dup = {
      ops: [
        { opId: 'op-1', kind: 'agent-create' as const, slug: 'a1', payload: agentPayload },
        { opId: 'op-2', kind: 'agent-create' as const, slug: 'a1', payload: agentPayload },
      ],
    }
    expect(collectBundleRefIssues(dup).map((i) => i.code)).toContain('bundle-duplicate-slug')
  })

  test('agent 的 dependsOn 指向不存在的 slug', () => {
    const dangling = {
      ops: [
        {
          opId: 'op-1',
          kind: 'agent-create' as const,
          slug: 'a1',
          payload: { ...agentPayload, dependsOn: ['local:ghost'] },
        },
      ],
    }
    const codes = collectBundleRefIssues(dangling).map((i) => i.code)
    expect(codes).toContain('bundle-dangling-local-ref')
  })

  test('工作组成员的 agentRef 也要扫到', () => {
    const wg = {
      ops: [
        {
          opId: 'op-1',
          kind: 'workgroup-create' as const,
          slug: 'g1',
          payload: {
            name: 'squad',
            description: '',
            instructions: '',
            mode: 'leader_worker',
            switches: { shareOutputs: true, directMessages: true, blackboard: true },
            maxRounds: 10,
            completionGate: true,
            members: [
              {
                memberType: 'agent',
                agentRef: 'local:ghost',
                displayName: 'A',
                roleDesc: '',
                sortOrder: 0,
              },
            ],
            leaderDisplayName: null,
          },
        },
      ],
    }
    expect(collectBundleRefIssues(wg as never).map((i) => i.code)).toContain(
      'bundle-dangling-local-ref',
    )
  })

  test('超过 op 上限报专门错误码（AC-B5：显式披露而非静默字面量）', () => {
    const many = {
      ops: Array.from({ length: BUNDLE_MAX_OPS + 1 }, (_, i) => ({
        opId: `op-${i + 1}`,
        kind: 'agent-create' as const,
        slug: `a${i}`,
        payload: agentPayload,
      })),
    }
    expect(collectBundleRefIssues(many).map((i) => i.code)).toContain('bundle-too-many-ops')
  })
})

describe('payload 逐字段对照正式 schema（AC-B3b）', () => {
  test('agent payload 带 network —— intent 版没有这个字段，照抄会静默回落 deny', () => {
    const withNetwork = {
      opId: 'op-1',
      kind: 'agent-create' as const,
      slug: 'a1',
      payload: { ...agentPayload, network: 'allow' as const },
    }
    const parsed = BundleOpSchema.safeParse(withNetwork)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect((parsed.data.payload as { network?: string }).network).toBe('allow')
    }
  })

  test('skills 槽接受 project: —— 其余引用槽拒绝它', () => {
    const projectSkill = {
      opId: 'op-1',
      kind: 'agent-create' as const,
      slug: 'a1',
      payload: { ...agentPayload, skills: ['project:repo-lint'] },
    }
    expect(BundleOpSchema.safeParse(projectSkill).success).toBe(true)

    const wrongSlot = {
      opId: 'op-1',
      kind: 'agent-create' as const,
      slug: 'a1',
      payload: { ...agentPayload, dependsOn: ['project:repo-lint'] },
    }
    expect(BundleOpSchema.safeParse(wrongSlot).success).toBe(false)
  })

  test('plugin payload 用正式字段名 options（不是 intent 的 optionsJson）', () => {
    const op = {
      opId: 'op-1',
      kind: 'plugin-create' as const,
      slug: 'p1',
      payload: {
        name: 'inventory',
        options: { a: 1 },
        spec: '@acme/x@1.0.0',
        description: '',
        enabled: true,
        sourceKind: 'npm' as const,
      },
    }
    expect(BundleOpSchema.safeParse(op).success).toBe(true)

    const intentStyle = { ...op, payload: { ...op.payload, optionsJson: { a: 1 } } }
    // strict() ⇒ 多出来的 optionsJson 会被拒，防止两处规范打架
    expect(BundleOpSchema.safeParse(intentStyle).success).toBe(false)
  })

  test('技能文件路径允许非 ASCII，但拒绝越界', () => {
    const mk = (path: string) => ({
      opId: 'op-1',
      kind: 'skill-create' as const,
      slug: 's1',
      payload: {
        name: 'review',
        description: '',
        frontmatterExtra: {},
        bodyMd: '',
        files: [{ path, ref: 'skills/review/x' }],
      },
    })
    expect(BundleOpSchema.safeParse(mk('references/审计 规则.md')).success).toBe(true)
    expect(BundleOpSchema.safeParse(mk('../escape.md')).success).toBe(false)
    expect(BundleOpSchema.safeParse(mk('/abs.md')).success).toBe(false)
  })
})
