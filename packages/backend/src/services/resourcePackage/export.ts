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
import type { BundleResourceType } from '@agent-workflow/shared'
import { eq, inArray } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { ACL_TABLES, isVisibleRow, listGrantedResourceIds } from '@/services/resourceAcl'
import { encodeZip, type ZipFile } from '@/util/zip'
import { ConflictError, ValidationError } from '@/util/errors'
import {
  assertPrivilegedNodesExportable,
  attachWorkgroupMembers,
  isBuiltinRow,
  rowName,
  walkExportClosure,
  type ClosureResource,
  type ExportClosure,
} from './closure'
import { expectTokenOf } from './preview'
import { serializeClosure, type SerializedPackage } from './serialize'
import { packagedSkillFileRef, readSkillTree, type SkillTree } from './skillTree'
import { collectBundleBuiltins, collectPackageRequirements } from './requirements'

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
    /**
     * 框架内置依赖：导入时按**名字**绑到对端自己 seed 的那一个，不会被复制。
     *
     * ⚠️ 从 **bundle** 派生，不是从闭包——parser 也用同一个 collector 对账，两边必须
     * 同源。曾经这里按「闭包里所有 builtin 资源」列：built-in 自己当根时闭包有根 + 它的
     * built-in 依赖两项，而 bundle 里只有 `rootRef` 一项（根不产 op，依赖压根不出现），
     * 于是**导出的包被自己的 parser 判 `package-invalid`**（真实的 `aw-skill-fusion`）。
     *
     * 语义上也是 bundle 侧对：built-in 根的包只表达「绑你自己的那一个」，它内部还用了
     * 什么是对端自己的事，包无从担保、也不该替它声明前提。
     */
    builtins: collectBundleBuiltins(serialized.bundle),
    // 从真正会被导入方消费的、已脱敏 bundle 计算；parser 用同一 collector 复核。
    requirements: collectPackageRequirements(serialized.bundle),
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
  root: { type: BundleResourceType; id: string },
  opts: { appHome: string; exportedAt?: number; expect?: RootExportFence },
): Promise<ExportedPackage> {
  const closure = await walkExportClosure(db, actor, root)
  assertRootUnchanged(closure.root.type, closure.root.row, opts.expect)
  assertPrivilegedNodesExportable(actor, closure.resources)

  // 技能内容在文件系统里，不在行上——**先读盘**再序列化。序列化段保持无 IO，
  // 这样它仍然是可单测的纯转换。
  const skillTrees = new Map<string, SkillTree>()
  for (const r of closure.resources) {
    if (r.type !== 'skill') continue
    skillTrees.set(r.id, await readSkillTree(db, opts.appHome, r.id))
  }

  // ⚠️ **授权复核必须排在任何 root fence 明文比较之前**。
  //
  // 之前的顺序是 `assertRootStillCurrent`（客户端 fence）在前、闭包复核在后，于是 root
  // 的授权被绕到了 fence 之后：撤权之后再导出，若 root 同时被推到 v2，返回的是
  // `package-root-changed ... now 2` —— 一个此刻**已经对你不可见**的资源，却把它的精确
  // revision 报了出来。不泄露 ZIP，但在竞态窗口里成了状态 oracle。
  const serialized = serializeClosure(closure, skillTrees)
  await assertClosureStillCurrent(db, actor, closure, skillTrees, serialized, opts.appHome)
  // exact fence 必须包住所有 live 读取。旧实现只在 walkClosure 后比较一次，随后读取
  // 技能文件树/工作组 roster 的窗口里根仍可变化，最终却带着旧 expected 成功 200。
  await assertRootStillCurrent(db, actor, closure.root.type, closure.root.id, opts.expect)
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
 * 字段是**六类各自的完整形态**（AC-12），取自 `expectTokenOf`：
 *
 * · workflow / workgroup → `expectedVersion`
 * · agent                → `expectedUpdatedAt` + `expectedAclRevision`
 * · skill                → `expectedContentVersion` + `expectedMetaRevision` + `expectedAclRevision`
 * · mcp / plugin         → `expectedConfigHash`
 *
 * 两条不能省的理由：
 *  · 只给 `expectedVersion` 只覆盖 workflow / workgroup —— 另一标签修改 agent
 *    正文后，原标签点导出会**静默导出新版本**而不是 409；
 * * ⚠️ 想给 workflow / workgroup 补一维 `expectedAclRevision` 之前先看 `expectTokenOf`
 * 的注释：实测 ACL 漂移产出**逐字节相同**的包，加那一维只会打红六个前端入口。
 */
export type RootExportFence = Record<string, unknown>

/**
 * 「所见非所得」防护：用户在界面上看着 v1 按了导出，另一个写者已经把它推到 v2。
 *
 * ⚠️ 客户端提供的 expected revision **只 fence root**；闭包成员在遍历时取最新，
 * 再由 exporter 用自己捕获的 revision 做末端稳定性复核。这样既不要求客户端预先知道
 * 整棵闭包，也不会把两个时刻的依赖拼成一个包。
 */
function assertRootUnchanged(
  type: BundleResourceType,
  row: Record<string, unknown>,
  expect: RootExportFence | undefined,
): void {
  if (expect === undefined || Object.keys(expect).length === 0) return
  const actual = expectTokenOf(type, row)

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

/**
 * ⚠️ 这次查询**自己也要复查授权**，不能只靠前面那一轮。
 *
 * 第五轮我把闭包授权复核挪到了 root fence 之前，以为 oracle 就没了。第六轮实测**只是
 * 把窗口挪后了**：授权复核用的是它自己那次读，而这里是**第三次**读 root——在这两次之间
 * 撤权 + 推 v2，返回的仍是
 * `package-root-changed ... (expectedVersion: expected 1, now 2)`，把一个此刻已对你不可见
 * 的资源的精确 revision 报了出来。
 *
 * 「在 X 之前先检查一次」永远解决不了这类问题——只要 X 自己还要重新读一次库，它就必须
 * 自己带上授权判断。授权与读取要在**同一次**观测里成对出现。
 */
async function assertRootStillCurrent(
  db: DbClient,
  actor: Actor,
  type: BundleResourceType,
  id: string,
  expect: RootExportFence | undefined,
): Promise<void> {
  if (expect === undefined || Object.keys(expect).length === 0) return
  const table = ACL_TABLES[type]
  const row = (await db.select().from(table).where(eq(table.id, id)).get()) as
    | Record<string, unknown>
    | undefined
  if (row === undefined) {
    throw new ConflictError('package-root-changed', `this ${type} vanished during export`)
  }
  const grants = new Set(await listGrantedResourceIds(db, actor, type))
  if (!isVisibleRow(actor, row as never, grants)) {
    throw new ValidationError(
      'package-export-ref-unavailable',
      `cannot export ${type} '${id}': it is no longer available to you`,
    )
  }
  assertRootUnchanged(type, row, expect)
}

/**
 * 闭包成员在**所有 live 读取之后**的两道复核 —— 它们回答的是**两个不同的问题**，
 * 必须分开做（实现门第四轮的 P1-2 / P2-2 就是把它们混成一件事的代价）：
 *
 *  ① **产物还是那个产物吗**（逐 slug 比 `serializeClosure` 的产出）—— 防「agent@v1 的行 + 半路改过的
 *     MCP」这种拼接快照；
 *  ② **你现在还有权导出它吗**（`isVisibleRow`）—— 防**授权在导出中途被撤销**。
 *
 * 曾经只做①、且拿 `expectTokenOf`（引擎的 mutation CAS token）来做，两头都错：
 *
 *  · **漏检**：workflow / workgroup 的 CAS token 只有 `version`，而 ACL 写路径只推
 *    `aclRevision` / `updatedAt`。于是「reader 对 private 子工作流有 grant → 发起导出
 *    → 闭包捕获后 owner 撤销 grant」全程无感，导出照样 200，包里带走了**此刻已经
 *    不可见**的资源。实测复现：撤权后 `remainingGrants=0`、`aclRevision` 0→1、
 *    `version` 不动，导出仍返回 200-zip。
 *  · **误拒**：agent / skill 的 CAS token 里含 `aclRevision`，MCP / plugin 的 hash 更是
 *    覆盖 owner / visibility / 本机安装态。于是把一个 agent 从 private 改成 public
 *    ——**包字节一个都不变**——却会让在途导出报 `package-closure-changed`。
 *
 * 「ACL 不改变产物字节」这个实测结论是对的，但它只能推出①不该管 ACL，**推不出**
 * 「ACL 无关紧要」：产物等价 ≠ 授权仍然成立。
 */
/** 技能文件树的内容摘要——路径 + 字节，两者任一变化都要能看出来。 */
function skillTreeDigest(tree: SkillTree | undefined): string {
  if (tree === undefined) return ''
  return JSON.stringify(
    [...tree.files]
      .map((f) => [f.path, Buffer.from(f.bytes).toString('base64')])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  )
}

async function assertClosureStillCurrent(
  db: DbClient,
  actor: Actor,
  closure: ExportClosure,
  skillTrees: ReadonlyMap<string, SkillTree>,
  captured: SerializedPackage,
  appHome: string,
): Promise<void> {
  const byType = new Map<BundleResourceType, Array<(typeof closure.resources)[number]>>()
  for (const resource of closure.resources) {
    const list = byType.get(resource.type) ?? []
    list.push(resource)
    byType.set(resource.type, list)
  }

  const currentRowById = new Map<string, Record<string, unknown>>()
  for (const [type, group] of byType) {
    const table = ACL_TABLES[type]
    const rows = (await db
      .select()
      .from(table)
      .where(
        inArray(
          table.id,
          group.map((resource) => resource.id),
        ),
      )) as unknown as Array<Record<string, unknown>>
    // ⚠️ 必须走**与闭包遍历同一条装载路径**：工作组成员在独立表 `workgroup_members`，
    // 由 `attachWorkgroupMembers` 在装载层补进 `row.members`。裸 select 拿到的行没有
    // 这个字段，比较时会恒不相等。
    if (type === 'workgroup') await attachWorkgroupMembers(db, rows)
    const currentById = new Map(rows.map((row) => [String(row.id), row]))
    const grants = new Set(await listGrantedResourceIds(db, actor, type))

    for (const resource of group) {
      const current = currentById.get(resource.id)
      const isRoot = resource.type === closure.root.type && resource.id === closure.root.id
      const changeCode = isRoot ? 'package-root-changed' : 'package-closure-changed'
      if (current === undefined) {
        throw new ConflictError(
          changeCode,
          `${type} '${resource.id}' vanished during export; retry from a fresh snapshot`,
        )
      }
      // ② 授权复核**排在产物复核之前**：终态不可见时，连「它变没变」都不该回答。
      if (!isVisibleRow(actor, current as never, grants)) {
        throw new ValidationError(
          'package-export-ref-unavailable',
          `cannot export ${type} '${resource.id}': it is no longer available to you`,
        )
      }
      currentRowById.set(resource.id, current)
    }
  }

  // ① 产物复核：**拿序列化器自己的产出比**，不是比行。
  //
  // 曾经的判据是「整行减掉四个 ACL 列」。它连着错了两次，而且是同一个病因——**用「行」
  // 去近似「包」**：
  //   · 第一次：`updatedAt` 被 ACL 写路径推进，于是把 agent 改成 public（包字节一个都
  //     不变）会误报 `package-closure-changed`；靠再排除一列补救；
  //   · 第二次：插件的 `cachedPath` / `resolvedVersion` / `installedAt` 是**本机安装态**，
  //     序列化器根本不输出它们，而一次正常的 `reinstallPlugin` 恰好只动这三列 ⇒ 两次
  //     导出逐字节相同（实测 3110B 一致），却报 `package-closure-changed`。
  //
  // 排除清单在累积例外，这是选错轴的信号。改成拿**同一个 `serializeClosure`** 跑一遍
  // 新行，逐 slug 比它产出的 op：这是「什么进包」的唯一事实源，对将来新增的列自动免疫，
  // 既不会把不进包的字段算进来，也不会漏掉进包的字段。
  // ⚠️ **必须保持原顺序重建**，不能按类型分组后拼接。`serializeClosure` 的 `opId` 是按
  // 遍历顺序递增的（`op-1` / `op-2` …），而下面比较的是整个 op 的 JSON。分组会打乱顺序
  // ⇒ 同一批资源两次序列化得到不同的 opId ⇒ **零并发写的正常导出也确定性报 409**
  // （实测：root workflow 同时含 agent 节点与 call-workflow 节点即触发）。
  //
  // ⚠️ 而且要重建**整个 ClosureResource**，不只是 `row`：序列化器读的是顶层的
  // `r.name` / `r.builtin`（`{ ...resource, row: current }` 会把它们留在旧值上）。
  // 后果是导出中途改名不被发现，manifest 仍写旧名字；built-in 被取消标记也观察不到。
  const fresh: ClosureResource[] = closure.resources.map((resource) => {
    const row = currentRowById.get(resource.id) ?? resource.row
    return { ...resource, row, name: rowName(row), builtin: isBuiltinRow(row) }
  })
  // ⚠️ 技能树要**重读**，而且要单独比字节。
  //
  // 两个独立的漏洞叠在一起：①`skillTrees` 是导出早期读的，复核复用同一份 ⇒ 中途改文件
  // 根本看不见；②即使重读，技能辅助文件的 op 里只有 `path` / `ref`，**不含字节或摘要**
  // ⇒ 同一路径换内容，两个 op 逐字相同（实测把 `ref.bin` 从 [0x01] 换成 [0x02]，
  // `bundleEqual=true`）。
  // 所以 op 比较对技能内容天然失明，必须在它之外单独比一次树摘要。
  const freshTrees = new Map<string, SkillTree>()
  for (const r of fresh) {
    if (r.type !== 'skill') continue
    freshTrees.set(r.id, await readSkillTree(db, appHome, r.id))
  }
  for (const r of fresh) {
    if (r.type !== 'skill') continue
    if (skillTreeDigest(skillTrees.get(r.id)) === skillTreeDigest(freshTrees.get(r.id))) continue
    const isRoot = r.type === closure.root.type && r.id === closure.root.id
    throw new ConflictError(
      isRoot ? 'package-root-changed' : 'package-closure-changed',
      `skill '${r.id}' files changed during export; retry from a fresh snapshot`,
    )
  }

  const refreshed = serializeClosure({ ...closure, resources: fresh }, freshTrees)
  const opBySlug = (pkg: SerializedPackage): Map<string, string> => {
    const out = new Map<string, string>()
    for (const op of pkg.bundle.ops) {
      const slug = (op as { slug?: string }).slug
      if (slug !== undefined) out.set(slug, JSON.stringify(op))
    }
    return out
  }
  const before = opBySlug(captured)
  const after = opBySlug(refreshed)
  for (const resource of closure.resources) {
    // built-in 不产 op（按名字绑对端自己那一个），没有产物可比。
    const slug = captured.slugOfId.get(resource.id)
    if (slug === undefined) continue
    if (before.get(slug) === after.get(slug)) continue
    const isRoot = resource.type === closure.root.type && resource.id === closure.root.id
    throw new ConflictError(
      isRoot ? 'package-root-changed' : 'package-closure-changed',
      `${resource.type} '${resource.id}' changed during export; retry from a fresh snapshot`,
    )
  }
}
