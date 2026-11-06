/**
 * Provider-neutral package skill payload. Persistence and filesystem lookup
 * are bound by Resource Catalog infrastructure before the legacy W6 export
 * algorithm receives its reader callback.
 */
export interface SkillTree {
  /** SKILL.md frontmatter excluding name/description, which live on the row. */
  frontmatterExtra: Record<string, unknown>
  bodyMd: string
  /** Every auxiliary file except SKILL.md, preserving binary bytes. */
  files: Array<{ path: string; bytes: Uint8Array }>
}

/** Package payload path; the ref and ZIP entry are intentionally identical. */
export function packagedSkillFileRef(slug: string, relPath: string): string {
  return `skills/${slug}/files/${relPath}`
}
