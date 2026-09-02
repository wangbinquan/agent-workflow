// RFC-271 T25 —— 解包：zip → manifest + bundle + 技能文件载体。
//
// 三件事：
//   ① 复用 `decodeZip` 做归一化与 zip-slip / 体积守卫（不另起一套）；
//   ② **防夹带**：包里出现任何未在 manifest / bundle 里登记的条目 ⇒ 拒绝。
//      不做这条，攻击者可以往包里塞一个 `../../.ssh/authorized_keys`——虽然
//      `decodeZip` 已经拦了路径穿越，但「登记之外的文件」本身就说明这个包不是
//      我们的格式产出的，与其逐个猜它想干嘛，不如整体拒绝；
//   ③ `formatVersion` 比当前**高**就拒绝——低版本的解析器读高版本的包，最好的
//      结果是丢字段，最坏的是把新语义误解成旧语义。

import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import {
  ResourcePackageTypeSchema,
  BundleSchema,
  collectBundleRefIssues,
  type ResourceBundle,
} from '@agent-workflow/shared'
import { decodeZip } from '@/modules/resource-catalog/infrastructure/legacy/skill-zip'
import { resourceTypeOfOp } from '@/services/bundle/provider'
import { ValidationError } from '@/util/errors'
import { PACKAGE_FORMAT_VERSION } from './export'
import { packagedSkillFileRef } from './skillTree'
import { collectBundleBuiltins, collectPackageRequirements } from './requirements'

/**
 * `manifest.builtins` 的条目数上限。框架内置件实际是个位数；这个值宽出两个数量级，
 * 只用来挡住「用一个小 zip 让服务端做任意多工作」这类放大。
 */
export const MAX_DECLARED_BUILTINS = 1000

const ManifestResourceSchema = z
  .object({
    slug: z.string().min(1),
    type: ResourcePackageTypeSchema,
    name: z.string().min(1),
  })
  .strict()

export const PackageSecretRefSchema = z
  .object({
    resourceType: ResourcePackageTypeSchema,
    resourceName: z.string().min(1),
    field: z.string().min(1),
  })
  .strict()

const PackageRequirementsSchema = z
  .object({
    runtimes: z.array(z.string()).optional().default([]),
    codeHosts: z.array(z.string()).optional().default([]),
    executables: z.array(z.string()).optional().default([]),
    pluginSources: z
      .array(z.object({ name: z.string(), spec: z.string(), sourceKind: z.string() }).strict())
      .optional()
      .default([]),
    projectSkills: z.array(z.string()).optional().default([]),
    // Additive diagnostics already emitted by the implementation.
    mcpKinds: z.array(z.string()).optional().default([]),
    humanMembers: z.array(z.string()).optional().default([]),
  })
  .strict()

export const PackageManifestSchema = z
  .object({
    formatVersion: z.number().int().positive(),
    exportedAt: z.number().int().nonnegative(),
    root: ManifestResourceSchema,
    resources: z.array(ManifestResourceSchema),
    requirements: PackageRequirementsSchema,
    secrets: z.array(PackageSecretRefSchema),
    danglingCallRefs: z.array(z.unknown()).optional().default([]),
    /**
     * 框架 built-in 依赖（`builtin:<type>/<name>` 指向的那些）。它们**不入
     * `resources`、不产 op**，导入时按名字绑到对端自己 seed 的那一个。
     *
     * `optional` 是为了**向后兼容**：这个字段之前的包没有它，那些包里也不会出现
     * `builtin:` 引用，所以缺省空数组是安全的。
     */
    builtins: z
      .array(
        z
          .object({ type: z.enum(['agent', 'workflow']), name: z.string().min(1).max(256) })
          .strict(),
      )
      // ⚠️ **数量上限**。这个数组由上传者决定，而它直接决定预检要做多少查询、在内存里
      // 留多大的中间结构。实测一个 7.8MiB 的合法包（远低于 64MiB 上传上限）声明 65536
      // 个 built-in：预检额外吃掉约 23MiB RSS，错误载荷 JSON 达 4.37M 字符。
      // 把 zip 体积当成唯一的资源上界是不够的——**压缩比让「合法包」和「服务端要做多少
      // 工作」彻底脱钩**。框架内置件实际只有个位数，1000 已经宽出两个数量级。
      .max(MAX_DECLARED_BUILTINS, {
        message: `a package may declare at most ${MAX_DECLARED_BUILTINS} framework built-ins`,
      })
      .optional()
      .default([]),
  })
  .strict()

export type PackageManifest = z.infer<typeof PackageManifestSchema>

export interface ParsedPackage {
  manifest: PackageManifest
  bundle: ResourceBundle
  /** 包内技能文件：`ref` → 字节。`readSkillFile` 从这里取。 */
  files: Map<string, Uint8Array>
  /** 整包字节的摘要，进 previewToken 的签名面。 */
  digest: string
}

const MANIFEST = 'manifest.yaml'
const BUNDLE = 'bundle.json'
const README = 'README.md'

export async function parseResourcePackage(zip: Uint8Array): Promise<ParsedPackage> {
  const entries = decodeZip(zip).filter((e) => !e.isDir)
  const byPath = new Map(entries.map((e) => [e.path, e]))

  const manifestEntry = byPath.get(MANIFEST)
  const bundleEntry = byPath.get(BUNDLE)
  if (manifestEntry === undefined || bundleEntry === undefined) {
    throw new ValidationError('package-invalid', `package must contain ${MANIFEST} and ${BUNDLE}`)
  }

  let rawManifest: unknown
  try {
    rawManifest = parseYaml(new TextDecoder().decode(manifestEntry.bytes()))
  } catch {
    // Upload syntax errors are caller input, not an internal server failure. Do not let the
    // parser-specific YAMLParseError escape to the HTTP boundary where it would become a 500.
    throw new ValidationError('package-invalid', 'manifest.yaml is not valid YAML')
  }
  if (typeof rawManifest !== 'object' || rawManifest === null) {
    throw new ValidationError('package-invalid', 'manifest.yaml is not a mapping')
  }
  const formatVersion = (rawManifest as { formatVersion?: unknown }).formatVersion
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion)) {
    throw new ValidationError('package-invalid', 'manifest.formatVersion is missing')
  }
  if (formatVersion > PACKAGE_FORMAT_VERSION) {
    throw new ValidationError(
      'package-format-unsupported',
      `package format version ${formatVersion} is newer than this instance supports (${PACKAGE_FORMAT_VERSION}); upgrade before importing`,
    )
  }
  const parsedManifest = PackageManifestSchema.safeParse(rawManifest)
  if (!parsedManifest.success) {
    throw new ValidationError('package-invalid', 'manifest.yaml has an invalid shape', {
      issues: parsedManifest.error.issues,
    })
  }
  const manifest = parsedManifest.data

  let bundle: ResourceBundle
  try {
    bundle = BundleSchema.parse(JSON.parse(new TextDecoder().decode(bundleEntry.bytes())))
  } catch (err) {
    throw new ValidationError(
      'package-invalid',
      `bundle.json is not a valid resource bundle: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const issues = collectBundleRefIssues(bundle)
  if (issues.length > 0) {
    throw new ValidationError('package-invalid', `bundle.json has reference issues`, {
      issues,
    })
  }

  assertManifestMatchesBundle(manifest, bundle)

  // ② 防夹带：登记面 = 三个固定条目 + bundle 里声明过的技能文件 ref。
  const declared = new Set<string>([MANIFEST, BUNDLE, README])
  const requiredSkillFiles = new Set<string>()
  for (const op of bundle.ops) {
    if (op.kind !== 'skill-create' && op.kind !== 'skill-update') continue
    for (const file of (op.payload as { files?: Array<{ ref?: unknown }> }).files ?? []) {
      if (typeof file.ref !== 'string') continue
      if (!('slug' in op)) {
        throw new ValidationError('package-invalid', 'package skill files require a create slug')
      }
      const path = (file as { path?: unknown }).path
      const expected =
        typeof path === 'string' ? packagedSkillFileRef(op.slug, path) : '<invalid-skill-path>'
      if (file.ref !== expected) {
        throw new ValidationError(
          'package-invalid',
          `skill file ref '${file.ref}' does not match its declared slug/path`,
        )
      }
      declared.add(file.ref)
      requiredSkillFiles.add(file.ref)
    }
  }
  const missingSkillFiles = [...requiredSkillFiles].filter((path) => !byPath.has(path))
  if (missingSkillFiles.length > 0) {
    throw new ValidationError(
      'package-invalid',
      `package is missing ${missingSkillFiles.length} declared skill file(s): ${missingSkillFiles.slice(0, 5).join(', ')}`,
    )
  }
  const unlisted = entries.map((e) => e.path).filter((p) => !declared.has(p))
  if (unlisted.length > 0) {
    throw new ValidationError(
      'package-unlisted-entry',
      `package contains ${unlisted.length} entr${unlisted.length === 1 ? 'y' : 'ies'} not declared by its manifest: ${unlisted.slice(0, 5).join(', ')}`,
    )
  }

  const files = new Map<string, Uint8Array>()
  for (const [path, entry] of byPath) {
    if (path === MANIFEST || path === BUNDLE || path === README) continue
    files.set(path, entry.bytes())
  }

  return { manifest, bundle, files, digest: await digestOf(zip) }
}

function assertManifestMatchesBundle(manifest: PackageManifest, bundle: ResourceBundle): void {
  const declared = manifest.resources
    .map((resource) => `${resource.type}\u0000${resource.slug}\u0000${resource.name}`)
    .sort()
  const actual = bundle.ops
    .flatMap((op) => {
      if (!('slug' in op)) return []
      const name = (op.payload as { name?: unknown }).name
      return typeof name === 'string'
        ? [`${resourceTypeOfOp(op)}\u0000${op.slug}\u0000${name}`]
        : []
    })
    .sort()
  if (JSON.stringify(declared) !== JSON.stringify(actual)) {
    throw new ValidationError(
      'package-invalid',
      'manifest.resources does not match the resources declared by bundle.json',
    )
  }

  // `manifest.builtins` 是导入预检展示的环境前提，bundle wire 才是机器实际消费的
  // 身份面。两者不逐项对照会出现两种危险假象：manifest 漏报前提，或夹带一个根本
  // 未被引用的“前提”。按槽位收集，避免把 bodyMd 等自由文本里的 `builtin:` 误判。
  const declaredBuiltins = manifest.builtins
    .map((builtin) => `${builtin.type}\u0000${builtin.name}`)
    .sort()
  const actualBuiltins = collectBundleBuiltins(bundle).map((b) => `${b.type}\u0000${b.name}`)
  if (JSON.stringify(declaredBuiltins) !== JSON.stringify(actualBuiltins)) {
    throw new ValidationError(
      'package-invalid',
      'manifest.builtins does not match builtin references declared by bundle.json',
    )
  }

  // requirements 是 UI 在 commit 前展示的环境前提，不能信任 manifest 自报。
  // 与导出侧共用 bundle collector，既挡“删掉真实前提”，也挡“塞入虚假前提”。
  if (
    JSON.stringify(manifest.requirements) !== JSON.stringify(collectPackageRequirements(bundle))
  ) {
    throw new ValidationError(
      'package-invalid',
      'manifest.requirements does not match prerequisites declared by bundle.json',
    )
  }

  if (bundle.rootRef === undefined) {
    throw new ValidationError('package-invalid', 'a config package must declare a rootRef')
  }
  // 框架 built-in 作为根：它**不产 create op、也不进 `manifest.resources`**（导入侧
  // 按名字绑对端自己那一个、`action: 'reuse'`），所以下面「root 必须出现在 resources
  // 里」的对照对它不适用。只核对 manifest.root 与 rootRef 声明的是同一个 (type, name)。
  if (bundle.rootRef.startsWith('builtin:')) {
    const spec = bundle.rootRef.slice('builtin:'.length)
    const slash = spec.indexOf('/')
    const type = slash < 0 ? '' : spec.slice(0, slash)
    const name = slash < 0 ? '' : spec.slice(slash + 1)
    if (manifest.root.type !== type || manifest.root.name !== name) {
      throw new ValidationError(
        'package-invalid',
        'manifest.root does not match the builtin rootRef in bundle.json',
      )
    }
    return
  }
  if (!bundle.rootRef.startsWith('local:')) {
    throw new ValidationError('package-invalid', 'a config package must declare a local rootRef')
  }
  const rootSlug = bundle.rootRef.slice('local:'.length)
  const root = manifest.resources.find((resource) => resource.slug === rootSlug)
  if (
    root === undefined ||
    root.slug !== manifest.root.slug ||
    root.type !== manifest.root.type ||
    root.name !== manifest.root.name
  ) {
    throw new ValidationError(
      'package-invalid',
      'manifest.root does not match bundle.json rootRef and resources',
    )
  }
}

async function digestOf(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
