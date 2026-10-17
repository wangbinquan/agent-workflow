import {
  closeSync,
  createReadStream,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { requireWorkPathWithoutSymlinks } from '@/platform/crewstation/workVolumePath'
import {
  assertWorkVolumeWritersSettled,
  retainWorkVolumeWriter,
} from '@/platform/crewstation/workVolumeWriters'
import { runManagedProcess } from '@/services/execution/managedProcess'
import { validatePluginMaterialTree } from '../infrastructure/crewstation/pluginMaterialTree'
import {
  installPlugin,
  inferSourceKind,
  fileSpecToHostPath,
  PLUGIN_GENERATION_MANIFEST,
  readGenerationManifestForCachedPath,
  type InstallResult,
} from '../infrastructure/local/filePluginInstallation'
import { createSha256DigestBuilder, sha256Hex } from '@/util/hash'
import { assertSameFileIdentityForHost } from '@/util/fileTrust'

const Request = z.discriminatedUnion('method', [
  z
    .object({
      method: z.literal('install'),
      pluginId: z.string().regex(/^[A-Za-z0-9_-]+$/),
      generationId: z.string().regex(/^[A-Za-z0-9_-]+$/),
      spec: z.string().min(1),
    })
    .strict(),
  z
    .object({
      method: z.literal('discard'),
      pluginId: z.string().regex(/^[A-Za-z0-9_-]+$/),
      generationId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    })
    .strict(),
])
export type TaskImagePluginFile =
  | {
      readonly kind: 'file'
      readonly path: string
      readonly sha256: string
      readonly size: number
      readonly mode: number
    }
  | { readonly kind: 'symlink'; readonly path: string; readonly target: string }
export interface TaskImagePluginResult {
  readonly sourceKind: InstallResult['sourceKind']
  readonly resolvedVersion: string | null
  readonly sourceIdentity: string | null
  readonly root: string
  readonly entry: string
  readonly files: readonly TaskImagePluginFile[]
}

/** The shared installer runs exclusively inside the CS task image. Its npm
 * process keeps a durable writer receipt; the generation is retained whenever
 * quiescence is uncertain, including after a helper restart. */
export async function executeTaskImagePlugin(
  value: unknown,
  signal?: AbortSignal,
  volumeRoot = '/work',
): Promise<TaskImagePluginResult | null> {
  const request = Request.parse(value)
  const pluginsDir = requireWorkPathWithoutSymlinks(join(volumeRoot, 'plugins'), volumeRoot)
  const generation = requireWorkPathWithoutSymlinks(
    join(pluginsDir, request.pluginId, 'generations', request.generationId),
    volumeRoot,
  )
  const receiptDir = requireWorkPathWithoutSymlinks(
    join(volumeRoot, 'plugin-receipts', request.pluginId, request.generationId),
    volumeRoot,
  )
  if (request.method === 'discard') {
    assertWorkVolumeWritersSettled(volumeRoot, generation)
    rmSync(generation, { recursive: true, force: true })
    rmSync(receiptDir, { recursive: true, force: true })
    return null
  }
  const digest = sha256Hex(JSON.stringify(request))
  const requestPath = join(receiptDir, 'request.json')
  if (lstatSync(requestPath, { throwIfNoEntry: false })) {
    if (JSON.parse(readFileSync(requestPath, 'utf8')).digest !== digest)
      throw new Error('hosted-plugin-request-changed')
  } else {
    mkdirSync(receiptDir, { recursive: true })
    durableJson(requestPath, { digest })
  }
  const resultPath = join(receiptDir, 'result.json')
  if (lstatSync(resultPath, { throwIfNoEntry: false })) {
    const receipt = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      digest: string
      result: TaskImagePluginResult
    }
    if (receipt.digest !== digest) throw new Error('hosted-plugin-request-changed')
    return receipt.result
  }
  let spec = request.spec
  if (inferSourceKind(spec) === 'file') {
    spec = `file:${requireWorkPathWithoutSymlinks(fileSpecToHostPath(spec), volumeRoot)}`
    const source = fileSpecToHostPath(spec)
    const sourceRoot = lstatSync(source).isDirectory() ? source : dirname(source)
    if (resolve(sourceRoot) === resolve(volumeRoot))
      throw new Error('hosted-plugin-source-root-not-isolated')
  }
  assertWorkVolumeWritersSettled(volumeRoot, generation)
  let recovered: InstallResult | undefined
  const nativeManifest = join(generation, PLUGIN_GENERATION_MANIFEST)
  if (lstatSync(nativeManifest, { throwIfNoEntry: false })) {
    const raw = JSON.parse(readFileSync(nativeManifest, 'utf8')) as { entryRelativePath?: unknown }
    if (typeof raw.entryRelativePath !== 'string') throw new Error('hosted-plugin-manifest-invalid')
    const cachedPath = requireWorkPathWithoutSymlinks(
      join(generation, raw.entryRelativePath),
      generation,
    )
    const manifest = await readGenerationManifestForCachedPath(cachedPath)
    if (
      !manifest ||
      manifest.pluginId !== request.pluginId ||
      manifest.opId !== request.generationId ||
      manifest.requestedSpec !== spec
    )
      throw new Error('hosted-plugin-manifest-invalid')
    recovered = {
      cachedPath,
      sourceKind: manifest.sourceKind,
      resolvedVersion: manifest.resolvedVersion,
      sourceIdentity: manifest.sourceIdentity,
      generationDir: generation,
      manifest,
    }
  } else {
    // Only this immutable request's incomplete generation can be replaced, and
    // only after the durable child receipts prove that no writer remains.
    rmSync(generation, { recursive: true, force: true })
  }
  const writer = retainWorkVolumeWriter(
    volumeRoot,
    `plugin:${request.pluginId}:${request.generationId}`,
    generation,
  )
  let quiesced = true
  let installed: InstallResult
  try {
    const npmBin = inferSourceKind(spec) === 'file' ? undefined : Bun.which('npm')
    if (npmBin === null) throw new Error('npm-unavailable')
    installed =
      recovered ??
      (await installPlugin(request.pluginId, spec, {
        pluginsDir,
        generationId: request.generationId,
        ...(npmBin ? { npmBin } : {}),
        async command(command) {
          quiesced = false
          const result = await runManagedProcess({
            argv: [...command.argv],
            cwd: volumeRoot,
            env: Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string',
              ),
            ),
            timeoutMs: command.timeoutMs,
            signal,
            captureRawStdout: true,
            requireSpawnReceipt: true,
            onSpawned: (receipt) => writer.spawned(receipt),
          })
          if (result.outcome === 'child-unkillable')
            throw new Error('hosted-plugin-writer-unreaped')
          quiesced = true
          if (result.outcome === 'aborted') throw new Error('hosted-plugin-install-aborted')
          if (result.outcome === 'timeout') throw new Error('hosted-plugin-install-timeout')
          if (result.outcome === 'spawn-failed')
            throw new Error('hosted-plugin-install-spawn-failed')
          return {
            stdout: result.rawStdout,
            stderr: result.stderrTail,
            exitCode: result.exitCode ?? -1,
          }
        },
      }))
  } finally {
    if (quiesced) writer.release()
  }
  const cached = requireWorkPathWithoutSymlinks(installed.cachedPath, volumeRoot)
  const root =
    installed.generationDir ?? (lstatSync(cached).isDirectory() ? cached : dirname(cached))
  requireWorkPathWithoutSymlinks(root, volumeRoot)
  const files: TaskImagePluginFile[] = []
  const visit = async (path: string, name: string): Promise<void> => {
    if (files.length >= 100_000) throw new Error('hosted-plugin-file-count-exceeded')
    const before = lstatSync(path)
    if (before.isSymbolicLink()) {
      const target = readlinkSync(path)
      const resolved = relative(root, resolve(dirname(path), target))
      if (
        isAbsolute(target) ||
        resolved === '..' ||
        resolved.startsWith('..' + sep) ||
        isAbsolute(resolved)
      )
        throw new Error('hosted-plugin-link-outside-generation')
      files.push({ kind: 'symlink', path: name, target: target.split(sep).join('/') })
      return
    }
    if (before.isDirectory()) {
      for (const entry of readdirSync(path).sort())
        await visit(join(path, entry), name ? `${name}/${entry}` : entry)
      return
    }
    if (!before.isFile()) throw new Error('hosted-plugin-special-file-refused')
    const hash = createSha256DigestBuilder()
    let size = 0
    for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
      hash.update(chunk)
      size += chunk.length
    }
    const after = lstatSync(path)
    if (
      !assertSameFileIdentityForHost(before, after).trusted ||
      before.mtimeMs !== after.mtimeMs ||
      size !== before.size
    )
      throw new Error('hosted-plugin-source-changed')
    files.push({
      kind: 'file',
      path: name,
      sha256: hash.digestHex(),
      size,
      mode: before.mode & 0o777,
    })
  }
  await visit(root, '')
  const result: TaskImagePluginResult = {
    sourceKind: installed.sourceKind,
    resolvedVersion: installed.resolvedVersion,
    sourceIdentity: installed.sourceIdentity,
    root,
    entry: relative(root, cached).split(sep).join('/') || '.',
    files,
  }
  validatePluginMaterialTree(files, result.entry)
  durableJson(resultPath, { digest, result })
  return result
}

function durableJson(path: string, value: unknown) {
  const temporary = `${path}.tmp`
  const fd = openSync(temporary, 'w', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(value))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
  if (process.platform !== 'win32') {
    const directory = openSync(dirname(path), 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  }
}
