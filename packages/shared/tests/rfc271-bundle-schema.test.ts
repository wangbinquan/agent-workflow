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

//
// 覆盖验收条款：AC-B1（ResourceBundle 表达）/ AC-B3（12 分支严格 discriminated union）
//   / AC-B3b（payload 逐字段对照正式 schema）/ AC-B6（ops 可空）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）

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

  test('local slug 存在但资源类型不对：schema 早拒绝，不留给 lowering', () => {
    // 真实反例：只用 Set<slug> 检查会认为已闭合，随后把 plugin 的预铸 id
    // 写进 agent.mcp。最终虽会被事务内引用栅栏回滚，preview/schema 已经给了假阳性。
    const wrong = {
      bundleVersion: 1,
      ops: [
        {
          opId: 'op-1',
          kind: 'plugin-create' as const,
          slug: 'tool',
          payload: { name: 'tool', spec: 'tool@1', sourceKind: 'npm' as const },
        },
        {
          opId: 'op-2',
          kind: 'agent-create' as const,
          slug: 'agent',
          payload: { ...agentPayload, mcp: ['local:tool'] },
        },
      ],
      rootRef: 'local:agent',
    }
    expect(collectBundleRefIssues(wrong).map((i) => i.code)).toContain(
      'bundle-local-ref-type-mismatch',
    )
    expect(BundleSchema.safeParse(wrong).success).toBe(false)
  })

  test('local slug 的类型与槽位一致：正常通过', () => {
    const good = {
      bundleVersion: 1,
      ops: [
        { opId: 'op-1', kind: 'mcp-create' as const, slug: 'tool', payload: mcpPayload },
        {
          opId: 'op-2',
          kind: 'agent-create' as const,
          slug: 'agent',
          payload: { ...agentPayload, mcp: ['local:tool'] },
        },
      ],
      rootRef: 'local:agent',
    }
    expect(collectBundleRefIssues(good)).toEqual([])
    expect(BundleSchema.safeParse(good).success).toBe(true)
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
  test('removed agent network field is rejected explicitly', () => {
    const withNetwork = {
      opId: 'op-1',
      kind: 'agent-create' as const,
      slug: 'a1',
      payload: { ...agentPayload, network: 'allow' as const },
    }
    const parsed = BundleOpSchema.safeParse(withNetwork)
    expect(parsed.success).toBe(false)
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

  test('builtin identity 必须与 agent 的具体槽类型一致', () => {
    const opWith = (patch: Record<string, unknown>) => ({
      opId: 'op-1',
      kind: 'agent-create' as const,
      slug: 'a1',
      payload: { ...agentPayload, ...patch },
    })
    // dependsOn 是 agent 槽，只有 builtin:agent 是有意义的。
    expect(BundleOpSchema.safeParse(opWith({ dependsOn: ['builtin:agent/base'] })).success).toBe(
      true,
    )
    expect(BundleOpSchema.safeParse(opWith({ dependsOn: ['builtin:workflow/base'] })).success).toBe(
      false,
    )

    // mcp / plugin / skill 都没有 builtin 列；identity 域的词法放行不得渗进槽位。
    for (const patch of [
      { mcp: ['builtin:agent/base'] },
      { mcp: ['builtin:workflow/base'] },
      { plugins: ['builtin:agent/base'] },
      { plugins: ['builtin:workflow/base'] },
      { skills: ['builtin:agent/base'] },
      { skills: ['builtin:workflow/base'] },
    ]) {
      expect({ patch, ok: BundleOpSchema.safeParse(opWith(patch)).success }).toEqual({
        patch,
        ok: false,
      })
    }
  })

  test('workgroup.agentRef 允许 builtin:agent，拒绝 builtin:workflow', () => {
    const opWith = (agentRef: string) => ({
      opId: 'op-1',
      kind: 'workgroup-create' as const,
      slug: 'g1',
      payload: {
        name: 'group',
        description: '',
        instructions: '',
        mode: 'leader_worker' as const,
        switches: { shareOutputs: true, directMessages: true, blackboard: true },
        maxRounds: 10,
        completionGate: true,
        members: [
          {
            memberType: 'agent' as const,
            agentRef,
            displayName: 'leader',
            roleDesc: '',
            sortOrder: 0,
          },
        ],
        leaderDisplayName: 'leader',
      },
    })
    expect(BundleOpSchema.safeParse(opWith('builtin:agent/base')).success).toBe(true)
    expect(BundleOpSchema.safeParse(opWith('builtin:workflow/base')).success).toBe(false)
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

  test('技能文件 path/ref 都必须唯一，避免同一落点或同一载体被含糊复用', () => {
    const mk = (files: Array<{ path: string; ref: string }>) => ({
      opId: 'op-1',
      kind: 'skill-create' as const,
      slug: 's1',
      payload: {
        name: 'review',
        description: '',
        frontmatterExtra: {},
        bodyMd: '',
        files,
      },
    })
    expect(
      BundleOpSchema.safeParse(
        mk([
          { path: 'a.md', ref: 'skills/s1/files/a.md' },
          { path: 'a.md', ref: 'skills/s1/files/b.md' },
        ]),
      ).success,
    ).toBe(false)
    expect(
      BundleOpSchema.safeParse(
        mk([
          { path: 'a.md', ref: 'skills/s1/files/x' },
          { path: 'b.md', ref: 'skills/s1/files/x' },
        ]),
      ).success,
    ).toBe(false)
  })
})

describe('workflow definition 引用 walker —— record 外壳不能绕过域 codec', () => {
  const opWith = (node: Record<string, unknown>) => ({
    opId: 'op-1',
    kind: 'workflow-create' as const,
    slug: 'wf-root',
    payload: {
      name: 'root',
      description: '',
      definition: { $schema_version: 4, inputs: [], edges: [], nodes: [{ id: 'n1', ...node }] },
    },
  })

  test('正例：三种槽位各自的 wire 形态通过', () => {
    expect(BundleOpSchema.safeParse(opWith({ agentRef: 'builtin:agent/merger' })).success).toBe(
      true,
    )
    expect(BundleOpSchema.safeParse(opWith({ workflowRef: 'builtin:workflow/host' })).success).toBe(
      true,
    )
    expect(BundleOpSchema.safeParse(opWith({ workflowRef: 'name:workflow/audit' })).success).toBe(
      true,
    )
    expect(BundleOpSchema.safeParse(opWith({ workgroupRef: 'name:workgroup/squad' })).success).toBe(
      true,
    )
  })

  test('反例：词法错/跨域/声明 type 与槽位不符都早拒绝', () => {
    const bad: Array<Record<string, unknown>> = [
      { agentRef: 'name:workflow/audit' },
      { agentRef: 'builtin:workflow/host' },
      { workflowRef: 'project:repo-skill' },
      { workflowRef: 'name:workgroup/squad' },
      { workflowRef: 'builtin:agent/merger' },
      { workgroupRef: 'name:workflow/audit' },
      { workgroupRef: 'builtin:workflow/host' },
      { workflowRef: 42 },
    ]
    for (const node of bad) {
      expect({ node, ok: BundleOpSchema.safeParse(opWith(node)).success }).toEqual({
        node,
        ok: false,
      })
    }
  })

  test('canonical id/name 字段不得绕过 portable ref；有引用的节点必须带对应 *Ref', () => {
    const bad: Array<Record<string, unknown>> = [
      { kind: 'agent-single', agentId: 'SOURCE_AGENT' },
      { kind: 'call-workflow', workflowName: 'audit', workflowId: 'SOURCE_WF' },
      { kind: 'call-workgroup', workgroupName: 'squad', workgroupId: 'SOURCE_WG' },
      { kind: 'agent-single' },
      { kind: 'call-workflow' },
      { kind: 'call-workgroup' },
      // 即使 portable ref 同时存在，也不能夹带一份相互矛盾的 canonical cache。
      { kind: 'call-workflow', workflowRef: 'name:workflow/audit', workflowId: 'ATTACKER' },
    ]
    for (const node of bad) {
      expect({ node, ok: BundleOpSchema.safeParse(opWith(node)).success }).toEqual({
        node,
        ok: false,
      })
    }

    expect(
      BundleOpSchema.safeParse(
        opWith({ kind: 'agent-single', agentName: 'display-only', agentRef: 'local:agent' }),
      ).success,
    ).toBe(true)
  })
})

describe('闭合性扫描必须扫**真实字段名** —— call 槽的 local: 引用', () => {
  // 这条锁的是一次真实缺陷：`collectLocalRefs` 扫的是 `rec.targetRef`，一个**根本
  // 不存在的字段**（call 目标的实际字段是 `workflowRef` / `workgroupRef`，见 serialize
  // 的 lifting）。于是 call 槽的 `local:` 引用从来没被闭合性校验扫到过 —— 一个引用了
  // 包内子工作流、而该子工作流又没有 create op 的包，能一路过 schema，到 apply 才炸。
  //
  // 「字段名写错」这类缺陷的隐蔽之处在于**它永远不报错**：扫一个 undefined 字段的结果
  // 就是「没有引用」，与「引用都合法」的观测完全一样。只有构造一个**本该被拒**的包才
  // 能区分这两者。
  const wfOp = (nodes: unknown[]) => ({
    opId: 'op-1',
    kind: 'workflow-create' as const,
    slug: 'wf-root',
    payload: {
      name: 'root',
      description: '',
      definition: { $schema_version: 4, inputs: [], edges: [], nodes },
    },
  })

  test('call 目标指向包内不存在的子工作流 ⇒ bundle-dangling-local-ref', () => {
    const codes = collectBundleRefIssues({
      ops: [wfOp([{ id: 'n1', type: 'call', workflowRef: 'local:no-such-wf' }])] as never,
    }).map((i) => i.code)
    expect(codes).toContain('bundle-dangling-local-ref')
  })

  test('call 目标指向包内不存在的工作组 ⇒ 同样拒绝', () => {
    const codes = collectBundleRefIssues({
      ops: [wfOp([{ id: 'n1', type: 'call', workgroupRef: 'local:no-such-wg' }])] as never,
    }).map((i) => i.code)
    expect(codes).toContain('bundle-dangling-local-ref')
  })

  test('正常场景不误伤：目标由包内 create op 声明 ⇒ 无 issue', () => {
    const codes = collectBundleRefIssues({
      ops: [
        wfOp([{ id: 'n1', type: 'call', workflowRef: 'local:wf-child' }]),
        {
          opId: 'op-2',
          kind: 'workflow-create',
          slug: 'wf-child',
          payload: {
            name: 'child',
            description: '',
            definition: { $schema_version: 4, inputs: [], edges: [], nodes: [] },
          },
        },
      ] as never,
    }).map((i) => i.code)
    expect(codes).not.toContain('bundle-dangling-local-ref')
  })

  test('call local 目标 slug 存在但类型错（workflowRef → workgroup）⇒ 早拒绝', () => {
    const bundle = {
      bundleVersion: 1,
      ops: [
        wfOp([{ id: 'n1', type: 'call', workflowRef: 'local:group' }]),
        {
          opId: 'op-2',
          kind: 'workgroup-create' as const,
          slug: 'group',
          payload: {
            name: 'group',
            description: '',
            instructions: '',
            mode: 'leader_worker' as const,
            switches: { shareOutputs: true, directMessages: true, blackboard: true },
            maxRounds: 10,
            completionGate: true,
            members: [],
            leaderDisplayName: null,
          },
        },
      ],
      rootRef: 'local:wf-root',
    }
    expect(collectBundleRefIssues(bundle as never).map((i) => i.code)).toContain(
      'bundle-local-ref-type-mismatch',
    )
    expect(BundleSchema.safeParse(bundle).success).toBe(false)
  })
})

describe('builtin: 形态的 rootRef', () => {
  // built-in 根不指向任何 op（built-in 不产 create op），也**自带类型**，所以既不算
  // 悬空、也不需要 rootType。少了这一支，导出的包自己的 parser 都解析不了。
  test('builtin 根：无 op、无 rootType ⇒ 无 issue', () => {
    expect(
      collectBundleRefIssues({ ops: [], rootRef: 'builtin:workflow/aw-skill-fusion' }),
    ).toEqual([])
  })

  test('external 根缺 rootType 仍要报错（builtin 分支不得顺手放过 external）', () => {
    const codes = collectBundleRefIssues({ ops: [], rootRef: 'external:agent/x' }).map(
      (i) => i.code,
    )
    expect(codes).toContain('bundle-root-type-missing')
  })

  test('BundleSchema 接受 builtin 根；不认识的前缀仍拒绝', () => {
    expect(
      BundleSchema.safeParse({
        bundleVersion: 1,
        ops: [],
        rootRef: 'builtin:workflow/aw-skill-fusion',
      }).success,
    ).toBe(true)
    expect(
      BundleSchema.safeParse({ bundleVersion: 1, ops: [], rootRef: 'builtin:skill/x' }).success,
    ).toBe(false)
    expect(BundleSchema.safeParse({ bundleVersion: 1, ops: [], rootRef: 'bogus:x' }).success).toBe(
      false,
    )
  })
})
