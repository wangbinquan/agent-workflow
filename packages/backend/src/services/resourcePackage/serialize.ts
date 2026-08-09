// RFC-271 T21 —— 闭包 → `ResourceBundle`（分配 local slug）+ 脱敏 + secrets 索引。
//
// 两条硬约束：
//
// ① **脱敏之后必须仍能通过各自的严格 schema**（AC-6 / 设计门 D1）。仓里已有的
//    `projectMcpForDump` 是给**模型看的展示投影**：它把 `oauth` 换成字符串（而
//    schema 要求对象或 false）、把 argv 改成 `‹redacted›-arg-N`、删掉整个 URL
//    query。直接复用会同时造成密钥泄漏面错配、合法配置丢失、导入 schema 解析失败
//    三种后果。所以这里走 `shared/bundle/secrets.ts`——它只改**值**，不改结构。
//
// ② **枚举字段绝不脱敏**（RFC-270 教训）：把 `type: 'remote'` 换成占位符，导入
//    侧的判别联合直接崩，而且那本来就不是密钥。
//
// local slug 从资源名派生（小写 + 非法字符换 `-`），冲突时追加序号——slug 只是
// **包内**的引用键，不承载任何语义，所以派生规则怎么定都行，唯一要求是稳定且唯一。

import type { BundleOp, ResourceBundle } from '@agent-workflow/shared'
import {
  BUNDLE_VERSION,
  BundleSchema,
  PACKAGE_SECRET_PLACEHOLDER,
  redactArgv,
  redactFreeJson,
  redactPluginSpec,
  redactRecord,
  redactUrlKeepingShape,
  type PackageSecretRef,
  type RedactionSink,
} from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'
import type { ClosureResource, ExportClosure } from './closure'
import { packagedSkillFileRef, type SkillTree } from './skillTree'

export interface SerializedPackage {
  bundle: ResourceBundle
  /** manifest 用：哪些字段被脱敏了（**只记位置，绝不记原值**）。 */
  secrets: PackageSecretRef[]
  /** slug ↔ 源实例 id 的对照，供 manifest / README 展示。 */
  slugOfId: Map<string, string>
}

/** 名字 → slug。只在包内使用，冲突追加序号。 */
export function assignSlugs(resources: readonly ClosureResource[]): Map<string, string> {
  const used = new Set<string>()
  const out = new Map<string, string>()
  for (const r of resources) {
    const normalized =
      r.name
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || r.type
    const prefix = `${r.type}-`
    let n = 2
    let suffix = ''
    let slug = `${prefix}${normalized.slice(0, 64 - prefix.length)}`
    while (used.has(slug)) {
      suffix = `-${n++}`
      // The suffix is part of the 64-byte wire budget. Truncating once before collision
      // handling made a 56-character workflow name 65 chars, and every `-2` could push an
      // otherwise legal slug over the schema limit.
      slug = `${prefix}${normalized.slice(0, 64 - prefix.length - suffix.length)}${suffix}`
    }
    used.add(slug)
    out.set(r.id, slug)
  }
  return out
}

const parseJson = (value: unknown, fallback: unknown): unknown => {
  if (typeof value !== 'string') return value ?? fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

/** 引用 wire：同包内 → `local:<slug>`；不在包里 → `external:<id>`。 */
function refWire(
  slugOfId: ReadonlyMap<string, string>,
  id: string,
  builtinOfId: ReadonlyMap<string, { type: string; name: string }> = new Map(),
): string {
  // 框架 built-in：按**名字**指向对端自己 seed 的那一个。绝不能写成 `local:`
  // （那会让导入侧复制一份）也不能写成 `external:<源 id>`（源库的 id 在对端无意义）。
  const b = builtinOfId.get(id)
  if (b !== undefined) return `builtin:${b.type}/${b.name}`
  const slug = slugOfId.get(id)
  return slug === undefined ? `external:${id}` : `local:${slug}`
}

export function serializeClosure(
  closure: ExportClosure,
  /** 技能文件树（由导出段先读盘，keyed by skill id）。序列化本身保持无 IO。 */
  skillTrees: ReadonlyMap<string, SkillTree> = new Map(),
): SerializedPackage {
  const slugOfId = assignSlugs(closure.resources)
  // 框架 built-in：进包只为让引用可解释，**不产 create op**（导入侧自动忽略）。
  const builtinOfId = new Map<string, { type: string; name: string }>()
  for (const r of closure.resources) {
    if (r.builtin === true) builtinOfId.set(r.id, { type: r.type, name: r.name })
  }
  const secrets: PackageSecretRef[] = []
  // sink 按**资源**开一个（它带 resourceType / resourceName 上下文），产出汇总到
  // 同一个数组。⚠️ 只记**位置**，绝不记原值。
  const sinkFor = (r: ClosureResource): RedactionSink => ({
    resourceType: r.type,
    resourceName: r.name,
    found: secrets,
  })

  const ops: BundleOp[] = []
  let opSeq = 0
  const nextOpId = (): string => `op-${++opSeq}`

  for (const r of closure.resources) {
    // built-in **不产 op**：每个实例上框架自己会 seed 它，复制一份只会在对端多出
    // 一个 owner 错、`builtin=false` 的同名副本。引用方已改写成 `builtin:<type>/<name>`。
    if (r.builtin === true) continue
    const slug = slugOfId.get(r.id)!
    const row = r.row
    switch (r.type) {
      case 'agent': {
        const skills = (parseJson(row.skills, []) as unknown[]).map((raw) => {
          const s = raw as { kind?: string; skillId?: string; name?: string }
          return s.kind === 'project'
            ? `project:${s.name ?? ''}`
            : refWire(slugOfId, String(s.skillId ?? ''), builtinOfId)
        })
        ops.push({
          opId: nextOpId(),
          kind: 'agent-create',
          slug,
          payload: {
            name: r.name,
            description: String(row.description ?? ''),
            outputs: parseJson(row.outputs, []),
            // RFC-166 / RFC-111：两者都是真正影响运行行为的 canonical 字段。
            // payload schema 一直支持它们，但旧 serializer 没发出，跨实例后会分别
            // 回落成「无声明输入」与目标实例默认 runtime，形成静默语义漂移。
            inputs: parseJson(row.inputs, []),
            ...(typeof row.runtime === 'string' && row.runtime.length > 0
              ? { runtime: row.runtime }
              : {}),
            syncOutputsOnIterate: row.syncOutputsOnIterate !== false,
            permission: parseJson(row.permission, {}),
            // ⚠️ AC-B3b：`network` 必须带上。intent 版的 payload 没有这个字段，
            // 照抄会让导入后静默回落成 'deny'。
            ...(row.network === undefined || row.network === null ? {} : { network: row.network }),
            skills,
            dependsOn: (parseJson(row.dependsOn, []) as unknown[]).map((id) =>
              refWire(slugOfId, String(id), builtinOfId),
            ),
            mcp: (parseJson(row.mcp, []) as unknown[]).map((id) =>
              refWire(slugOfId, String(id), builtinOfId),
            ),
            plugins: (parseJson(row.plugins, []) as unknown[]).map((id) =>
              refWire(slugOfId, String(id), builtinOfId),
            ),
            frontmatterExtra: redactFreeJson(
              parseJson(row.frontmatterExtra, {}),
              sinkFor(r),
              'frontmatterExtra',
            ),
            bodyMd: String(row.bodyMd ?? ''),
          },
        } as unknown as BundleOp)
        break
      }
      case 'mcp': {
        const config = asRecord(parseJson(row.config, {}))
        ops.push({
          opId: nextOpId(),
          kind: 'mcp-create',
          slug,
          payload: {
            name: r.name,
            description: String(row.description ?? ''),
            // ⚠️ 判别字段原样——脱敏枚举会让导入侧的判别联合直接崩。
            type: row.type,
            config: redactMcpConfig(config, sinkFor(r), 'config'),
            enabled: row.enabled !== false,
          },
        } as unknown as BundleOp)
        break
      }
      case 'plugin': {
        ops.push({
          opId: nextOpId(),
          kind: 'plugin-create',
          slug,
          payload: {
            name: r.name,
            description: String(row.description ?? ''),
            // git spec 可以内嵌 `user:secret@` —— 与 `requirements.pluginSources`
            // 走同一条脱敏（AC-10：requirements 也不含任何密钥）。
            spec: redactPluginSpec(String(row.spec ?? ''), sinkFor(r)),
            options: redactFreeJson(parseJson(row.optionsJson, {}), sinkFor(r), 'options'),
            enabled: row.enabled !== false,
            // 决策 13：带 `sourceKind`（导入侧据它决定要不要跑安装），但**不带**
            // cachedPath / resolvedVersion / installedAt —— 那些是机器本地产物。
            sourceKind: row.sourceKind ?? 'npm',
          },
        } as unknown as BundleOp)
        break
      }
      case 'skill': {
        // 技能文件树在打包段单独写进 zip；payload 里带 SKILL.md 的结构化部分与
        // 文件清单（`ref` 指向包内路径，由 provider 的 readSkillFile 解成字节）。
        //
        // ⚠️ `skills` 表**没有** bodyMd / frontmatterExtra 列 —— 内容全在
        // `managedPath` 下的文件系统里。读行是读不出技能的，只会导出一个空壳。
        const tree = skillTrees.get(r.id)
        if (tree === undefined) {
          throw new ValidationError(
            'package-invalid',
            `skill '${r.name}' was not staged for export`,
          )
        }
        ops.push({
          opId: nextOpId(),
          kind: 'skill-create',
          slug,
          payload: {
            name: r.name,
            description: String(row.description ?? ''),
            frontmatterExtra: redactFreeJson(tree.frontmatterExtra, sinkFor(r), 'frontmatterExtra'),
            bodyMd: tree.bodyMd,
            files: tree.files.map((f) => ({
              path: f.path,
              ref: packagedSkillFileRef(slug, f.path),
            })),
          },
        } as unknown as BundleOp)
        break
      }
      case 'workflow': {
        ops.push({
          opId: nextOpId(),
          kind: 'workflow-create',
          slug,
          payload: {
            name: r.name,
            description: String(row.description ?? ''),
            definition: liftWorkflowDefinition(
              asRecord(parseJson(row.definition, {})),
              slugOfId,
              closure,
              r.id,
              sinkFor(r),
              builtinOfId,
            ),
          },
        } as unknown as BundleOp)
        break
      }
      case 'workgroup': {
        // ⚠️ 成员在**独立表**（装载层已补进 `row.members`），开关是**各自独立的列**
        // ——`workgroups` 上没有 membersJson / switchesJson / leaderDisplayName。
        const rawMembers = (parseJson(row.members, []) as unknown[]).map(asRecord)
        const members = rawMembers.map((m) => {
          const base = {
            displayName: String(m.displayName ?? ''),
            roleDesc: String(m.roleDesc ?? ''),
            sortOrder: Number(m.sortOrder ?? 0),
          }
          return m.memberType === 'agent'
            ? {
                memberType: 'agent' as const,
                agentRef: refWire(slugOfId, String(m.agentId ?? ''), builtinOfId),
                ...base,
              }
            : // human 成员带 **username**：本地 `user_id` 跨实例无意义，导入时由用户
              // 逐个选映射（`humanMemberMappings`）。
              { memberType: 'human' as const, username: String(m.username ?? ''), ...base }
        })
        // `leaderMemberId` 是本地行 id，不可移植；组内 displayName 唯一，是稳定键。
        const leader = rawMembers.find((m) => String(m.id) === String(row.leaderMemberId ?? ''))
        ops.push({
          opId: nextOpId(),
          kind: 'workgroup-create',
          slug,
          payload: {
            name: r.name,
            description: String(row.description ?? ''),
            instructions: String(row.instructions ?? ''),
            mode: row.mode,
            switches: {
              shareOutputs: row.shareOutputs !== false,
              directMessages: row.directMessages === true,
              blackboard: row.blackboard === true,
            },
            maxRounds: Number(row.maxRounds ?? 20),
            completionGate: row.completionGate === true,
            clarifyBudget: Number(row.clarifyBudget ?? 3),
            fanOut: row.fanOut === true,
            members,
            leaderDisplayName:
              leader === undefined ? null : String(leader.displayName ?? '') || null,
          },
        } as unknown as BundleOp)
        break
      }
    }
  }

  const rawBundle = {
    bundleVersion: BUNDLE_VERSION,
    ops,
    // ⚠️ built-in 根同样**不产 op**，写成 `local:` 会让 parser 在
    // 「local root 必须出现在 manifest.resources」上判 `bundle-dangling-root`
    // （built-in 恰好被排除出 resources）。用 `builtin:` 让它自描述。
    rootRef: builtinOfId.has(closure.root.id)
      ? `builtin:${closure.root.type}/${closure.root.name}`
      : `local:${slugOfId.get(closure.root.id)!}`,
  }

  // 导出端必须吃自己的机器契约。没有这道最终校验，坏的 legacy/corrupt 行会让 API
  // 返回一个“导出成功”的 zip，直到目标实例上传时才被同仓 parser 拒绝。
  const parsedBundle = BundleSchema.safeParse(rawBundle)
  if (!parsedBundle.success) {
    throw new ValidationError('package-invalid', 'serialized resource bundle is invalid', {
      issues: parsedBundle.error.issues,
    })
  }
  const bundle: ResourceBundle = parsedBundle.data

  return { bundle, secrets, slugOfId }
}

/** MCP config 的三个载体：env / headers / argv / url。结构一律保持。 */
function redactMcpConfig(
  config: Record<string, unknown>,
  sink: RedactionSink,
  fieldPrefix: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config }
  if (typeof out.env === 'object' && out.env !== null) {
    out.env = redactRecord(out.env as Record<string, string>, sink, `${fieldPrefix}.env`)
  }
  if (typeof out.headers === 'object' && out.headers !== null) {
    out.headers = redactRecord(
      out.headers as Record<string, string>,
      sink,
      `${fieldPrefix}.headers`,
    )
  }
  if (typeof out.oauth === 'object' && out.oauth !== null) {
    // ⚠️ `oauth` **仍然是对象**——展示投影把它换成字符串，那会让严格 schema 解析失败。
    const oauth = { ...(out.oauth as Record<string, unknown>) }
    if (typeof oauth.clientSecret === 'string') {
      oauth.clientSecret = PACKAGE_SECRET_PLACEHOLDER
      sink.found.push({
        resourceType: sink.resourceType,
        resourceName: sink.resourceName,
        field: `${fieldPrefix}.oauth.clientSecret`,
      })
    }
    out.oauth = oauth
  }
  // local MCP：argv 里内嵌的 token（`--token=…` 或裸高熵串）。**只换命中的那一个**，
  // argv 结构与长度不变——整段替换会摧毁真实命令。
  if (Array.isArray(out.command)) {
    out.command = redactArgv(out.command as string[], sink)
  }
  // remote MCP：userinfo 与 query 里的 token。产物仍是合法 http(s) URL，否则
  // `McpRemoteConfigSchema` 的 `startsWith('http')` 判据过不了。
  if (typeof out.url === 'string' && out.url.length > 0) {
    out.url = redactUrlKeepingShape(out.url, sink, `${fieldPrefix}.url`)
  }
  return out
}

/**
 * 工作流定义的 lifting：把节点上的 canonical id 换成 wire 引用。
 * call 目标走名字域（late-bound）；解析到包内目标时用 `local:`。
 */
function liftWorkflowDefinition(
  definition: Record<string, unknown>,
  slugOfId: ReadonlyMap<string, string>,
  closure: ExportClosure,
  fromId: string,
  sink: RedactionSink,
  builtinOfId: ReadonlyMap<string, { type: string; name: string }>,
): Record<string, unknown> {
  const nodes = Array.isArray(definition.nodes) ? definition.nodes : []
  const lifted = nodes.map((raw) => {
    const node = { ...asRecord(raw) }
    if (typeof node.agentId === 'string' && node.agentId.length > 0) {
      node.agentRef = refWire(slugOfId, node.agentId, builtinOfId)
      delete node.agentId
    }
    for (const [kind, nameField, idField, refField] of [
      ['workflow', 'workflowName', 'workflowId', 'workflowRef'],
      ['workgroup', 'workgroupName', 'workgroupId', 'workgroupRef'],
    ] as const) {
      const name = node[nameField]
      if (typeof name !== 'string' || name.length === 0) continue
      const resolved = closure.callRefs.find(
        (c) => c.fromId === fromId && c.nodeId === node.id && c.targetType === kind,
      )
      const targetSlug =
        resolved?.resolvedId === undefined || resolved.resolvedId === null
          ? undefined
          : slugOfId.get(resolved.resolvedId)
      // 目标在包里 ⇒ `local:`；否则退回 late-bound 的名字域（**导出方也可能根本
      // 看不见那一行**，这正是 `name:` 形态存在的理由）。
      //
      // built-in 目标必须保留 `builtin:` 身份。把它降成 late-bound `name:` 会让
      // 运行期的“最老可见同名”规则有机会绑到攻击者预先创建的普通同名资源。
      const resolvedBuiltin =
        resolved?.resolvedId !== undefined &&
        resolved.resolvedId !== null &&
        builtinOfId.get(resolved.resolvedId)
      node[refField] = resolvedBuiltin
        ? `builtin:${resolvedBuiltin.type}/${resolvedBuiltin.name}`
        : targetSlug === undefined
          ? `name:${kind}/${name}`
          : `local:${targetSlug}`
      delete node[nameField]
      delete node[idField]
    }
    // 脚本节点的 env 是凭据载体。
    if (node.kind === 'script' && typeof node.env === 'object' && node.env !== null) {
      node.env = redactRecord(
        node.env as Record<string, string>,
        sink,
        `nodes.${String(node.id)}.env`,
      )
    }
    return node
  })
  return { ...definition, nodes: lifted }
}
