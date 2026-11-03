// RFC-401 T5 —— 技能 SKILL.md 的唯一字节合同（design §2.3、§10.2）。
//
// 此前有两份序列化器：普通编辑的 `stringifyFrontmatter`（YAML 默认 lineWidth 80，长 description 会被折行）与 Intent / 资源包的
// `renderResourcePackageSkillMarkdown`（lineWidth 0，frontmatter 后空一行、末尾补换行）。同一份内容经不同入口写出不同字节，于是
// 「内容不变」的判定跨入口不成立。现在统一为：
//
//   `---\n{YAML（name、description、其余 frontmatter 依次），lineWidth 0，去掉 YAML 末尾那一个换行}\n---\n{body}`
//
// lineWidth 0 不折行：opencode 以 gray-matter 解析技能（`packages/core/src/config/markdown.ts:3-10`；该处注释说明 Claude Code
// 容忍非法 YAML，单行标量更稳）。YAML 输出总以一个换行结尾，只去掉这一个，其余字节原样。
//
// `previous` 是当前版本的 SKILL.md：与新内容解析等价时原样返回旧字节，存量内容不因换序列化器产生新版本，内容不变的写入
// 因而不推进版本。

import { stringify as stringifyYaml } from 'yaml'

import { parseFrontmatter } from '@/util/frontmatter'

export interface SkillMarkdownDocument {
  readonly name: string
  readonly description: string
  readonly bodyMd: string
  readonly frontmatterExtra?: Readonly<Record<string, unknown>>
}

/** 键序无关的 JSON 形态（frontmatter 只含 YAML 标量、数组与映射）。 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : inner,
  )
}

/** 各序列化器写出的 body 只差首部空行与尾部空白；判等时忽略这两处。 */
function comparableBody(body: string): string {
  return body.replace(/^(?:\r?\n)+/, '').trimEnd()
}

/** 已渲染好的新 SKILL.md 与当前版本解析等价时返回旧字节（内容 owner 在当前版本树上叠加新内容时用）。 */
export function preserveSkillMarkdownBytes(
  previous: string | null | undefined,
  next: string,
): string {
  if (previous === undefined || previous === null) return next
  const a = parseFrontmatter(previous.replace(/^\uFEFF/, ''))
  const b = parseFrontmatter(next.replace(/^\uFEFF/, ''))
  return canonicalJson(a.data) === canonicalJson(b.data) &&
    comparableBody(a.body) === comparableBody(b.body)
    ? previous
    : next
}

/** 每个字段只读一次，次序是 name、description、frontmatterExtra（及其各键）、bodyMd。 */
export function renderSkillMarkdown(doc: SkillMarkdownDocument, previous?: string | null): string {
  const data = { name: doc.name, description: doc.description, ...doc.frontmatterExtra }
  const body = doc.bodyMd
  const yaml = stringifyYaml(data, { lineWidth: 0 }).replace(/\n$/, '')
  return preserveSkillMarkdownBytes(previous, `---\n${yaml}\n---\n${body}`)
}
