// RFC-626 §4.7: `createFileDigestInput` feeds files to a hash through one reused 4 MiB buffer
// instead of a read stream (faster, and bounded whatever the file's size). The backup
// (`freeze/backup.ts`), `sourceFilesDigest` (`sourceReader.ts`) and the epoch-switch file journal
// (`fileJournal.ts`) hash with it. These cases lock that the digest is the one a read stream
// gives, wherever a file's size falls against the buffer, that one input hashing file after
// file keeps their bytes apart, and that a directory digest is the one its read-stream walk gave.
import { afterAll, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSha256DigestBuilder } from '@/platform/contracts/hash'
import {
  createFileDigestInput,
  type FileDigestInput,
} from '@/platform/persistence/migration/fileDigestInput'
import { sourceFilesDigest } from '@/platform/persistence/migration/sourceReader'

/** The input's buffer size (`fileDigestInput.ts`). */
const CHUNK = 4 * 1024 * 1024
const root = mkdtempSync(join(tmpdir(), 'aw-rfc626-digest-input-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const SIZES = {
  empty: 0,
  'shorter than a chunk': 1_000,
  'one byte short of a chunk': CHUNK - 1,
  'exactly one chunk': CHUNK,
  'one byte over a chunk': CHUNK + 1,
  'several chunks and a rest': 2 * CHUNK + 12_345,
} as const
/** A file of `bytes` random bytes: a misplaced or repeated chunk changes its digest. */
function file(name: string, bytes: number): string {
  const path = join(root, name)
  writeFileSync(path, randomBytes(bytes))
  return path
}
/** The digest a read stream gives, chunk by chunk. */
async function streamed(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
/** The digest through `input`, with the hash the production callers use. */
async function through(input: FileDigestInput, path: string): Promise<string> {
  const hash = createSha256DigestBuilder()
  await input.update(hash, path)
  return hash.digestHex()
}

for (const [name, bytes] of Object.entries(SIZES))
  test(`a file ${name} has the digest a read stream gives`, async () => {
    const path = file(`${bytes}.bin`, bytes)
    expect(await through(createFileDigestInput(), path)).toBe(await streamed(path))
  })

test('one input hashing file after file keeps each digest its own', async () => {
  const input = createFileDigestInput()
  const large = file('large.bin', 2 * CHUNK + 77)
  const small = file('small.bin', 333)
  const empty = file('empty.bin', 0)
  const chunk = file('chunk.bin', CHUNK)
  // A small file after a large one must not pick up what the buffer still holds, nor the other
  // way round; the same file hashed again gives the same digest.
  const order = [large, small, chunk, empty, large, small, empty, chunk]
  const digests: string[] = []
  for (const path of order) digests.push(await through(input, path))
  expect(digests).toEqual(await Promise.all(order.map(streamed)))
  expect(new Set(digests).size).toBe(4)
})

test('bytes fed to one hash from several files are the files in order', async () => {
  const input = createFileDigestInput()
  const first = file('first.bin', CHUNK + 5)
  const second = file('second.bin', 17)
  const hash = createSha256DigestBuilder()
  await input.update(hash, first)
  await input.update(hash, second)
  const expected = createHash('sha256')
  for (const path of [first, second])
    for await (const chunk of createReadStream(path)) expected.update(chunk as Buffer)
  expect(hash.digestHex()).toBe(expected.digest('hex'))
})

// `sourceFilesDigest` hashes a whole directory through one input; it lost its import of the
// input once (every backup reader then failed with "createFileDigestInput is not defined").
test('a directory digest is the one read streams give, file after file in name order', async () => {
  const tree = join(root, 'tree')
  mkdirSync(join(tree, 'nested/deeper'), { recursive: true })
  const files = [
    ['b.bin', CHUNK + 9],
    ['a.bin', 0],
    ['nested/deeper/c.bin', 2 * CHUNK],
    ['nested/d.bin', 4_321],
  ] as const
  for (const [name, bytes] of files) writeFileSync(join(tree, name), randomBytes(bytes))
  // The walk of the read-stream implementation it replaced, kept here as the reference.
  const expected = createHash('sha256')
  const visit = async (path: string, relative: string): Promise<void> => {
    const info = statSync(path)
    if (info.isDirectory()) {
      for (const name of readdirSync(path).sort())
        await visit(join(path, name), `${relative}/${name}`)
      return
    }
    expected.update(JSON.stringify([relative, info.size]))
    for await (const chunk of createReadStream(path)) expected.update(chunk as Buffer)
  }
  await visit(tree, '')
  expect(await sourceFilesDigest(tree)).toBe(`sha256:${expected.digest('hex')}`)
})

test('a file that cannot be read is an error, and the input still works afterwards', async () => {
  const input = createFileDigestInput()
  await expect(through(input, join(root, 'absent.bin'))).rejects.toThrow()
  const path = file('after-error.bin', CHUNK + 3)
  expect(await through(input, path)).toBe(await streamed(path))
})
