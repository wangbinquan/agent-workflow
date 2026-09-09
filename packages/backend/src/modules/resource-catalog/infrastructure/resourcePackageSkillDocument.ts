import type { BundleSkillPayload } from '@agent-workflow/shared'
import { stringify as stringifyYaml } from 'yaml'

/** The original resource-package SKILL.md bytes, shared by both artifact writers. */
export function renderResourcePackageSkillMarkdown(
  payload: Pick<BundleSkillPayload, 'name' | 'description' | 'frontmatterExtra' | 'bodyMd'>,
): string {
  return `---\n${stringifyYaml(
    { name: payload.name, description: payload.description, ...payload.frontmatterExtra },
    { lineWidth: 0 },
  )}---\n\n${payload.bodyMd}\n`
}
