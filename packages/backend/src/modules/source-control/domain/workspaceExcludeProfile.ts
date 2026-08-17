// RFC-308 — pure platform exclude-profile rendering.

import { createHash } from 'node:crypto'
import { PLATFORM_WORKSPACE_DIR } from '@agent-workflow/shared'

export interface WorkspaceExcludeProfilePlan {
  version: 1
  directChildMounts: readonly string[]
  inherited: string
  content: string
  digest: string
}

export function gitignoreDirectoryRule(repoRelativeDir: string): string {
  const normalized = repoRelativeDir.replace(/^\/+|\/+$/g, '')
  if (normalized === '') throw new Error('workspace exclude directory must not be empty')
  const escaped = normalized.replace(/[*?[\]\\]/g, (char) => `\\${char}`)
  return `/${escaped}/`
}

export function planWorkspaceExcludeProfile(input: {
  directChildMounts?: readonly string[]
  inherited?: string
}): WorkspaceExcludeProfilePlan {
  const inherited = input.inherited ?? ''
  const mounts = [...new Set(input.directChildMounts ?? [])].sort()
  const rules = [
    gitignoreDirectoryRule(PLATFORM_WORKSPACE_DIR),
    ...mounts.map(gitignoreDirectoryRule),
  ]
  const inheritedBlock = inherited === '' ? '' : `${inherited.replace(/\n*$/, '\n')}\n`
  const body = [
    '# agent-workflow platform excludes v1',
    '# managed outside the business repository; do not edit',
    ...rules,
    '',
  ].join('\n')
  const content = `${inheritedBlock}${body}`
  return {
    version: 1,
    directChildMounts: mounts,
    inherited,
    content,
    digest: createHash('sha256').update(content).digest('hex'),
  }
}
