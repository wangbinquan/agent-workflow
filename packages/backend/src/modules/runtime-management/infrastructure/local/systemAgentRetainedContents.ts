import { join } from 'node:path'
import type {
  SystemAgentRetainedContents,
  SystemAgentWorkspaceScope,
  SystemAgentWorkspaceScopes,
} from '../../application/ports/systemAgentRetainedContents'
import type {
  AgentMaterialSeedFile,
  AgentMaterialWorkspace,
} from '../../application/ports/agentMaterialWorkspace'
import {
  bindNativeAgentMaterialWorkspace,
  releaseSystemAgentScratch,
} from './agentMaterialWorkspace'

/** All physical layout and retained-result interpretation stays with this owner. */
export function createLocalSystemAgentRetainedContents(input: { appHome(): string }) {
  const parents = new WeakMap<SystemAgentWorkspaceScope, string>()
  const retained = new Map<string, { readonly root: string }>()
  const referencesByRoot = new Map<string, Set<string>>()
  function register(reference: string, root: string) {
    retained.set(reference, { root })
    let references = referencesByRoot.get(root)
    if (references === undefined) {
      references = new Set<string>()
      referencesByRoot.set(root, references)
    }
    references.add(reference)
  }
  function discardReferences(root: string) {
    for (const reference of referencesByRoot.get(root) ?? []) retained.delete(reference)
    referencesByRoot.delete(root)
  }
  function parent(scope: SystemAgentWorkspaceScope): string {
    const selected = parents.get(scope)
    if (selected === undefined) throw new Error('system-workspace-scope-unavailable')
    return selected
  }
  const workspaces: SystemAgentWorkspaceScopes = Object.freeze<SystemAgentWorkspaceScopes>({
    capture(scope) {
      const namespace = scope.namespace
      const selected = Object.freeze({
        namespace,
        get name() {
          return scope.name
        },
      })
      const directoryName = namespace === 'intent' ? 'intent-scratch' : 'scratch'
      parents.set(selected, join(input.appHome(), directoryName))
      return selected
    },
    withName(scope, name) {
      const selected = Object.freeze({ namespace: scope.namespace, name })
      parents.set(selected, parent(scope))
      return selected
    },
  })
  const contents: SystemAgentRetainedContents = Object.freeze<SystemAgentRetainedContents>({
    forget(request) {
      const entry = retained.get(request.retainedRef)
      if (entry === undefined) return
      retained.delete(request.retainedRef)
      const references = referencesByRoot.get(entry.root)
      references?.delete(request.retainedRef)
      if (references?.size === 0) referencesByRoot.delete(entry.root)
    },
    release(request) {
      const entry = retained.get(request.retainedRef)
      if (entry === undefined) return { removed: false, reason: 'unsafe-path' }
      const result = releaseSystemAgentScratch({
        scratchDir: entry.root,
        expectedParent: parent(request.scope),
        expectedName: request.scope.name ?? '',
      })
      if (result.removed) discardReferences(entry.root)
      return result
    },
  })
  function open(request: {
    readonly scope: SystemAgentWorkspaceScope
    readonly feature: () => string
    readonly seedFiles: () => readonly AgentMaterialSeedFile[] | undefined
  }) {
    const selected = bindNativeAgentMaterialWorkspace({
      kind: 'system',
      parent: () => parent(request.scope),
      feature: request.feature,
      scratchName: () => request.scope.name,
      seedFiles: request.seedFiles,
    })
    const original = selected.workspace
    const workspace: AgentMaterialWorkspace = {
      get workspace() {
        return original.workspace
      },
      get runContent() {
        return original.runContent
      },
      get retainedRef() {
        return original.retainedRef
      },
      prepare() {
        return original.prepare()
      },
      discard() {
        const discarded = original.discard()
        if (discarded !== undefined)
          return discarded.then(() => {
            discardReferences(selected.locations.root)
          })
        discardReferences(selected.locations.root)
      },
    }
    register(original.retainedRef, selected.locations.root)
    return { workspace, locations: selected.locations }
  }
  /** Explicit native fixture projection; ordinary callers cannot access it. */
  function bindFixtureRetainedResult(reference: string, root: string) {
    register(reference, root)
  }
  return Object.freeze({ workspaces, contents, open, bindFixtureRetainedResult, parent })
}
