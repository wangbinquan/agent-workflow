import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, sep } from 'node:path'
import { requireWorkPath, requireWorkPathWithoutSymlinks } from './workVolumePath'
import { sha256Hex } from '@/util/hash'

function syncDirectory(directory: string) {
  if (process.platform === 'win32') return
  const fd = openSync(directory, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function writerPath(root: string, identity: string) {
  return requireWorkPathWithoutSymlinks(
    join(root, '.aw-writers', sha256Hex(identity) + '.json'),
    root,
  )
}

/** Only a domain's durable final receipt may authorize this cold cleanup. */
export function releaseCompletedWorkVolumeWriter(root: string, identity: string) {
  const path = writerPath(root, identity)
  rmSync(path, { force: true })
  try {
    syncDirectory(join(root, '.aw-writers'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Durable task-image writer receipts. Ambiguous or unreaped writers block
 * removal even after the control plane or the helper process has restarted. */
export function retainWorkVolumeWriter(root: string, identity: string, workspace: string) {
  const directory = requireWorkPathWithoutSymlinks(join(root, '.aw-writers'), root)
  const path = writerPath(root, identity)
  requireWorkPath(workspace, root)
  mkdirSync(directory, { recursive: true })
  const persist = (value: object, initial = false) => {
    const tmp = `${path}.tmp`
    let fd: number
    try {
      // Claim before spawn; two helpers may receive the same operation at once.
      fd = openSync(initial ? path : tmp, initial ? 'wx' : 'w', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error('hosted-workspace-writer-not-settled')
      throw error
    }
    try {
      writeFileSync(fd, JSON.stringify(value))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (!initial) renameSync(tmp, path)
    syncDirectory(directory)
  }
  persist({ identity, workspace }, true)
  return {
    spawned(receipt: {
      pid: number
      spawnBinaryPath: string
      spawnedAt: number
      launchNonce?: string
    }) {
      persist({ identity, workspace, ...receipt })
    },
    release() {
      releaseCompletedWorkVolumeWriter(root, identity)
    },
  }
}

export function assertWorkVolumeWritersSettled(root: string, workspace: string): void {
  const directory = requireWorkPathWithoutSymlinks(join(root, '.aw-writers'), root)
  requireWorkPath(workspace, root)
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const receipt = JSON.parse(
      readFileSync(requireWorkPathWithoutSymlinks(join(directory, name), root), 'utf8'),
    ) as { workspace: string }
    if (typeof receipt.workspace !== 'string')
      throw new Error('hosted-workspace-writer-receipt-invalid')
    requireWorkPath(receipt.workspace, root)
    const child = relative(workspace, receipt.workspace)
    const parent = relative(receipt.workspace, workspace)
    if (
      child === '' ||
      (child !== '..' && !child.startsWith('..' + sep)) ||
      (parent !== '..' && !parent.startsWith('..' + sep))
    )
      throw new Error('hosted-workspace-writer-not-settled')
  }
}
