// RFC-271 T21 —— 闭包序列化：slug 分配、引用 lifting、脱敏。
//
// 最要紧的一条：**脱敏之后必须仍能通过各自的严格 schema**（AC-6 / 设计门 D1）。
//
// 仓里已有的 `projectMcpForDump` 是给**模型看的展示投影**——它把 `oauth` 换成
// 字符串（而 `McpRemoteConfigSchema` 要求对象或 false）、把 argv 改成
// `‹redacted›-arg-N`、删掉整个 URL query。直接复用会同时造成三种后果：密钥泄漏面
// 错配、合法配置丢失、导入时 schema 解析失败。所以包走的是另一条：**只改值，不改
// 结构**。这组测试就是那条区别的锁。

//
// 覆盖验收条款：AC-4b（包内身份用 local:<slug>，与声明顺序无关）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）

import { describe, expect, test } from 'bun:test'
import {
  BundleOpSchema,
  McpRemoteConfigSchema,
  PACKAGE_SECRET_PLACEHOLDER,
} from '@agent-workflow/shared'
import type { ClosureResource, ExportClosure } from '../src/services/resourcePackage/closure'
import { assignSlugs, serializeClosure } from '../src/services/resourcePackage/serialize'

const res = (
  type: ClosureResource['type'],
  id: string,
  name: string,
  row: Record<string, unknown> = {},
): ClosureResource => ({ type, id, name, row: { id, name, ...row }, referencedBy: [] })

const closureOf = (
  resources: ClosureResource[],
  callRefs: ExportClosure['callRefs'] = [],
): ExportClosure => ({ root: resources[0]!, resources, callRefs })

describe('slug 分配', () => {
  test('从名字派生、带类型前缀；同名不同类型不冲突', () => {
    const slugs = assignSlugs([
      res('agent', 'A', 'Code Auditor'),
      res('skill', 'S', 'Code Auditor'),
    ])
    expect(slugs.get('A')).toBe('agent-code-auditor')
    expect(slugs.get('S')).toBe('skill-code-auditor')
  })

  test('同类型同名（理论上被同名门拦住）仍产出唯一 slug，不静默覆盖', () => {
    const slugs = assignSlugs([res('agent', 'A1', 'lint'), res('agent', 'A2', 'lint')])
    expect(slugs.get('A1')).not.toBe(slugs.get('A2'))
  })

  test('非 ASCII / 全符号名字也能得到合法 slug', () => {
    const slugs = assignSlugs([res('agent', 'A', '审计员'), res('agent', 'B', '***')])
    expect(slugs.get('A')).toMatch(/^agent-/)
    expect(slugs.get('B')).toMatch(/^agent-/)
  })
})

describe('引用 lifting', () => {
  test('同包内 → local:；不在包里 → external:', () => {
    const out = serializeClosure(
      closureOf([
        res('agent', 'A', 'auditor', {
          mcp: JSON.stringify(['M-in', 'M-out']),
          dependsOn: '[]',
          plugins: '[]',
          skills: '[]',
        }),
        res('mcp', 'M-in', 'tools', { type: 'remote', config: '{}' }),
      ]),
    )
    const agentOp = out.bundle.ops.find((o) => o.kind === 'agent-create')!
    const payload = agentOp.payload as { mcp: string[] }
    expect(payload.mcp[0]).toBe('local:mcp-tools')
    // 不在闭包里的引用退回 external —— 导入时由 provider 解析成本地行。
    expect(payload.mcp[1]).toBe('external:M-out')
  })

  test('project 技能 lift 成 `project:` 而不是 local/external', () => {
    const out = serializeClosure(
      closureOf([
        res('agent', 'A', 'auditor', {
          skills: JSON.stringify([{ kind: 'project', name: 'repo-helper' }]),
        }),
      ]),
    )
    const payload = out.bundle.ops[0]!.payload as { skills: string[] }
    expect(payload.skills).toEqual(['project:repo-helper'])
  })

  test('工作流节点：agentId → agentRef；call 目标在包里 ⇒ local:，不在 ⇒ name:', () => {
    const wf = res('workflow', 'W', 'audit', {
      definition: JSON.stringify({
        $schema_version: 4,
        inputs: [],
        edges: [],
        nodes: [
          { id: 'n1', kind: 'agent-single', agentId: 'A' },
          { id: 'c1', kind: 'call-workflow', workflowName: 'inner', workflowId: 'W2' },
          { id: 'c2', kind: 'call-workflow', workflowName: 'ghost' },
        ],
      }),
    })
    const out = serializeClosure(
      closureOf(
        [wf, res('agent', 'A', 'auditor'), res('workflow', 'W2', 'inner', { definition: '{}' })],
        [
          {
            fromType: 'workflow',
            fromId: 'W',
            nodeId: 'c1',
            targetType: 'workflow',
            name: 'inner',
            resolvedId: 'W2',
          },
          {
            fromType: 'workflow',
            fromId: 'W',
            nodeId: 'c2',
            targetType: 'workflow',
            name: 'ghost',
            resolvedId: null,
          },
        ],
      ),
    )
    const wfOp = out.bundle.ops.find((o) => 'slug' in o && o.slug === 'workflow-audit')!
    const nodes = (wfOp.payload as unknown as { definition: { nodes: Record<string, unknown>[] } })
      .definition.nodes
    expect(nodes[0]!.agentRef).toBe('local:agent-auditor')
    expect(nodes[0]!.agentId).toBeUndefined()
    expect(nodes[1]!.workflowRef).toBe('local:workflow-inner')
    // 解析不到的 call 目标退回 late-bound 名字域——导出方也可能根本看不见那一行。
    expect(nodes[2]!.workflowRef).toBe('name:workflow/ghost')
    expect(nodes[2]!.workflowName).toBeUndefined()
  })
})

describe('脱敏 —— **结构不变**，且产物仍过严格 schema', () => {
  test('MCP：env / headers 值被换掉、键保留；`oauth` **仍是对象**', () => {
    const config = {
      url: 'https://api.test/mcp',
      headers: { Authorization: 'Bearer real-token' },
      oauth: { clientId: 'cid', clientSecret: 'super-secret' },
    }
    const out = serializeClosure(
      closureOf([res('mcp', 'M', 'tools', { type: 'remote', config: JSON.stringify(config) })]),
    )
    const payload = out.bundle.ops[0]!.payload as { type: string; config: Record<string, unknown> }
    // 判别字段原样——脱敏枚举会让导入侧的判别联合直接崩。
    expect(payload.type).toBe('remote')
    const headers = payload.config.headers as Record<string, string>
    expect(Object.keys(headers)).toEqual(['Authorization'])
    expect(headers.Authorization).toBe(PACKAGE_SECRET_PLACEHOLDER)
    const oauth = payload.config.oauth as Record<string, unknown>
    expect(typeof oauth).toBe('object') // ← 展示投影在这里会给出一个**字符串**
    expect(oauth.clientId).toBe('cid') // 非密钥字段不动
    expect(oauth.clientSecret).toBe(PACKAGE_SECRET_PLACEHOLDER)

    // 硬性回归：脱敏**之后**仍能通过它自己的严格 schema。
    expect(McpRemoteConfigSchema.safeParse(payload.config).success).toBe(true)
  })

  test('脚本节点的 env 被脱敏，其余节点字段不动', () => {
    const out = serializeClosure(
      closureOf([
        res('workflow', 'W', 'w', {
          definition: JSON.stringify({
            $schema_version: 4,
            inputs: [],
            edges: [],
            nodes: [{ id: 's1', kind: 'script', language: 'bash', env: { TOKEN: 'ghp_real' } }],
          }),
        }),
      ]),
    )
    const nodes = (
      out.bundle.ops[0]!.payload as unknown as { definition: { nodes: Record<string, unknown>[] } }
    ).definition.nodes
    expect((nodes[0]!.env as Record<string, string>).TOKEN).toBe(PACKAGE_SECRET_PLACEHOLDER)
    expect(nodes[0]!.language).toBe('bash') // 枚举字段不动
  })

  test('secrets 索引只记**位置**，绝不记原值', () => {
    const out = serializeClosure(
      closureOf([
        res('mcp', 'M', 'tools', {
          type: 'remote',
          config: JSON.stringify({ url: 'https://x.test', env: { GITHUB_TOKEN: 'ghp_real' } }),
        }),
      ]),
    )
    expect(out.secrets.length).toBeGreaterThan(0)
    const serialized = JSON.stringify(out.secrets)
    expect(serialized).toContain('config.env.GITHUB_TOKEN')
    expect(serialized).not.toContain('ghp_real')
  })
})

describe('产出的 op 通过 BundleOp 的严格 schema', () => {
  test('六类各一条都能 parse', () => {
    const out = serializeClosure(
      closureOf([
        res('agent', 'A', 'auditor'),
        res('mcp', 'M', 'tools', {
          type: 'remote',
          config: JSON.stringify({ url: 'https://x.t' }),
        }),
        res('plugin', 'P', 'lint', { spec: 'left-pad@1.0.0', optionsJson: '{}' }),
        res('skill', 'S', 'helper'),
        res('workflow', 'W', 'wf', { definition: '{}' }),
        // ⚠️ fixture 必须用**真实的 DB 列**。这条注释原本就在这里，而 fixture 自己
        // 却用了 `switchesJson` —— `workgroups` 表上根本没有这一列（开关是各自独立
        // 的 boolean 列，成员在 `workgroup_members` 表）。于是这条「过严格 schema」
        // 的测试一直在验证一个**编出来的**形状，真实导出产的 payload 反而永远缺
        // switches/members —— 序列化器与真实 schema 脱节的根因就是这里。
        res('workgroup', 'G', 'squad', {
          mode: 'leader_worker',
          maxRounds: 3,
          shareOutputs: true,
          directMessages: false,
          blackboard: false,
          clarifyBudget: 3,
          fanOut: false,
          leaderMemberId: 'M1',
          members: [
            {
              id: 'M1',
              memberType: 'agent',
              agentId: 'A',
              displayName: 'auditor',
              roleDesc: '',
              sortOrder: 0,
            },
          ],
        }),
      ]),
      // 技能内容在文件系统里，导出段先读盘再交给序列化器（见 skillTree.ts）。
      new Map([['S', { frontmatterExtra: {}, bodyMd: '# helper', files: [] }]]),
    )
    for (const op of out.bundle.ops) {
      const parsed = BundleOpSchema.safeParse(op)
      expect(parsed.success ? true : JSON.stringify(parsed.error.issues)).toBe(true)
    }
    expect(out.bundle.rootRef).toBe('local:agent-auditor')
  })
})
