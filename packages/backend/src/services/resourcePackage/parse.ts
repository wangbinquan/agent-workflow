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
import { BundleSchema, collectBundleRefIssues, type ResourceBundle } from '@agent-workflow/shared'
import { decodeZip } from '@/services/skill-zip'
import { ValidationError } from '@/util/errors'
import { PACKAGE_FORMAT_VERSION } from './export'

export interface ParsedPackage {
  manifest: Record<string, unknown>
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

  const manifest = parseYaml(new TextDecoder().decode(manifestEntry.bytes())) as Record<
    string,
    unknown
  >
  if (typeof manifest !== 'object' || manifest === null) {
    throw new ValidationError('package-invalid', 'manifest.yaml is not a mapping')
  }
  const formatVersion = manifest.formatVersion
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion)) {
    throw new ValidationError('package-invalid', 'manifest.formatVersion is missing')
  }
  if (formatVersion > PACKAGE_FORMAT_VERSION) {
    throw new ValidationError(
      'package-format-unsupported',
      `package format version ${formatVersion} is newer than this instance supports (${PACKAGE_FORMAT_VERSION}); upgrade before importing`,
    )
  }

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

  // ② 防夹带：登记面 = 三个固定条目 + bundle 里声明过的技能文件 ref。
  const declared = new Set<string>([MANIFEST, BUNDLE, README])
  for (const op of bundle.ops) {
    if (op.kind !== 'skill-create' && op.kind !== 'skill-update') continue
    for (const file of (op.payload as { files?: Array<{ ref?: unknown }> }).files ?? []) {
      if (typeof file.ref === 'string') declared.add(file.ref)
    }
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

async function digestOf(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
