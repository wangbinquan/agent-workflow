// RFC-224 regression lock: a self-reported opencode version is not execution
// identity. Only an exact official executable digest may be copied into the
// private run snapshot, and every later exec must re-verify that snapshot.

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
  OFFICIAL_OPENCODE_BINARY_ERROR_CODE,
  OFFICIAL_OPENCODE_BUILD_CODEC,
  OfficialOpencodeBinaryError,
  type OfficialOpencodeArch,
  type OfficialOpencodeBuild,
  type OfficialOpencodePlatform,
  requireOfficialOpencodeBuild,
  snapshotOfficialOpencodeBinary,
  verifyOfficialSnapshot,
} from '@/services/runtime/opencode/officialBuilds'
import { OPENCODE_FFF_CAPABILITY_CODEC } from '@/services/runtime/opencode/hermetic'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function testRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rfc224-official-build-'))
  roots.push(root)
  return root
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const TEST_PLATFORM: OfficialOpencodePlatform = process.platform === 'darwin' ? 'darwin' : 'linux'
const TEST_ARCH: OfficialOpencodeArch = process.arch === 'arm64' ? 'arm64' : 'x64'

function fixtureBuild(
  digest: string,
  overrides: Partial<OfficialOpencodeBuild> = {},
): OfficialOpencodeBuild {
  return {
    platform: TEST_PLATFORM,
    arch: TEST_ARCH,
    version: '1.18.3',
    digest,
    codec: OFFICIAL_OPENCODE_BUILD_CODEC,
    fffCapabilityCodec: OPENCODE_FFF_CAPABILITY_CODEC,
    ...overrides,
  }
}

async function executableFixture(root: string, contents: string): Promise<string> {
  const path = join(root, 'fixture-opencode')
  await writeFile(path, contents)
  await chmod(path, 0o755)
  return path
}

async function expectUntrusted(promise: Promise<unknown>): Promise<OfficialOpencodeBinaryError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(OfficialOpencodeBinaryError)
    expect(error).toMatchObject({ code: OFFICIAL_OPENCODE_BINARY_ERROR_CODE })
    return error as OfficialOpencodeBinaryError
  }
  throw new Error('expected official binary verification to fail closed')
}

describe('RFC-224 official opencode build allowlist', () => {
  test('contains one immutable exact v1.18.3 tuple per supported platform and arch', async () => {
    const module = await import('@/services/runtime/opencode/officialBuilds')
    expect(module.OFFICIAL_OPENCODE_BUILDS).toEqual([
      {
        platform: 'darwin',
        arch: 'arm64',
        version: '1.18.3',
        digest: '43f7083d450567706a80b6441331a25b5ed6d6c9f742826790545b068229cbb2',
        codec: 1,
        fffCapabilityCodec: 1,
      },
      {
        platform: 'darwin',
        arch: 'x64',
        version: '1.18.3',
        digest: 'ba11415d6af7efc9dc0073520d546b869711da5f39076d12e08eeb266ba1279b',
        codec: 1,
        fffCapabilityCodec: 1,
      },
      {
        platform: 'linux',
        arch: 'arm64',
        version: '1.18.3',
        digest: '915ca1cd9eb5a7b3e15bd89dc71c38cf0caa9a02d13c5371422675b4b370bffb',
        codec: 1,
        fffCapabilityCodec: 1,
      },
      {
        platform: 'linux',
        arch: 'x64',
        version: '1.18.3',
        digest: 'fdf58364c969a144fff0ae3a30f2fb6e705ada06864842613de1f9ecc70feb20',
        codec: 1,
        fffCapabilityCodec: 1,
      },
    ])
    expect(Object.isFrozen(module.OFFICIAL_OPENCODE_BUILDS)).toBe(true)
    expect(module.OFFICIAL_OPENCODE_BUILDS.every((build) => Object.isFrozen(build))).toBe(true)
  })

  test('rejects an ambiguous injected tuple instead of selecting the first row', () => {
    const build = fixtureBuild('a'.repeat(64))
    expect(() =>
      requireOfficialOpencodeBuild('1.18.3', TEST_PLATFORM, TEST_ARCH, [build, { ...build }]),
    ).toThrow(OfficialOpencodeBinaryError)
  })

  test('rejects unsupported platform, arch, version, codec, and malformed digest with one code', () => {
    const valid = fixtureBuild('a'.repeat(64))
    const cases: Array<() => unknown> = [
      () => requireOfficialOpencodeBuild('1.18.3', 'win32', TEST_ARCH, [valid]),
      () => requireOfficialOpencodeBuild('1.18.3', TEST_PLATFORM, 'riscv64', [valid]),
      () => requireOfficialOpencodeBuild('1.18.4', TEST_PLATFORM, TEST_ARCH, [valid]),
      () =>
        requireOfficialOpencodeBuild('1.18.3', TEST_PLATFORM, TEST_ARCH, [
          { ...valid, codec: 2 } as unknown as OfficialOpencodeBuild,
        ]),
      () =>
        requireOfficialOpencodeBuild('1.18.3', TEST_PLATFORM, TEST_ARCH, [
          { ...valid, fffCapabilityCodec: 2 } as unknown as OfficialOpencodeBuild,
        ]),
      () =>
        requireOfficialOpencodeBuild('1.18.3', TEST_PLATFORM, TEST_ARCH, [
          { ...valid, digest: 'not-a-sha256' },
        ]),
    ]
    for (const invoke of cases) {
      try {
        invoke()
        throw new Error('expected allowlist tuple rejection')
      } catch (error) {
        expect(error).toMatchObject({ code: OFFICIAL_OPENCODE_BINARY_ERROR_CODE })
      }
    }
  })
})

describe('RFC-224 official opencode snapshot', () => {
  test('resolves a PATH symlink, streams/copies its real target, and returns only the snapshot path', async () => {
    const root = await testRoot()
    const source = await executableFixture(root, '#!/bin/sh\necho official-fixture\n')
    const pathEntry = join(root, 'opencode')
    await symlink(source, pathEntry)
    const digest = sha256(await readFile(source))
    const snapshotPath = join(root, 'private', 'opencode')
    const copiedSources: string[] = []

    const result = await snapshotOfficialOpencodeBinary(
      {
        command: ['opencode'],
        version: '1.18.3',
        snapshotPath,
        platform: TEST_PLATFORM,
        arch: TEST_ARCH,
      },
      {
        builds: [fixtureBuild(digest)],
        which: (token) => (token === 'opencode' ? pathEntry : null),
        copyFile: async (from, to, mode) => {
          copiedSources.push(from)
          await copyFile(from, to, mode)
        },
      },
    )

    expect(result).toBe(snapshotPath)
    expect(typeof result).toBe('string')
    expect(result).not.toContain(source)
    expect(copiedSources).toEqual([await realpath(source)])
    expect(await readFile(snapshotPath, 'utf8')).toBe('#!/bin/sh\necho official-fixture\n')
    expect((await lstat(join(root, 'private'))).mode & 0o777).toBe(0o700)
    expect((await lstat(snapshotPath)).mode & 0o777).toBe(0o500)
    await expect(verifyOfficialSnapshot(snapshotPath, digest)).resolves.toBeUndefined()
  })

  test('accepts an absolute single-token executable and rejects wrapper command heads', async () => {
    const root = await testRoot()
    const source = await executableFixture(root, 'small official fixture')
    const digest = sha256(await readFile(source))
    const builds = [fixtureBuild(digest)]

    await expect(
      snapshotOfficialOpencodeBinary(
        {
          command: [source],
          version: '1.18.3',
          snapshotPath: join(root, 'absolute-snapshot', 'opencode'),
          platform: TEST_PLATFORM,
          arch: TEST_ARCH,
        },
        { builds },
      ),
    ).resolves.toBe(join(root, 'absolute-snapshot', 'opencode'))

    await expectUntrusted(
      snapshotOfficialOpencodeBinary(
        {
          command: ['bun', 'run', source],
          version: '1.18.3',
          snapshotPath: join(root, 'wrapper-snapshot', 'opencode'),
          platform: TEST_PLATFORM,
          arch: TEST_ARCH,
        },
        { builds },
      ),
    )
  })

  test('rejects a fake that reports the allowed version without a production digest match', async () => {
    const root = await testRoot()
    const secret = 'FAKE_BINARY_PRIVATE_CONTENT_224'
    const source = await executableFixture(root, `#!/bin/sh\necho 1.18.3\n# ${secret}\n`)
    const snapshotPath = join(root, 'must-not-exist', 'opencode')

    const error = await expectUntrusted(
      snapshotOfficialOpencodeBinary({
        command: [source],
        version: '1.18.3',
        snapshotPath,
        platform: TEST_PLATFORM,
        arch: TEST_ARCH,
      }),
    )

    expect(error.message).not.toContain(secret)
    expect(error.message).not.toContain(source)
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(await Bun.file(snapshotPath).exists()).toBe(false)
  })

  test('fails closed for wrong platform, arch, or source digest', async () => {
    const root = await testRoot()
    const source = await executableFixture(root, 'fixture bytes')
    const digest = sha256(await readFile(source))
    const base = {
      command: [source],
      version: '1.18.3',
      snapshotPath: join(root, 'snapshot', 'opencode'),
    } as const

    await expectUntrusted(
      snapshotOfficialOpencodeBinary(
        { ...base, platform: 'win32', arch: TEST_ARCH },
        { builds: [fixtureBuild(digest)] },
      ),
    )
    await expectUntrusted(
      snapshotOfficialOpencodeBinary(
        { ...base, platform: TEST_PLATFORM, arch: 'riscv64' },
        { builds: [fixtureBuild(digest)] },
      ),
    )
    await expectUntrusted(
      snapshotOfficialOpencodeBinary(
        { ...base, platform: TEST_PLATFORM, arch: TEST_ARCH },
        { builds: [fixtureBuild('0'.repeat(64))] },
      ),
    )
  })

  test('re-hash catches mutation performed by the copy step and removes the rejected snapshot', async () => {
    const root = await testRoot()
    const source = await executableFixture(root, 'approved before copy')
    const digest = sha256(await readFile(source))
    const snapshotPath = join(root, 'copy-race', 'opencode')

    await expectUntrusted(
      snapshotOfficialOpencodeBinary(
        {
          command: [source],
          version: '1.18.3',
          snapshotPath,
          platform: TEST_PLATFORM,
          arch: TEST_ARCH,
        },
        {
          builds: [fixtureBuild(digest)],
          copyFile: async (from, to, mode) => {
            await copyFile(from, to, mode)
            await appendFile(to, '-mutated-during-copy')
          },
        },
      ),
    )

    expect(await Bun.file(snapshotPath).exists()).toBe(false)
  })

  test('independent pre-exec verification detects later bytes, mode, and symlink replacement', async () => {
    const root = await testRoot()
    const source = await executableFixture(root, 'approved snapshot')
    const digest = sha256(await readFile(source))
    const snapshotPath = join(root, 'private', 'opencode')
    await snapshotOfficialOpencodeBinary(
      {
        command: [source],
        version: '1.18.3',
        snapshotPath,
        platform: TEST_PLATFORM,
        arch: TEST_ARCH,
      },
      { builds: [fixtureBuild(digest)] },
    )

    await chmod(snapshotPath, 0o700)
    await expectUntrusted(verifyOfficialSnapshot(snapshotPath, digest))

    await chmod(snapshotPath, 0o500)
    await expect(verifyOfficialSnapshot(snapshotPath, digest)).resolves.toBeUndefined()
    await chmod(snapshotPath, 0o700)
    await appendFile(snapshotPath, '-later-mutation')
    await chmod(snapshotPath, 0o500)
    await expectUntrusted(verifyOfficialSnapshot(snapshotPath, digest))

    await rm(snapshotPath)
    await symlink(source, snapshotPath)
    await expectUntrusted(verifyOfficialSnapshot(snapshotPath, digest))
  })

  test('never overwrites a caller path that already exists', async () => {
    const root = await testRoot()
    const source = await executableFixture(root, 'approved bytes')
    const digest = sha256(await readFile(source))
    const snapshotPath = join(root, 'private', 'opencode')
    await mkdir(join(root, 'private'), { mode: 0o700 })
    await writeFile(snapshotPath, 'pre-existing sentinel')

    await expectUntrusted(
      snapshotOfficialOpencodeBinary(
        {
          command: [source],
          version: '1.18.3',
          snapshotPath,
          platform: TEST_PLATFORM,
          arch: TEST_ARCH,
        },
        { builds: [fixtureBuild(digest)] },
      ),
    )
    expect(await readFile(snapshotPath, 'utf8')).toBe('pre-existing sentinel')
  })
})
