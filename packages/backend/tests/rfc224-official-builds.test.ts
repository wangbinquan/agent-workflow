// RFC-227 regression lock for RFC-224's executable-freezing guarantee:
// administrator-selected bytes are snapshotted and re-attested without any
// OpenCode version/platform allowlist.

import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RUNTIME_OPENCODE_BINARY_ERROR_CODE,
  RuntimeOpencodeBinaryError,
  inspectRuntimeOpencodeBinary,
  snapshotRuntimeOpencodeBinary,
  verifyRuntimeOpencodeSnapshot,
} from '@/services/runtime/opencode/runtimeBinary'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function testRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rfc227-runtime-binary-'))
  roots.push(root)
  return root
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function executableFixture(root: string, contents: string): Promise<string> {
  const path = join(root, 'fixture-opencode')
  await writeFile(path, contents)
  await chmod(path, 0o755)
  return path
}

async function expectUntrusted(
  promise: Promise<unknown>,
  reason?: RuntimeOpencodeBinaryError['reason'],
): Promise<RuntimeOpencodeBinaryError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeOpencodeBinaryError)
    expect(error).toMatchObject({
      code: RUNTIME_OPENCODE_BINARY_ERROR_CODE,
      ...(reason === undefined ? {} : { reason }),
    })
    return error as RuntimeOpencodeBinaryError
  }
  throw new Error('expected runtime binary verification to fail closed')
}

describe('RFC-227 version-neutral OpenCode executable snapshot', () => {
  test('module exposes no static build/version/platform allowlist', async () => {
    const module = await import('@/services/runtime/opencode/runtimeBinary')
    expect('OFFICIAL_OPENCODE_BUILDS' in module).toBe(false)
    expect('requireOfficialOpencodeBuild' in module).toBe(false)
    expect(JSON.stringify(module)).not.toContain('1.18.3')
  })

  test('inspects arbitrary executable bytes without consulting reported version', async () => {
    const root = await testRoot()
    const source = await executableFixture(root, '#!/bin/sh\necho custom-fork-version\n')
    const expected = sha256(await readFile(source))
    await expect(inspectRuntimeOpencodeBinary([source])).resolves.toEqual({
      resolvedPath: await realpath(source),
      digest: expected,
    })
  })

  test('resolves a PATH symlink and executes only a private byte-identical copy', async () => {
    const root = await testRoot()
    const source = await executableFixture(root, '#!/bin/sh\necho version-does-not-matter\n')
    const pathEntry = join(root, 'opencode')
    await symlink(source, pathEntry)
    const digest = sha256(await readFile(source))
    const snapshotPath = join(root, 'private', 'opencode')
    const copiedSources: string[] = []

    const result = await snapshotRuntimeOpencodeBinary(
      { command: ['opencode'], snapshotPath },
      {
        which: (token) => (token === 'opencode' ? pathEntry : null),
        copyFile: async (from, to, mode) => {
          copiedSources.push(from)
          await copyFile(from, to, mode)
        },
      },
    )

    expect(result).toEqual({
      resolvedPath: await realpath(source),
      digest,
      snapshotPath,
    })
    expect(copiedSources).toEqual([await realpath(source)])
    expect(await readFile(snapshotPath, 'utf8')).toContain('version-does-not-matter')
    expect((await lstat(join(root, 'private'))).mode & 0o777).toBe(0o700)
    if (process.platform !== 'win32') {
      expect((await lstat(snapshotPath)).mode & 0o777).toBe(0o500)
    }
    await expect(verifyRuntimeOpencodeSnapshot(snapshotPath, digest)).resolves.toBeUndefined()
  })

  test('accepts an absolute single-token executable and rejects wrapper argv', async () => {
    const root = await testRoot()
    const source = await executableFixture(root, 'arbitrary executable bytes')
    const snapshotPath = join(root, 'absolute', 'opencode')

    await expect(
      snapshotRuntimeOpencodeBinary({ command: [source], snapshotPath }),
    ).resolves.toMatchObject({ snapshotPath })
    await expectUntrusted(
      snapshotRuntimeOpencodeBinary({
        command: ['bun', 'run', source],
        snapshotPath: join(root, 'wrapper', 'opencode'),
      }),
    )
  })

  test('expected digest is a resume/TOCTOU fence, not a release allowlist', async () => {
    const root = await testRoot()
    const source = await executableFixture(root, 'custom release bytes')
    const digest = sha256(await readFile(source))

    await expect(
      snapshotRuntimeOpencodeBinary({
        command: [source],
        snapshotPath: join(root, 'accepted', 'opencode'),
        expectedDigest: digest,
      }),
    ).resolves.toMatchObject({ digest })
    await expectUntrusted(
      snapshotRuntimeOpencodeBinary({
        command: [source],
        snapshotPath: join(root, 'changed', 'opencode'),
        expectedDigest: '0'.repeat(64),
      }),
      'changed',
    )
  })

  test('copy/source races are caught and the rejected snapshot is removed', async () => {
    const root = await testRoot()
    const source = await executableFixture(root, 'bytes before copy')
    const snapshotPath = join(root, 'copy-race', 'opencode')

    await expectUntrusted(
      snapshotRuntimeOpencodeBinary(
        { command: [source], snapshotPath },
        {
          copyFile: async (from, to, mode) => {
            await copyFile(from, to, mode)
            await appendFile(to, '-mutated-copy')
          },
        },
      ),
      'changed',
    )
    expect(await Bun.file(snapshotPath).exists()).toBe(false)

    const sourceRaceSnapshot = join(root, 'source-race', 'opencode')
    await expectUntrusted(
      snapshotRuntimeOpencodeBinary(
        { command: [source], snapshotPath: sourceRaceSnapshot },
        {
          copyFile: async (from, to, mode) => {
            await copyFile(from, to, mode)
            await appendFile(from, '-mutated-source')
          },
        },
      ),
      'changed',
    )
    expect(await Bun.file(sourceRaceSnapshot).exists()).toBe(false)
  })

  test('pre-exec verification detects later bytes, mode, and symlink replacement', async () => {
    const root = await testRoot()
    const source = await executableFixture(root, 'approved snapshot')
    const digest = sha256(await readFile(source))
    const snapshotPath = join(root, 'private', 'opencode')
    await snapshotRuntimeOpencodeBinary({ command: [source], snapshotPath })

    if (process.platform !== 'win32') {
      await chmod(snapshotPath, 0o700)
      await expectUntrusted(verifyRuntimeOpencodeSnapshot(snapshotPath, digest), 'changed')
      await chmod(snapshotPath, 0o500)
    }
    if (process.platform !== 'win32') await chmod(snapshotPath, 0o700)
    await appendFile(snapshotPath, '-later-mutation')
    if (process.platform !== 'win32') await chmod(snapshotPath, 0o500)
    await expectUntrusted(verifyRuntimeOpencodeSnapshot(snapshotPath, digest), 'changed')

    await rm(snapshotPath)
    await symlink(source, snapshotPath)
    await expectUntrusted(verifyRuntimeOpencodeSnapshot(snapshotPath, digest), 'changed')
  })

  test('never overwrites a caller path that already exists', async () => {
    const root = await testRoot()
    const source = await executableFixture(root, 'approved bytes')
    const snapshotPath = join(root, 'private', 'opencode')
    await mkdir(join(root, 'private'), { mode: 0o700 })
    await writeFile(snapshotPath, 'pre-existing sentinel')

    await expectUntrusted(snapshotRuntimeOpencodeBinary({ command: [source], snapshotPath }))
    expect(await readFile(snapshotPath, 'utf8')).toBe('pre-existing sentinel')
  })
})
