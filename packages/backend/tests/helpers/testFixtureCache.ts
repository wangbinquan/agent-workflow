// RFC-615: immutable preparation artifacts shared only inside one CI job, across Bun isolates.
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, watch } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

export const TEST_FIXTURE_CACHE_ENV = 'AW_TEST_FIXTURE_CACHE_DIR'
export type FixtureInput =
  | null
  | boolean
  | number
  | string
  | readonly FixtureInput[]
  | { readonly [key: string]: FixtureInput }

function canonical(value: FixtureInput): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  throw new Error('Fixture cache inputs must be finite JSON values')
}

export function fixtureDigest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function fixtureCacheKey(kind: string, inputs: FixtureInput): string {
  if (!/^[a-z][a-z0-9-]*$/.test(kind)) throw new Error('Invalid fixture cache kind')
  return fixtureDigest(canonical({ format: 1, kind, inputs }))
}

export async function fixtureFileDigest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes as Buffer)
  return hash.digest('hex')
}

interface Manifest {
  version: 1
  key: string
  kind: string
  size: number
  sha256: string
  executable: boolean
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

async function manifestAt(
  directory: string,
  key: string,
  kind: string,
  executable: boolean,
): Promise<Manifest | null> {
  let directoryStat
  try {
    directoryStat = await lstat(directory)
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
  if (!directoryStat.isDirectory()) throw new Error('Fixture cache entry is not a directory')
  const metadata = join(directory, 'manifest.json')
  if (!(await lstat(metadata)).isFile()) throw new Error('Invalid fixture cache manifest file')
  const value = JSON.parse(await readFile(metadata, 'utf8')) as Manifest
  if (
    value.version !== 1 ||
    value.key !== key ||
    value.kind !== kind ||
    value.executable !== executable ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new Error('Invalid fixture cache manifest')
  const artifact = await lstat(join(directory, 'artifact'))
  if (
    !artifact.isFile() ||
    artifact.size !== value.size ||
    (executable && process.platform !== 'win32' && (artifact.mode & 0o111) === 0)
  )
    throw new Error('Invalid fixture cache artifact size or executable mode')
  return value
}

async function copyArtifact(
  directory: string,
  manifest: Manifest,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  const temporary = `${destination}.fixture-${randomUUID()}`
  try {
    signal.throwIfAborted()
    await copyFile(join(directory, 'artifact'), temporary, constants.COPYFILE_FICLONE)
    // Verify the bytes delivered to this case, including corruption between lookup and copy.
    if ((await fixtureFileDigest(temporary)) !== manifest.sha256)
      throw new Error('Fixture cache artifact digest mismatch')
    if (manifest.executable) await chmod(temporary, 0o755)
    signal.throwIfAborted()
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { force: true })
  }
}

function waitForChange(directory: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const watcher = watch(directory, () => finish())
    // Notifications may precede the rename on macOS, or be coalesced on Windows.
    const timer = setTimeout(() => finish(), 250)
    const aborted = () => finish(signal.reason as Error)
    function finish(error?: Error) {
      clearTimeout(timer)
      watcher.close()
      signal.removeEventListener('abort', aborted)
      if (error) reject(error)
      else resolve()
    }
    watcher.once('error', finish)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}

async function releaseOwnedLock(lock: string, token: string): Promise<void> {
  let owner: { token?: string } | undefined
  try {
    owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as { token?: string }
  } catch (error) {
    // No competitor steals a lock. A failed initial owner write still belongs to this call.
    if (!missing(error)) throw error
  }
  if (!owner || owner.token === token) await rm(lock, { recursive: true, force: true })
}

export interface MaterializeFixtureOptions {
  kind: string
  inputs: FixtureInput
  destination: string
  /** Null explicitly disables the job cache; undefined reads the CI environment. */
  cacheRoot?: string | null
  executable?: boolean
  signal?: AbortSignal
  timeoutMs?: number
  build: (destination: string, signal: AbortSignal) => Promise<void>
}

/** No global/process cache: the on-disk owner and immutable entry survive --isolate. */
export async function materializeTestFixture(options: MaterializeFixtureOptions): Promise<{
  path: string
  key: string
  cache: 'hit' | 'miss' | 'disabled'
}> {
  const { kind, destination, build, executable = false } = options
  const key = fixtureCacheKey(kind, options.inputs)
  const cacheRoot =
    options.cacheRoot === undefined ? process.env[TEST_FIXTURE_CACHE_ENV] : options.cacheRoot
  if (cacheRoot && !isAbsolute(cacheRoot)) throw new Error('Fixture cache root must be absolute')
  const timeoutMs = options.timeoutMs ?? 120_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error('Invalid fixture cache timeout')
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal!.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  let waitingOwner = ''
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(`Fixture preparation timed out: ${kind}; lock owner ${waitingOwner || 'none'}`),
      ),
    timeoutMs,
  )
  const signal = controller.signal
  let stage: string | undefined
  let lock: string | undefined
  let ownsLock = false
  const token = randomUUID()
  let state: 'hit' | 'miss' | 'disabled' = cacheRoot ? 'miss' : 'disabled'
  const started = performance.now()
  let buildMs = 0
  let copyMs = 0
  try {
    signal.throwIfAborted()
    await mkdir(dirname(destination), { recursive: true })
    let entry: string | undefined
    if (cacheRoot) {
      await mkdir(cacheRoot, { recursive: true })
      if (!(await lstat(cacheRoot)).isDirectory()) throw new Error('Invalid fixture cache root')
      entry = join(cacheRoot, `${kind}-${key}`)
      lock = `${entry}.lock`
      while (true) {
        signal.throwIfAborted()
        const existing = await manifestAt(entry, key, kind, executable)
        if (existing) {
          state = 'hit'
          const copying = performance.now()
          await copyArtifact(entry, existing, destination, signal)
          copyMs = performance.now() - copying
          return { path: destination, key, cache: state }
        }
        try {
          await mkdir(lock)
          ownsLock = true
          await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token }))
          break
        } catch (error) {
          if (ownsLock || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          try {
            waitingOwner = await readFile(join(lock, 'owner.json'), 'utf8')
          } catch (readError) {
            if (!missing(readError)) throw readError
          }
          await waitForChange(cacheRoot, signal)
        }
      }
      // A previous owner can publish between our lookup and acquiring its released lock.
      const existing = await manifestAt(entry, key, kind, executable)
      if (existing) {
        state = 'hit'
        const copying = performance.now()
        await copyArtifact(entry, existing, destination, signal)
        copyMs = performance.now() - copying
        return { path: destination, key, cache: state }
      }
    }
    stage = await mkdtemp(join(cacheRoot || dirname(destination), `.fixture-${kind}-`))
    const artifact = join(stage, 'artifact')
    const building = performance.now()
    await build(artifact, signal)
    buildMs = performance.now() - building
    signal.throwIfAborted()
    const stat = await lstat(artifact)
    if (!stat.isFile() || stat.size <= 0)
      throw new Error('Fixture builder produced no regular artifact')
    if (executable) await chmod(artifact, 0o755)
    const manifest: Manifest = {
      version: 1,
      key,
      kind,
      size: stat.size,
      sha256: await fixtureFileDigest(artifact),
      executable,
    }
    await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest))
    signal.throwIfAborted()
    if (entry) {
      await rename(stage, entry)
      stage = undefined
    }
    const copying = performance.now()
    await copyArtifact(entry ?? stage!, manifest, destination, signal)
    copyMs = performance.now() - copying
    return { path: destination, key, cache: state }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    if (stage) await rm(stage, { recursive: true, force: true })
    if (ownsLock && lock) await releaseOwnedLock(lock, token)
    console.info(
      `[fixture-cache] ${kind} ${state} build=${buildMs.toFixed(1)}ms copy=${copyMs.toFixed(1)}ms total=${(performance.now() - started).toFixed(1)}ms`,
    )
  }
}
