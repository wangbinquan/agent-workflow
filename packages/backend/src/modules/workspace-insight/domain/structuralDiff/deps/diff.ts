// RFC-083 PR-B — set-diff manifest dependency maps (old → new) into
// DependencyChange[]. Pure: callers (PR-C) feed the changed manifest files'
// before/after text. `viaManifest` is always true here; `viaImport` correlation
// (a new source import resolving to a newly-added package) is layered on by the
// orchestrator when it has both signals.

import type { DependencyChange, Ecosystem } from '@agent-workflow/shared'
import { ecosystemForManifest, parseManifest, type DepMap } from './manifests'

/** Diff one manifest file's before/after content. Null content = absent side. */
export function dependencyChangesForManifest(opts: {
  filePath: string
  oldContent: string | null
  newContent: string | null
}): DependencyChange[] {
  const ecosystem = ecosystemForManifest(opts.filePath)
  if (ecosystem === null) return []
  const oldDeps: DepMap =
    opts.oldContent !== null ? parseManifest(ecosystem, opts.oldContent) : new Map()
  const newDeps: DepMap =
    opts.newContent !== null ? parseManifest(ecosystem, opts.newContent) : new Map()
  return diffDepMaps(ecosystem, opts.filePath, oldDeps, newDeps)
}

function diffDepMaps(
  ecosystem: Ecosystem,
  manifestPath: string,
  oldDeps: DepMap,
  newDeps: DepMap,
): DependencyChange[] {
  const out: DependencyChange[] = []
  for (const [name, newVer] of newDeps) {
    if (!oldDeps.has(name)) {
      out.push({
        ecosystem,
        packageName: name,
        changeType: 'added',
        versionAfter: newVer ?? undefined,
        viaManifest: true,
        viaImport: false,
        manifestPath,
      })
    } else {
      const oldVer = oldDeps.get(name) ?? null
      if (oldVer !== newVer && (oldVer !== null || newVer !== null)) {
        out.push({
          ecosystem,
          packageName: name,
          changeType: 'updated',
          versionBefore: oldVer ?? undefined,
          versionAfter: newVer ?? undefined,
          viaManifest: true,
          viaImport: false,
          manifestPath,
        })
      }
    }
  }
  for (const [name, oldVer] of oldDeps) {
    if (!newDeps.has(name)) {
      out.push({
        ecosystem,
        packageName: name,
        changeType: 'removed',
        versionBefore: oldVer ?? undefined,
        viaManifest: true,
        viaImport: false,
        manifestPath,
      })
    }
  }
  return out
}

/** Aggregate dependency changes across all changed manifest files, sorted by
 *  ecosystem then package for stable output. */
export function aggregateDependencyChanges(
  files: Array<{ filePath: string; oldContent: string | null; newContent: string | null }>,
): DependencyChange[] {
  const all: DependencyChange[] = []
  for (const f of files) all.push(...dependencyChangesForManifest(f))
  return all.sort(
    (a, b) =>
      a.ecosystem.localeCompare(b.ecosystem) ||
      a.packageName.localeCompare(b.packageName) ||
      a.changeType.localeCompare(b.changeType),
  )
}
