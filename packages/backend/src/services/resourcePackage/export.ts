// RFC-271 T23 —— 导出入口：闭包 → 序列化 → manifest / README → zip。
//
// 包的目录结构（AC-1：内部结构要清晰明确）：
//
//   manifest.yaml            包元信息、requirements、被脱敏字段索引
//   README.md                中英双段，人读的那一份
//   bundle.json              `ResourceBundle`（导入侧真正消费的东西）
//   skills/<slug>/files/…    技能文件树（二进制原样）
//
// manifest 与 README 是**给人看的**，`bundle.json` 才是机器契约——两者分开，避免
// 「为了让人读懂而改了机器格式」或反过来。

import { stringify as stringifyYaml } from 'yaml'
import type { AclResourceType } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { encodeZip, type ZipFile } from '@/util/zip'
import { ConflictError, ValidationError } from '@/util/errors'
import { assertPrivilegedNodesExportable, walkExportClosure, type ExportClosure } from './closure'
import { expectTokenOf } from './preview'
import { serializeClosure, type SerializedPackage } from './serialize'
import { packagedSkillFileRef, readSkillTree, type SkillTree } from './skillTree'

/** 包格式版本。导入侧见到更高的值直接拒绝（design §8）。 */
export const PACKAGE_FORMAT_VERSION = 1

export interface ExportedPackage {
  zip: Uint8Array
  /** 建议的文件名（不含目录）。 */
  filename: string
  manifest: Record<string, unknown>
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/**
 * requirements：**导入方需要自备**的东西。它们不是包的内容，而是包的前提——
 * 分开列出来，导入方在预检就能看到「我这台机器缺什么」，而不是等到运行时才炸。
 */
function collectRequirements(
  closure: ExportClosure,
  serialized: SerializedPackage,
): Record<string, unknown> {
  // plugin spec 可以内嵌凭据。**取已脱敏的那一份**（AC-10：requirements 同样不含
  // 任何密钥），而不是重新读 `row.spec` —— 重读等于给密钥开第二条出口，且两处的
  // 脱敏规则会随时间漂移。
  const redactedSpecOfSlug = new Map<string, string>()
  for (const op of serialized.bundle.ops) {
    if (op.kind !== 'plugin-create') continue
    const { slug, payload } = op as unknown as { slug: string; payload: { spec?: unknown } }
    redactedSpecOfSlug.set(slug, String(payload.spec ?? ''))
  }

  const runtimes = new Set<string>()
  const codeHosts = new Set<string>()
  const executables = new Set<string>()
  const pluginSources: Array<{ name: string; spec: string; sourceKind: string }> = []
  const projectSkills = new Set<string>()
  const mcpKinds = new Set<string>()
  const humanMembers = new Set<string>()

  for (const r of closure.resources) {
    if (r.type === 'agent') {
      const runtime = r.row.runtime
      if (typeof runtime === 'string' && runtime.length > 0) runtimes.add(runtime)
      try {
        for (const raw of JSON.parse(String(r.row.skills ?? '[]')) as unknown[]) {
          const s = raw as { kind?: string; name?: string }
          if (s.kind === 'project' && typeof s.name === 'string') projectSkills.add(s.name)
        }
      } catch {
        /* 坏行由闭包段的 schema 校验负责 */
      }
    }
    if (r.type === 'workflow') {
      try {
        const definition = JSON.parse(String(r.row.definition ?? '{}')) as { nodes?: unknown }
        for (const raw of Array.isArray(definition.nodes) ? definition.nodes : []) {
          const node = raw as { kind?: unknown; provider?: unknown }
          if (
            node.kind === 'code-host-call' &&
            typeof node.provider === 'string' &&
            node.provider.length > 0
          ) {
            codeHosts.add(node.provider)
          }
        }
      } catch {
        /* malformed rows are rejected by the closure/schema validation path */
      }
    }
    if (r.type === 'plugin') {
      pluginSources.push({
        name: r.name,
        spec: redactedSpecOfSlug.get(serialized.slugOfId.get(r.id) ?? '') ?? '',
        sourceKind: String(r.row.sourceKind ?? 'npm'),
      })
    }
    if (r.type === 'mcp') {
      mcpKinds.add(String(r.row.type ?? 'remote'))
      try {
        const config = JSON.parse(String(r.row.config ?? '{}')) as { command?: unknown }
        const executable = Array.isArray(config.command) ? config.command[0] : undefined
        if (typeof executable === 'string' && executable.length > 0) executables.add(executable)
      } catch {
        /* malformed rows are rejected by the closure/schema validation path */
      }
    }
    if (r.type === 'workgroup') {
      // `row.members` 由闭包装载层补上（成员是独立表）。human 成员带 **username**：
      // 跨实例标识。导入方要么本地有同名用户、要么在导入时逐个选映射——所以它是
      // requirement，不是包内容。
      for (const raw of Array.isArray(r.row.members) ? r.row.members : []) {
        const m = raw as { memberType?: string; username?: string | null }
        if (m.memberType === 'human' && typeof m.username === 'string' && m.username.length > 0) {
          humanMembers.add(m.username)
        }
      }
    }
  }

  return {
    runtimes: [...runtimes].sort(),
    codeHosts: [...codeHosts].sort(),
    executables: [...executables].sort(),
    pluginSources: pluginSources.sort((a, b) => a.name.localeCompare(b.name)),
    projectSkills: [...projectSkills].sort(),
    mcpKinds: [...mcpKinds].sort(),
    humanMembers: [...humanMembers].sort(),
  }
}

export function buildManifest(
  closure: ExportClosure,
  serialized: SerializedPackage,
  meta: { exportedAt: number },
): Record<string, unknown> {
  const bySlug = (r: (typeof closure.resources)[number]) => ({
    slug: serialized.slugOfId.get(r.id),
    type: r.type,
    name: r.name,
  })
  return {
    formatVersion: PACKAGE_FORMAT_VERSION,
    exportedAt: meta.exportedAt,
    root: bySlug(closure.root),
    // ⚠️ 清单里**没有** owner / visibility / grant —— 决策 4/12：包不带任何权属
    // 信息，导入后一切归导入者。带上它们只会诱导导入侧去「还原」一个在本实例上
    // 根本不存在的主体。
    // built-in **不入 resources**：它不产 op、导入侧自动忽略。列在下面的
    // `builtins` 里，让导入方一眼看到「这个包依赖对端也有这几个框架内置」。
    resources: closure.resources.filter((r) => r.builtin !== true).map(bySlug),
    /** 框架内置依赖：导入时按**名字**绑到对端自己 seed 的那一个，不会被复制。 */
    builtins: closure.resources
      .filter((r) => r.builtin === true)
      .map((r) => ({ type: r.type, name: r.name }))
      .sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type.localeCompare(b.type),
      ),
    requirements: collectRequirements(closure, serialized),
    /** 被脱敏的字段清单：**只有位置，没有值**。导入方据此知道要补哪些凭据。 */
    secrets: serialized.secrets,
    /** 解析不到的 call 目标（late-bound）。导入后它们仍按名字在启动期解析。 */
    danglingCallRefs: closure.callRefs
      .filter((c) => c.resolvedId === null)
      // ⚠️ `from` 写**包内 slug**，不是源库 id。写 `c.fromId` 会让源实例的 ULID
      // 泄漏进 manifest —— 包必须与源系统 id 无关（那是它能跨实例搬运的前提），
      // 而这个字段只是给人看「哪个资源引用了这个解析不到的 call 目标」，slug 足够
      // 且在对端仍然有意义。
      .map((c) => ({
        from: serialized.slugOfId.get(c.fromId) ?? c.fromId,
        nodeId: c.nodeId,
        type: c.targetType,
        name: c.name,
      })),
  }
}

export function buildReadme(manifest: Record<string, unknown>): string {
  const root = manifest.root as { type: string; name: string }
  const resources = manifest.resources as Array<{ type: string; name: string }>
  const requirements = manifest.requirements as Record<string, unknown[]>
  const secrets = manifest.secrets as unknown[]
  const counts = new Map<string, number>()
  for (const r of resources) counts.set(r.type, (counts.get(r.type) ?? 0) + 1)
  const countLine = [...counts.entries()]
    .sort()
    .map(([type, n]) => `${type} × ${n}`)
    .join(', ')

  const req = (key: string): string => {
    const list = requirements[key] ?? []
    return list.length === 0
      ? '—'
      : list.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ')
  }

  return `# ${root.name}

Agent Workflow 配置包 / Agent Workflow config package

## 这是什么 / What this is

以 **${root.type} \`${root.name}\`** 为根，递归导出的完整配置闭包：${countLine}。
Everything the root needs, exported transitively.

## 导入前需要自备 / Prerequisites

| 项 / Item | 值 / Value |
|---|---|
| 执行档 / runtimes | ${req('runtimes')} |
| 代码平台 / code hosts | ${req('codeHosts')} |
| 本地可执行文件 / executables | ${req('executables')} |
| 插件来源 / plugin sources | ${req('pluginSources')} |
| 仓库自带技能 / project skills | ${req('projectSkills')} |
| MCP 形态 / MCP kinds | ${req('mcpKinds')} |
| 人类成员 / human members | ${req('humanMembers')} |

## 凭据 / Credentials

包内共 **${secrets.length}** 处凭据字段已被替换成占位符；**原值不在包里**。
导入后需要在对应资源上重新填写。清单见 \`manifest.yaml\` 的 \`secrets\`（只有位置，没有值）。

${secrets.length} credential field(s) were redacted. The values are NOT in this package —
re-enter them after importing. See \`manifest.yaml\` → \`secrets\` for the exact locations.

## 权属 / Ownership

包**不携带任何权属信息**。导入之后，所有资源归**导入者**所有，可见性为私有。
A package carries no ownership. After import, every resource belongs to the importer.

## 目录结构 / Layout

\`\`\`
manifest.yaml   包元信息 / package metadata
README.md       本文件 / this file
bundle.json     机器读的资源定义 / machine-readable resource definitions
skills/         技能文件树 / skill file trees
\`\`\`
`
}

export async function exportResourcePackage(
  db: DbClient,
  actor: Actor,
  root: { type: AclResourceType; id: string },
  opts: { appHome: string; exportedAt?: number; expect?: RootExportFence },
): Promise<ExportedPackage> {
  const closure = await walkExportClosure(db, actor, root)
  assertRootUnchanged(closure, opts.expect)
  assertPrivilegedNodesExportable(actor, closure.resources)

  // 技能内容在文件系统里，不在行上——**先读盘**再序列化。序列化段保持无 IO，
  // 这样它仍然是可单测的纯转换。
  const skillTrees = new Map<string, SkillTree>()
  for (const r of closure.resources) {
    if (r.type !== 'skill') continue
    skillTrees.set(r.id, await readSkillTree(db, opts.appHome, r.id))
  }

  const serialized = serializeClosure(closure, skillTrees)
  const manifest = buildManifest(closure, serialized, {
    // 调用方给时间戳（路由传 `Date.now()`）。留成参数是为了让测试能断言
    // 「同一份闭包导出两次字节相同」——见 `encodeZip` 的可复现要求。
    exportedAt: opts.exportedAt ?? 0,
  })
  const files: ZipFile[] = [
    { path: 'manifest.yaml', bytes: utf8(stringifyYaml(manifest, { lineWidth: 0 })) },
    { path: 'README.md', bytes: utf8(buildReadme(manifest)) },
    { path: 'bundle.json', bytes: utf8(`${JSON.stringify(serialized.bundle, null, 2)}\n`) },
  ]
  for (const r of closure.resources) {
    const tree = skillTrees.get(r.id)
    if (tree === undefined) continue
    const slug = serialized.slugOfId.get(r.id)!
    for (const f of tree.files) {
      files.push({ path: packagedSkillFileRef(slug, f.path), bytes: f.bytes })
    }
  }
  return {
    zip: encodeZip(files),
    filename: `${closure.root.type}-${closure.root.name}.awpkg.zip`.replace(/[^\w.@-]+/g, '-'),
    manifest,
  }
}

/**
 * 只对 **root** 生效的 exact-revision fence（旧 YAML 导出的那条保障）。
 *
 * 字段是**六类各自的完整形态**（AC-12），复用 `expectTokenOf` 那一份定义 —— 不能
 * 只给 `expectedVersion`：那只覆盖 workflow / workgroup，另一标签把 agent 的
 * `network` 从 deny 改成 allow 后，原标签点导出会**静默导出新版本**而不是 409。
 *
 * · workflow / workgroup → `expectedVersion`
 * · agent                → `expectedUpdatedAt` + `expectedAclRevision`
 * · skill                → `expectedContentVersion` + `expectedMetaRevision` + `expectedAclRevision`
 * · mcp / plugin         → `expectedConfigHash`
 */
export type RootExportFence = Record<string, unknown>

/**
 * 「所见非所得」防护：用户在界面上看着 v1 按了导出，另一个写者已经把它推到 v2。
 *
 * ⚠️ **只 fence root**，闭包成员**取最新**——这与任务执行同语义：执行期非 root 的
 * 依赖同样取最新。给闭包成员也 fence 会要求客户端先知道整个闭包才能给出期望值，
 * 而闭包正是导出这一步才算出来的。
 */
function assertRootUnchanged(closure: ExportClosure, expect: RootExportFence | undefined): void {
  if (expect === undefined || Object.keys(expect).length === 0) return
  const type = closure.root.type
  const actual = expectTokenOf(type, closure.root.row)

  // ⚠️ **给了就必须给全**：该类型要求的每个字段都要出现。少给一个就等于放过那一维
  // 的漂移（技能只改 description 会推进 metaRevision 而 contentVersion 不变——只带
  // 后者的 fence 完全看不见这次修改），而调用方会以为自己有保护。
  const required = Object.keys(actual)
  const missing = required.filter((k) => expect[k] === undefined)
  if (missing.length > 0) {
    throw new ValidationError(
      'package-invalid',
      `exact-revision fence for a ${type} needs all of: ${required.join(', ')} (missing ${missing.join(', ')})`,
    )
  }
  const unknown = Object.keys(expect).filter((k) => !required.includes(k))
  if (unknown.length > 0) {
    // 传了该类型不认识的字段，最可能是调用方拿错了类型的 fence —— 静默忽略会让
    // 「我明明传了 expectedConfigHash」变成一次没有保护的导出。
    throw new ValidationError(
      'package-invalid',
      `exact-revision fence for a ${type} does not accept: ${unknown.join(', ')}`,
    )
  }

  for (const key of required) {
    if (String(expect[key]) === String(actual[key])) continue
    throw new ConflictError(
      'package-root-changed',
      `this ${type} changed since you loaded it (${key}: expected ${String(expect[key])}, now ${String(actual[key])})`,
    )
  }
}
