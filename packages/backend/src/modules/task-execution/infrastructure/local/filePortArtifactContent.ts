import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  writeFileSync,
  realpathSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readInsideRoot, existsInsideRoot } from '@/platform/content/local/rootFileQueries'
import { toPortableRelativePath } from '@/util/platformExec'
import { createLogger } from '@/util/log'
import { encodePortSegment } from '../../domain/portArtifacts'
import { portArchiveRootRel } from '../../application/portArtifacts'
import type {
  PortArtifactArchiveNamespace,
  PortArtifactWorkspaceFile,
  SynchronousPortArtifactContentEffects,
} from '../../application/ports/portArtifactContent'

const log = createLogger('port-artifacts')

/** Construction has no filesystem effects; compatibility locations stay native-only. */
export function createFilePortArtifactContent(
  appHome: string,
  sourceLocations?: WeakMap<PortArtifactWorkspaceFile, string>,
): SynchronousPortArtifactContentEffects {
  const sourcePath = (source: PortArtifactWorkspaceFile): string =>
    sourceLocations?.get(source) ?? resolve(source.workspaceRef, source.relativePath)
  const portRel = (namespace: PortArtifactArchiveNamespace): string =>
    join(
      portArchiveRootRel(namespace.taskId, namespace.nodeRunId),
      encodePortSegment(namespace.portName),
    )
  const archiveLocation = (taskId: string, reference: string) => {
    const portsRootAbs = resolve(appHome, 'runs', taskId, 'ports')
    const rel = relative(portsRootAbs, resolve(appHome, reference))
    if (rel.startsWith('..') || isAbsolute(rel)) {
      log.warn('archive_json file outside task ports namespace — treating as missing', {
        file: reference,
        taskId,
      })
      return null
    }
    return { portsRootAbs, rel }
  }
  return Object.freeze({
    prepareArchive(namespace: PortArtifactArchiveNamespace) {
      const rootAbs = resolve(appHome, portArchiveRootRel(namespace.taskId, namespace.nodeRunId))
      const portAbs = resolve(appHome, portRel(namespace))
      if (portAbs !== rootAbs && !portAbs.startsWith(rootAbs + sep)) {
        throw new Error(`port-artifact containment violated: '${namespace.portName}' → ${portAbs}`)
      }
      mkdirSync(portAbs, { recursive: true })
    },
    reference(namespace: PortArtifactArchiveNamespace, index: number, extension: string) {
      return join(portRel(namespace), `item_${index}${extension}`)
    },
    size(source: PortArtifactWorkspaceFile) {
      return statSync(sourcePath(source)).size
    },
    copy(source: PortArtifactWorkspaceFile, reference: string) {
      copyFileSync(sourcePath(source), resolve(appHome, reference))
    },
    readPrefix(source: PortArtifactWorkspaceFile, maxBytes: number) {
      const fd = openSync(sourcePath(source), 'r')
      try {
        const buf = Buffer.alloc(maxBytes)
        const n = readSync(fd, buf, 0, buf.length, 0)
        return buf.subarray(0, n)
      } finally {
        closeSync(fd)
      }
    },
    write(reference: string, bytes: Uint8Array) {
      writeFileSync(resolve(appHome, reference), bytes)
    },
    linkTarget(source: PortArtifactWorkspaceFile) {
      const abs = sourcePath(source)
      if (!lstatSync(abs).isSymbolicLink()) return null
      const realTarget = realpathSync(abs)
      const realRoot = realpathSync(source.workspaceRef)
      if (realTarget === realRoot || realTarget.startsWith(realRoot + sep)) {
        return {
          kind: 'inside' as const,
          relativePath: toPortableRelativePath(relative(realRoot, realTarget)),
        }
      }
      return { kind: 'outside' as const }
    },
    readArchive(taskId: string, reference: string) {
      const location = archiveLocation(taskId, reference)
      return location === null ? null : readInsideRoot(location.portsRootAbs, location.rel)
    },
    existsArchive(taskId: string, reference: string) {
      const location = archiveLocation(taskId, reference)
      return location !== null && existsInsideRoot(location.portsRootAbs, location.rel)
    },
    readWorkspace(source: PortArtifactWorkspaceFile) {
      return readInsideRoot(source.workspaceRef, source.relativePath)
    },
    existsWorkspace(source: PortArtifactWorkspaceFile) {
      return existsInsideRoot(source.workspaceRef, source.relativePath)
    },
  })
}
