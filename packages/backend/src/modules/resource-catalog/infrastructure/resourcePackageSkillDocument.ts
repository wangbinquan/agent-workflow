import type { BundleSkillPayload } from '@agent-workflow/shared'
import { stringify as stringifyYaml } from 'yaml'

/** The original SKILL.md bytes, shared by resource-package and intent artifact writers. */
export function renderResourcePackageSkillMarkdown(
  payload: Pick<BundleSkillPayload, 'name' | 'description' | 'bodyMd'> &
    Partial<Pick<BundleSkillPayload, 'frontmatterExtra'>>,
): string {
  return `---\n${stringifyYaml(
    { name: payload.name, description: payload.description, ...payload.frontmatterExtra },
    { lineWidth: 0 },
  )}---\n\n${payload.bodyMd}\n`
}
