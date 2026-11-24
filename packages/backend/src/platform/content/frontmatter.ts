// Minimal YAML-frontmatter parser for SKILL.md / agent.md style docs.
// Roundtripping: parse → mutate → stringify preserves the body verbatim.

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

export interface FrontmatterDoc {
  data: Record<string, unknown>
  body: string
}

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/

export function parseFrontmatter(input: string): FrontmatterDoc {
  const m = input.match(FRONTMATTER_RE)
  if (!m) return { data: {}, body: input }
  const yaml = m[1] ?? ''
  const body = m[2] ?? ''
  let data: unknown
  try {
    data = parseYaml(yaml)
  } catch {
    return { data: {}, body: input }
  }
  if (data === null || data === undefined) return { data: {}, body }
  if (typeof data !== 'object' || Array.isArray(data)) return { data: {}, body }
  return { data: data as Record<string, unknown>, body }
}

export function stringifyFrontmatter(doc: FrontmatterDoc): string {
  const hasData = Object.keys(doc.data).length > 0
  if (!hasData) return doc.body
  const yaml = stringifyYaml(doc.data).trimEnd()
  return `---\n${yaml}\n---\n${doc.body}`
}
