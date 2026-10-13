// Read immutable Git objects in the primary checkout. No alternate index,
// checkout, worktree or copy of a working tree is created.
import { spawnSync } from 'node:child_process'
import { sourceUnit } from '../../packages/backend/tests/architecture/census'

export function readCommittedArchitectureSource(repoRoot: string, ref: string) {
  const revision = spawnSync('git', ['rev-parse', `${ref}^{commit}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (revision.status !== 0) throw new Error('architecture source revision is unavailable')
  const sourceSha = revision.stdout.trim()
  const listing = spawnSync(
    'git',
    [
      'ls-tree',
      '-r',
      '-z',
      '--name-only',
      sourceSha,
      '--',
      'packages/backend/src',
      'packages/shared/src',
      'packages/frontend/src',
    ],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (listing.status !== 0) throw new Error('architecture source listing failed')
  const paths = listing.stdout
    .split('\0')
    .filter((path) => /\.[cm]?tsx?$/.test(path))
    .sort()
  const extras = [
    '.dependency-cruiser.cjs',
    'scripts/depcheck.ts',
    'packages/backend/tests/architecture/rfc294-canonical-manifests.test.ts',
  ]
  const all = [...paths, ...extras]
  const result = spawnSync('git', ['cat-file', '--batch'], {
    cwd: repoRoot,
    input: all.map((path) => `${sourceSha}:${path}\n`).join(''),
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error('architecture source object read failed')
  const texts = new Map<string, string>()
  let offset = 0
  for (const path of all) {
    const newline = result.stdout.indexOf(10, offset)
    if (newline < 0) throw new Error('architecture source object header is incomplete')
    const header = result.stdout.subarray(offset, newline).toString('utf8')
    offset = newline + 1
    if (header.endsWith(' missing')) continue
    const [, type, sizeText] = header.split(' '),
      size = Number(sizeText)
    if (
      type !== 'blob' ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + size >= result.stdout.length
    )
      throw new Error('architecture source object body is incomplete')
    texts.set(path, result.stdout.subarray(offset, offset + size).toString('utf8'))
    offset += size + 1
  }
  return {
    sourceSha,
    units: paths.map((path) => {
      const text = texts.get(path)
      if (text === undefined) throw new Error('architecture production source is missing: ' + path)
      return sourceUnit(path, text)
    }),
    readText: (path: string) => texts.get(path),
  }
}
