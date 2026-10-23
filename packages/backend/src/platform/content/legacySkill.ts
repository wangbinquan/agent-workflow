import { isAbsolute, relative, resolve, sep } from 'node:path'
import { ValidationError } from '@/util/errors'
import { legacyContentRef, type ContentRef } from './contentRef'

export function skillRootRel(skillId: string): string {
  return `skills/${assertPathSegment(skillId, 'skill id')}`
}

export function skillFilesRel(skillId: string): string {
  return `${skillRootRel(skillId)}/files`
}

export function skillVersionRelPath(skillId: string, version: number): string {
  if (!Number.isInteger(version) || version < 1) {
    throw new ValidationError('skill-version-invalid', 'skill version must be a positive integer')
  }
  return `${skillRootRel(skillId)}/versions/v${version}/files`
}

export function rebaseSkillOperationPath(
  appHome: string,
  storedPath: string,
  expectedSkillKey: string,
): string {
  const key = assertPathSegment(expectedSkillKey, 'skill operation identity')
  const normalized = storedPath.replaceAll('\\', '/')
  let rel: string
  if (isAbsolute(storedPath)) {
    const marker = '/skills/'
    const at = normalized.lastIndexOf(marker)
    if (at < 0) {
      throw new ValidationError(
        'skill-operation-path-invalid',
        'skill operation path is not rooted under skills/',
      )
    }
    rel = normalized.slice(at + 1)
  } else {
    rel = normalized
  }
  const expectedPrefix = `skills/${key}`
  if (rel !== expectedPrefix && !rel.startsWith(`${expectedPrefix}/`)) {
    throw new ValidationError(
      'skill-operation-path-invalid',
      'skill operation path is not rooted under the operation skill identity',
    )
  }
  if (rel.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new ValidationError(
      'skill-operation-path-invalid',
      'skill operation path contains an unsafe segment',
    )
  }
  const root = resolve(appHome, 'skills')
  const target = resolve(appHome, ...rel.split('/'))
  const inside = relative(root, target)
  if (inside === '' || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside))) {
    return target
  }
  throw new ValidationError(
    'skill-operation-path-invalid',
    'skill operation path escapes the current skills root',
  )
}

export function assertPathSegment(value: string, label: string): string {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new ValidationError('skill-identity-invalid', `${label} is not a safe path segment`)
  }
  return value
}

/** Pure source decoder for both canonical and historical name-keyed locations. */
export function decodeLegacySkillPath(
  reference: string,
  storage: 'local-file' | 'database-bytes' = 'local-file',
): ContentRef<string> {
  return legacyContentRef('skill-path', storage, reference)
}
export function legacySkillStagingPath(skillId: string, publicationId: string): string {
  return `${skillRootRel(skillId)}/files.op-${publicationId}.staged`
}
export function decodeLegacySkillStagingPath(
  reference: string,
): { skillId: string; publicationId: string } | null {
  const match = /^skills\/([^/]+)\/files\.op-([0-9A-HJKMNP-TV-Z]{26})\.staged$/.exec(reference)
  return match === null ? null : { skillId: match[1]!, publicationId: match[2]! }
}
export function legacySkillTrashPath(skillId: string, operationId: string): string {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(operationId))
    throw new Error(`delete operation has invalid op_id: ${operationId}`)
  return `skills/.trash/${skillId}-${operationId}`
}
export const LIVE_TREE = 'live'
export const versionTree = (version: number): string => `version:${version}`
export const stagingTree = (id: string): string => `staging:${id}`
export const trashTreeOf = (id: string, tree: string): string => `trash:${id}|${tree}`
export const trashTreePrefix = (id: string): string => `trash:${id}|`
export const candidateTree = (id: string): string => `candidate:${id}`
export function decodeLegacySkillTree(
  skillId: string,
  tree: string,
  path: string,
): ContentRef<{ skillId: string; tree: string; path: string }> {
  return legacyContentRef('skill-tree', 'database-bytes', { skillId, tree, path })
}

export function legacySkillOperationDirectory(
  filesDir: string,
  operationId: string,
  kind: 'staged' | 'backup' | 'candidate',
): string {
  return `${filesDir}.op-${operationId}.${kind}`
}

// Historical name-keyed identities intentionally did not validate the old name/version.
export function legacyNamedSkillFiles(name: string | undefined): string {
  return `skills/${name}/files`
}
export function legacyNamedSkillVersion(name: string | undefined, version: number): string {
  return `skills/${name}/versions/v${version}/files`
}
export function legacySkillIdentitySpelling(path: string): string {
  return path.replace(/\/+$/, '')
}
export const LEGACY_DATABASE_SKILL_ROOT = 'database:skill_content_entries'

export { encodeLegacyContent as encodeLegacySkillPath } from './contentRef'
