// RFC-223 PR-5 — canonical skill filesystem identity.
//
// Every live/version path is keyed by the immutable skills.id. `name` is only a
// display/portable-selector field. The legacy-name helpers below exist solely
// for the one-way boot/restore migration and legacy operation recovery.

import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { lstatSync } from 'node:fs'
import { ValidationError } from '@/util/errors'
import {
  skillRootRel,
  skillFilesRel,
  skillVersionRelPath,
  assertPathSegment,
} from '@/platform/content/locations/skill'
export {
  skillRootRel,
  skillFilesRel,
  skillVersionRelPath,
} from '@/platform/content/locations/skill'

export interface SkillOperationIdentity {
  skillId: string
  legacyName?: string
}

export function skillRootAbs(appHome: string, skillId: string): string {
  return join(appHome, skillRootRel(skillId))
}

export function legacySkillRootAbs(appHome: string, name: string): string {
  return join(appHome, 'skills', assertPathSegment(name, 'legacy skill name'))
}

export function skillFilesAbs(appHome: string, skillId: string): string {
  return join(appHome, skillFilesRel(skillId))
}

export function skillVersionAbs(appHome: string, skillId: string, version: number): string {
  return join(appHome, skillVersionRelPath(skillId, version))
}

/**
 * Decode only the two durable payload shapes that can exist across RFC-223:
 * legacy `{name}` and canonical `{skillId}`. Callers supply op.skillId as the
 * trusted canonical fallback for new rows whose payload was omitted.
 */
export function decodeSkillOperationIdentity(
  preconditionJson: string | null,
  operationSkillId: string,
): SkillOperationIdentity {
  if (preconditionJson === null) {
    throw new ValidationError(
      'skill-operation-payload-invalid',
      'skill operation payload is missing',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(preconditionJson)
  } catch {
    throw new ValidationError(
      'skill-operation-payload-invalid',
      'skill operation payload is not valid JSON',
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError(
      'skill-operation-payload-invalid',
      'skill operation payload must be an object',
    )
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.skillId === 'string' && obj.skillId.length > 0) {
    if (Object.keys(obj).length !== 1) {
      throw new ValidationError(
        'skill-operation-payload-invalid',
        'canonical skill operation payload must contain only skillId',
      )
    }
    if (obj.skillId !== operationSkillId) {
      throw new ValidationError(
        'skill-operation-identity-mismatch',
        'skill operation payload does not match its skill_id',
      )
    }
    return { skillId: assertPathSegment(obj.skillId, 'skill id') }
  }
  if (typeof obj.name === 'string' && obj.name.length > 0) {
    if (Object.keys(obj).length !== 1) {
      throw new ValidationError(
        'skill-operation-payload-invalid',
        'legacy skill operation payload must contain only name',
      )
    }
    return {
      skillId: assertPathSegment(operationSkillId, 'skill id'),
      legacyName: assertPathSegment(obj.name, 'legacy skill name'),
    }
  }
  throw new ValidationError(
    'skill-operation-payload-invalid',
    'skill operation payload must contain skillId or legacy name',
  )
}

export type RealDirectoryChainState = 'missing' | 'real-directory'

/**
 * Inspect every path component from `root` through `target` with lstat. A real
 * directory at the leaf is insufficient: an intermediate `versions -> /host`
 * symlink would otherwise pass and redirect hash/copy/remove outside appHome.
 */
export function realDirectoryChainState(root: string, target: string): RealDirectoryChainState {
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(target)
  const inside = relative(resolvedRoot, resolvedTarget)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new ValidationError(
      'skill-identity-path-invalid',
      'skill path is outside its declared root',
    )
  }
  const parts = inside === '' ? [] : inside.split(sep)
  let current = resolvedRoot
  for (const part of ['', ...parts]) {
    if (part !== '') current = join(current, part)
    try {
      const stat = lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new ValidationError(
          'skill-identity-path-invalid',
          `skill path component is not a real directory: ${current}`,
        )
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      throw err
    }
  }
  return 'real-directory'
}

/**
 * Operation path columns historically stored absolute paths. Backups can be
 * restored under a different appHome, so never touch the persisted absolute
 * prefix. Rebase the suffix rooted at `skills/` into the current appHome and
 * reject any value that cannot be proven to stay inside the current skills root.
 */
export { rebaseSkillOperationPath } from '@/platform/content/locations/skill'
