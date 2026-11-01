import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import type { Json, L2Approval, ReleaseRegistry } from './model'

export const REPO_ROOT = resolve(import.meta.dirname, '../../..')
export const FIXTURES = join(REPO_ROOT, 'packages/backend/tests/fixtures/release-upgrade')
export const REGISTRY_PATH = join(FIXTURES, 'releases.json')
export const sha256 = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  if (typeof value === 'bigint') return canonical({ $bigint: String(value) })
  if (value === undefined) throw new Error('undefined is not a canonical value')
  return JSON.stringify(value)
}
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}
export function readRegistry(path = REGISTRY_PATH): ReleaseRegistry {
  const registry = JSON.parse(readFileSync(path, 'utf8')) as ReleaseRegistry
  if (registry.formatVersion !== 1) throw new Error('Unsupported release registry format')
  return registry
}
export function readL2Approvals(fixtures = FIXTURES): L2Approval[] {
  const file = JSON.parse(readFileSync(join(fixtures, 'l2-approvals.json'), 'utf8')) as {
    formatVersion: number
    entries: L2Approval[]
  }
  if (file.formatVersion !== 1 || !Array.isArray(file.entries))
    throw new Error('Invalid L2 approvals file')
  const seen = new Set<string>()
  for (const entry of file.entries) {
    if (
      !/^v\d+\.\d+\.\d+$/.test(entry.tag) ||
      seen.has(entry.tag) ||
      entry.approvedBy !== 'user' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.approvedAt) ||
      !entry.reason.trim()
    )
      throw new Error(`Invalid L2 approval: ${entry.tag}`)
    seen.add(entry.tag)
  }
  return file.entries
}
export function walk(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Refusing to follow fixture symlink: ${path}`)
      return entry.isDirectory() ? walk(path) : [path]
    })
    .sort()
}
export function normalizeHome(value: Json, home: string): Json {
  if (typeof value === 'string') {
    return value
      .split(home.replaceAll('\\', '\\\\'))
      .join('<AW_HOME>')
      .split(home)
      .join('<AW_HOME>')
      .split(home.replaceAll('\\', '/'))
      .join('<AW_HOME>')
  }
  if (Array.isArray(value)) return value.map((item) => normalizeHome(item, home))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeHome(item, home)]),
    )
  return value
}

/** argv only; never pass repository content, credentials, or user text to a shell. */
/** Old CLIs print their own failures on stdout; keep that evidence without URL credentials. */
export function redactUrlCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
}

export async function command(
  argv: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    input?: Uint8Array
    timeoutMs?: number
    /** Errors name the label plus stderr and the stdout tail with URL credentials redacted (argv may hold them). */
    label?: string
  } = {},
): Promise<Buffer> {
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const output: Buffer[] = []
  const errors: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => errors.push(chunk))
  const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 300_000)
  child.stdin.on('error', () => {
    /* Exit status owns an early closed input. */
  })
  child.stdin.end(options.input)
  try {
    await new Promise<void>((accept, reject) => {
      child.on('error', reject)
      child.on('close', (code, signal) =>
        code === 0
          ? accept()
          : reject(
              new Error(
                `${options.label ?? argv[0]} exited ${code ?? signal}: ${redactUrlCredentials(
                  Buffer.concat(errors).toString('utf8').slice(-16_000),
                )}${
                  output.length
                    ? `\nstdout: ${redactUrlCredentials(Buffer.concat(output).toString('utf8').slice(-8_000))}`
                    : ''
                }`,
              ),
            ),
      )
    })
    return Buffer.concat(output)
  } finally {
    clearTimeout(timer)
  }
}
