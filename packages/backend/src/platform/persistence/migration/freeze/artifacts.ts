import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
} from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { sha256Hex } from '@/util/hash'
import { canonicalSchemaJson } from '../../schema/canonical'
import type { EpochSwitchArtifactPort } from '../run/types'

export async function atomicSourceFile(path: string, bytes: Uint8Array | string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  const file = await open(temporary, 'wx')
  try {
    await file.writeFile(bytes)
    await file.sync()
    await file.close()
    await rename(temporary, path)
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  } finally {
    await file.close()
    await rm(temporary, { force: true })
  }
}

const locator = new TextEncoder().encode('rfc395-source-artifacts@1\n')
const locatorDigest = `sha256:${sha256Hex(locator)}`

/** get() binds the portable names to this Job's operation root. S re-materialises
 * journal artifact references before opening F handles; no previous Job path is used. */
export async function sourceArtifactRoot(
  port: EpochSwitchArtifactPort,
  name: string,
): Promise<string> {
  await port.put(`${name}/.root`, locator)
  return dirname(await port.get(`${name}/.root`, locatorDigest))
}

interface DirectoryInventory {
  readonly directories: readonly string[]
  readonly files: readonly { path: string; mtimeMs: number }[]
}
export async function persistSourceDirectory(
  port: EpochSwitchArtifactPort,
  name: string,
  root: string,
): Promise<void> {
  const directories: string[] = []
  const files: { path: string; mtimeMs: number }[] = []
  const visit = async (path: string): Promise<void> => {
    const key = relative(root, path).replaceAll('\\', '/')
    const info = statSync(path)
    if (info.isDirectory()) {
      directories.push(key)
      for (const entry of readdirSync(path).sort()) await visit(join(path, entry))
    } else {
      files.push({ path: key, mtimeMs: Math.trunc(info.mtimeMs) })
    }
  }
  await visit(root)
  // Publish the binding after every payload file so a killed Job cannot expose a
  // committed binding whose copy/evidence has not yet reached durable storage.
  files.sort(
    (a, b) => Number(a.path.endsWith('binding.json')) - Number(b.path.endsWith('binding.json')),
  )
  for (const file of files) {
    const key = `${name}/payload/${file.path}`
    const path = join(root, file.path)
    if (port.putFile) await port.putFile(key, path)
    else await port.put(key, createReadStream(path))
  }
  await port.put(
    `${name}/inventory.json`,
    new TextEncoder().encode(canonicalSchemaJson({ directories, files })),
  )
  await port.put(`${name}/.root`, locator)
}

export async function materializedSourceDirectory(
  port: EpochSwitchArtifactPort,
  name: string,
): Promise<string | null> {
  const directory = await sourceArtifactRoot(port, name)
  const inventory = join(directory, 'inventory.json')
  if (!existsSync(inventory)) return null
  const listing = JSON.parse(readFileSync(inventory, 'utf8')) as DirectoryInventory
  const root = join(directory, 'payload')
  for (const path of listing.directories) mkdirSync(join(root, path), { recursive: true })
  for (const entry of listing.files) {
    const path = join(root, entry.path)
    if (!existsSync(path)) throw new Error('source-artifact-file-missing')
    utimesSync(path, entry.mtimeMs / 1000, entry.mtimeMs / 1000)
  }
  return root
}

export async function syncSourceDirectory(root: string): Promise<void> {
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (statSync(path).isDirectory()) await syncSourceDirectory(path)
    else {
      const file = await open(path, 'r')
      try {
        await file.sync()
      } finally {
        await file.close()
      }
    }
  }
  if (process.platform !== 'win32') {
    const directory = await open(root, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }
}
