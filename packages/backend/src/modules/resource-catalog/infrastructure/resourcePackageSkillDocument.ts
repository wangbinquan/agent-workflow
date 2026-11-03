import type { BundleSkillPayload } from '@agent-workflow/shared'
import { renderSkillMarkdown } from './skillMarkdown'

/**
 * Intent 与资源包的 SKILL.md 字节；RFC-401 T5 起与普通编辑共用 `renderSkillMarkdown`（design §2.3）。`previous` 是当前版本的
 * SKILL.md，解析等价时原样保留旧字节。载荷字段按 name、description、frontmatterExtra、bodyMd 各读一次。
 */
export function renderResourcePackageSkillMarkdown(
  payload: Pick<BundleSkillPayload, 'name' | 'description' | 'bodyMd'> &
    Partial<Pick<BundleSkillPayload, 'frontmatterExtra'>>,
  previous?: string | null,
): string {
  return renderSkillMarkdown(payload, previous)
}
