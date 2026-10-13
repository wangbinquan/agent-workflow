import { join } from 'node:path'
import { lstatSync } from 'node:fs'
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
import {
  createDurableSystemRetainedReference,
  markDurableSystemRetainedReference,
  releaseDurableSystemRetainedReference,
} from './systemAgentRetainedReference'

/** All physical layout and retained-result interpretation stays with this owner. */
export function createLocalSystemAgentRetainedContents(input: { appHome(): string }) {
  const parents = new WeakMap<SystemAgentWorkspaceScope, string>()
  const retained = new Map<string, { readonly root: string }>()
  const referencesByRoot = new Map<string, Set<string>>()
  const retired = new Set<string>()
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
    inspect(request) {
      if (retired.has(request.retainedRef)) return { available: false }
      const durable = releaseDurableSystemRetainedReference({
        retainedRef: request.retainedRef,
        expectedParent: parent(request.scope),
        expectedName: request.scope.name ?? '',
        namespace: request.scope.namespace,
        inspectOnly: true,
      })
      if (durable !== undefined)
        return { available: !durable.removed && durable.reason === undefined }
      const entry = retained.get(request.retainedRef)
      if (!entry || entry.root !== join(parent(request.scope), request.scope.name ?? ''))
        return { available: false }
      try {
        const info = lstatSync(entry.root)
        return { available: info.isDirectory() && !info.isSymbolicLink() }
      } catch {
        return { available: false }
      }
    },
    forget(request) {
      const entry = retained.get(request.retainedRef)
      if (entry === undefined) return
      retired.add(request.retainedRef)
      retained.delete(request.retainedRef)
      const references = referencesByRoot.get(entry.root)
      references?.delete(request.retainedRef)
      if (references?.size === 0) referencesByRoot.delete(entry.root)
    },
    release(request) {
      if (retired.has(request.retainedRef)) return { removed: false, reason: 'unsafe-path' }
      const durable = releaseDurableSystemRetainedReference({
        retainedRef: request.retainedRef,
        expectedParent: parent(request.scope),
        expectedName: request.scope.name ?? '',
        namespace: request.scope.namespace,
      })
      if (durable !== undefined) {
        const entry = retained.get(request.retainedRef)
        if (durable.removed && entry !== undefined) discardReferences(entry.root)
        return durable
      }
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
    const retainedRef = createDurableSystemRetainedReference({
      reference: original.retainedRef,
      root: selected.locations.root,
      parent: parent(request.scope),
      namespace: request.scope.namespace,
    })
    const workspace: AgentMaterialWorkspace = {
      get workspace() {
        return original.workspace
      },
      get runContent() {
        return original.runContent
      },
      get retainedRef() {
        return retainedRef
      },
      prepare() {
        const result = original.prepare()
        if (result !== undefined)
          return result.then(() => {
            markDurableSystemRetainedReference(selected.locations.root, retainedRef)
          })
        markDurableSystemRetainedReference(selected.locations.root, retainedRef)
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
    register(retainedRef, selected.locations.root)
    return { workspace, locations: selected.locations }
  }
  /** Explicit native fixture projection; ordinary callers cannot access it. */
  function bindFixtureRetainedResult(reference: string, root: string) {
    register(reference, root)
  }
  return Object.freeze({ workspaces, contents, open, bindFixtureRetainedResult, parent })
}
