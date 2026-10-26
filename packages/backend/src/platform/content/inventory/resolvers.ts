import { relative, resolve, sep, isAbsolute } from 'node:path'
import type { ContentLocation } from '../contentRef'
import { rebaseSkillOperationPath, DATABASE_SKILL_ROOT } from '../locations/skill'
import { hostedObjectReferenceOwner, parseHostedObject } from '../locations/hostedObject'
import type { ContentRootSpec } from '@/platform/persistence/migration/run/types'

export type InventoryResolution =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'directory-tree'; readonly path: string }
  | {
      readonly kind: 'database-tree'
      readonly skillId: string
      readonly tree: string
      readonly path?: string
    }
  | {
      readonly kind: 'object'
      readonly objectId: string
      readonly sha256: string | null
      readonly size: number | null
    }
  | { readonly kind: 'unsupported'; readonly reason: string }

export function inventoryRelativePath(root: string, path: string): string {
  return relative(resolve(root), resolve(path)).split(sep).join('/')
}
export function inventoryHomePath(root: ContentRootSpec, path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const runPath = /^(runs|logs|evidence)(\/|$)/.test(normalized)
  if (!isAbsolute(normalized))
    return resolve(runPath ? (root.runContentRoot ?? root.root) : root.root, normalized)
  const relativePath = inventoryRelativePath(root.root, normalized)
  return /^(runs|logs|evidence)(\/|$)/.test(relativePath)
    ? resolve(root.runContentRoot ?? root.root, relativePath)
    : resolve(normalized)
}
export function inventoryManifestPath(root: ContentRootSpec, path: string): string {
  const relativePath = inventoryRelativePath(root.runContentRoot ?? root.root, path)
  return /^(runs|logs|evidence)(\/|$)/.test(relativePath)
    ? relativePath
    : inventoryRelativePath(root.root, path)
}
export function resolveContentLocation(
  location: ContentLocation,
  root: ContentRootSpec,
): InventoryResolution {
  const value = location.value
  const object = (
    objectId: string,
    sha256: string | null = null,
    size: number | null = null,
  ): InventoryResolution =>
    root.objects !== 'none'
      ? { kind: 'object', objectId, sha256, size }
      : { kind: 'unsupported', reason: 'object-store-unavailable' }
  switch (location.codec) {
    case 'prompt': {
      const prompt = value as { promptPath?: unknown }
      return typeof prompt?.promptPath === 'string'
        ? {
            kind: 'file',
            path: resolve(root.runContentRoot ?? root.root, 'runs', prompt.promptPath),
          }
        : { kind: 'unsupported', reason: 'prompt-file-path-required' }
    }
    case 'aw-object:v2': {
      if (typeof value !== 'string') break
      const owner = hostedObjectReferenceOwner(value)
      if (!owner) break
      const ref = parseHostedObject(owner, value)
      return object(ref.id, ref.sha256, ref.size)
    }
    case 'hosted-object-id':
      return typeof value === 'string'
        ? object(value)
        : { kind: 'unsupported', reason: 'object-id-required' }
    case 'review-object': {
      const review = value as { objectId?: unknown }
      if (typeof review?.objectId === 'string') return object(review.objectId)
      break
    }
    case 'review-body':
    case 'port-archive-file':
      if (typeof value === 'string') {
        if (hostedObjectReferenceOwner(value))
          return resolveContentLocation({ codec: 'aw-object:v2', value }, root)
        return { kind: 'file', path: inventoryHomePath(root, value) }
      }
      break
    case 'skill-tree': {
      const tree = value as { skillId?: unknown; tree?: unknown; path?: unknown }
      if (typeof tree?.skillId === 'string' && typeof tree.tree === 'string')
        return {
          kind: 'database-tree',
          skillId: tree.skillId,
          tree: tree.tree,
          ...(typeof tree.path === 'string' ? { path: tree.path } : {}),
        }
      break
    }
    case 'skill-path': {
      if (typeof value !== 'string' || value === DATABASE_SKILL_ROOT)
        return { kind: 'unsupported', reason: 'skill-path-source-identity-required' }
      const normalized = value.replaceAll('\\', '/')
      const marker = normalized.lastIndexOf('/skills/')
      const local = marker < 0 ? normalized : normalized.slice(marker + 1)
      const key = /^skills\/([^/]+)/.exec(local)?.[1]
      if (!key) break
      return { kind: 'directory-tree', path: rebaseSkillOperationPath(root.root, local, key) }
    }
  }
  return { kind: 'unsupported', reason: `content-codec-unsupported:${location.codec}` }
}
