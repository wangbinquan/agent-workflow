import { spawnSync } from 'node:child_process'
import { REPO_ROOT } from './io'

const blobs = new Map<string, Buffer>()
export function git(args: string[]): Buffer {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`)
  return result.stdout
}
/** Reads objects directly. Does not checkout, fetch, update an index, or create a worktree. */
export class TagSource {
  readonly files = new Map<string, string>()
  constructor(readonly tag: string) {
    for (const line of git(['ls-tree', '-r', tag]).toString().trim().split('\n')) {
      const match = /^\d+ blob ([a-f0-9]+)\t(.+)$/.exec(line)
      if (match) this.files.set(match[2]!, match[1]!)
    }
  }
  has(path: string): boolean {
    return this.files.has(path)
  }
  read(path: string): Buffer {
    const hash = this.files.get(path)
    if (!hash) throw new Error(`${this.tag} does not contain ${path}`)
    let bytes = blobs.get(hash)
    if (!bytes) {
      bytes = git(['cat-file', 'blob', hash])
      blobs.set(hash, bytes)
    }
    return bytes
  }
  text(path: string): string {
    return this.has(path) ? this.read(path).toString('utf8') : ''
  }
  /** Paths under `pathspec` whose content contains `needle` (one `git grep`, no blob reads). */
  grepFiles(needle: string, pathspec: string): string[] {
    const result = spawnSync('git', ['grep', '-l', '-F', needle, this.tag, '--', pathspec], {
      cwd: REPO_ROOT,
      maxBuffer: 32 * 1024 * 1024,
    })
    if (result.status === 1) return []
    if (result.status !== 0) throw new Error(`git grep failed: ${result.stderr.toString()}`)
    return result.stdout
      .toString()
      .trim()
      .split('\n')
      .map((line) => line.slice(this.tag.length + 1))
  }
  json<T>(path: string): T {
    return JSON.parse(this.read(path).toString('utf8')) as T
  }
}
