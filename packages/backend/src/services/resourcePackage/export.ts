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
import { assertPrivilegedNodesExportable, walkExportClosure, type ExportClosure } from './closure'
import { serializeClosure, type SerializedPackage } from './serialize'

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
function collectRequirements(closure: ExportClosure): Record<string, unknown> {
  const runtimes = new Set<string>()
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
    if (r.type === 'plugin') {
      pluginSources.push({
        name: r.name,
        spec: String(r.row.spec ?? ''),
        sourceKind: String(r.row.sourceKind ?? 'npm'),
      })
    }
    if (r.type === 'mcp') mcpKinds.add(String(r.row.type ?? 'remote'))
    if (r.type === 'workgroup') {
      try {
        for (const raw of JSON.parse(String(r.row.membersJson ?? '[]')) as unknown[]) {
          const m = raw as { memberType?: string; username?: string }
          // human 成员带 **username**：跨实例标识。导入方要么本地有同名用户，要么
          // 在导入时改绑——所以它是 requirement，不是包内容。
          if (m.memberType === 'human' && typeof m.username === 'string') {
            humanMembers.add(m.username)
          }
        }
      } catch {
        /* 同上 */
      }
    }
  }

  return {
    runtimes: [...runtimes].sort(),
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
    resources: closure.resources.map(bySlug),
    requirements: collectRequirements(closure),
    /** 被脱敏的字段清单：**只有位置，没有值**。导入方据此知道要补哪些凭据。 */
    secrets: serialized.secrets,
    /** 解析不到的 call 目标（late-bound）。导入后它们仍按名字在启动期解析。 */
    danglingCallRefs: closure.callRefs
      .filter((c) => c.resolvedId === null)
      .map((c) => ({ from: c.fromId, nodeId: c.nodeId, type: c.targetType, name: c.name })),
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
  opts: { exportedAt?: number } = {},
): Promise<ExportedPackage> {
  const closure = await walkExportClosure(db, actor, root)
  assertPrivilegedNodesExportable(actor, closure.resources)
  const serialized = serializeClosure(closure)
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
  return {
    zip: encodeZip(files),
    filename: `${closure.root.type}-${closure.root.name}.awpkg.zip`.replace(/[^\w.@-]+/g, '-'),
    manifest,
  }
}
