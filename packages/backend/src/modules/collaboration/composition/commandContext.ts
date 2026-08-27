// RFC-333 — composition-owned dependencies for exact collaboration commands.
// Public callers carry only an opaque object reference; the live DB and app
// home never become part of a public command/query contract.

import type { DbClient } from '@/db/client'
import type { CollaborationCommandContext } from '../public/types'

export interface CollaborationCommandDependencies {
  readonly db: DbClient
  readonly appHome?: string
}

const dependencies = new WeakMap<object, CollaborationCommandDependencies>()

export function createCollaborationCommandContext(
  input: CollaborationCommandDependencies,
): CollaborationCommandContext {
  const context = Object.freeze({})
  dependencies.set(context, Object.freeze({ ...input }))
  return context as CollaborationCommandContext
}

export function resolveCollaborationCommandContext(
  context: CollaborationCommandContext,
): CollaborationCommandDependencies {
  const resolved = dependencies.get(context)
  if (resolved === undefined) throw new Error('collaboration command context is not composed')
  return resolved
}

export function requireCollaborationAppHome(context: CollaborationCommandContext): string {
  const appHome = resolveCollaborationCommandContext(context).appHome
  if (appHome === undefined || appHome.length === 0) {
    throw new Error('collaboration command context has no app home')
  }
  return appHome
}
