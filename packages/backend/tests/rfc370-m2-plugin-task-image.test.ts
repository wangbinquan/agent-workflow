import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeTaskImagePlugin } from '@/modules/resource-catalog/composition/taskImagePlugin'
import { retainWorkVolumeWriter } from '@/platform/crewstation/workVolumeWriters'
import { PLUGIN_GENERATION_MANIFEST } from '@/modules/resource-catalog/infrastructure/local/filePluginInstallation'

test('plugin material captures dependencies, modes and safe links, and replays a durable generation receipt', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rfc370-plugin-image-')))
  try {
    const source = join(root, 'source')
    mkdirSync(join(source, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(source, 'index.js'), 'export default {}')
    writeFileSync(join(source, 'node_modules', 'dep', 'index.js'), 'export default 1', {
      mode: 0o755,
    })
    if (process.platform !== 'win32')
      symlinkSync('node_modules/dep/index.js', join(source, 'link.js'))
    const request = {
      method: 'install',
      pluginId: 'plugin',
      generationId: 'generation',
      spec: `file:${source}`,
    }
    const result = await executeTaskImagePlugin(request, undefined, root)
    expect(result!.sourceKind).toBe('file')
    expect(
      result!.files.some(
        (file) => file.path === 'node_modules/dep/index.js' && file.kind === 'file',
      ),
    ).toBe(true)
    if (process.platform !== 'win32')
      expect(result!.files).toContainEqual({
        kind: 'symlink',
        path: 'link.js',
        target: 'node_modules/dep/index.js',
      })
    expect(await executeTaskImagePlugin(request, undefined, root)).toEqual(result)
    await expect(
      executeTaskImagePlugin({ ...request, spec: `file:${source}/index.js` }, undefined, root),
    ).rejects.toThrow('request-changed')
    expect(
      JSON.parse(
        readFileSync(join(root, 'plugin-receipts', 'plugin', 'generation', 'result.json'), 'utf8'),
      ),
    ).toEqual({
      digest: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
      result,
    })
    await executeTaskImagePlugin(
      { method: 'discard', pluginId: 'plugin', generationId: 'generation' },
      undefined,
      root,
    )
    expect(readFileSync(join(source, 'index.js'), 'utf8')).toBe('export default {}')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('plugin cleanup cannot remove an unresolved writer; file sources stay inside the task volume', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rfc370-plugin-guard-')))
  try {
    const writer = retainWorkVolumeWriter(
      root,
      'unsettled-install',
      join(root, 'plugins', 'plugin', 'generations', 'generation'),
    )
    await expect(
      executeTaskImagePlugin(
        { method: 'discard', pluginId: 'plugin', generationId: 'generation' },
        undefined,
        root,
      ),
    ).rejects.toThrow('writer-not-settled')
    writer.release()
    await expect(
      executeTaskImagePlugin(
        {
          method: 'install',
          pluginId: 'plugin',
          generationId: 'other',
          spec: 'file:/outside/volume.js',
        },
        undefined,
        root,
      ),
    ).rejects.toThrow('outside-work-volume')
    if (process.platform !== 'win32') {
      const source = join(root, 'source')
      mkdirSync(source)
      writeFileSync(join(source, 'index.js'), 'export default {}')
      symlinkSync('../../outside.js', join(source, 'escape.js'))
      await expect(
        executeTaskImagePlugin(
          { method: 'install', pluginId: 'plugin', generationId: 'unsafe', spec: `file:${source}` },
          undefined,
          root,
        ),
      ).rejects.toThrow('link-outside-generation')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a completed native installation survives interruption before the helper receipt without running npm again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rfc370-plugin-complete-'))
  try {
    const generation = join(root, 'plugins', 'plugin', 'generations', 'generation')
    mkdirSync(join(generation, 'node_modules', 'fixture'), { recursive: true })
    writeFileSync(join(generation, 'node_modules', 'fixture', 'index.js'), 'export default {}')
    writeFileSync(
      join(generation, PLUGIN_GENERATION_MANIFEST),
      JSON.stringify({
        version: 1,
        completed: true,
        pluginId: 'plugin',
        opId: 'generation',
        sourceKind: 'npm',
        requestedSpec: 'fixture@1',
        entryRelativePath: 'node_modules/fixture',
        resolvedVersion: '1.0.0',
        sourceIdentity: 'npm:https://registry.example/fixture.tgz\nsha512-fixture',
        resolved: 'https://registry.example/fixture.tgz',
        integrity: 'sha512-fixture',
        commit: null,
        createdAt: 1,
      }),
    )
    const result = await executeTaskImagePlugin(
      { method: 'install', pluginId: 'plugin', generationId: 'generation', spec: 'fixture@1' },
      undefined,
      root,
    )
    expect(result!.sourceIdentity).toBe('npm:https://registry.example/fixture.tgz\nsha512-fixture')
    expect(result!.entry).toBe('node_modules/fixture')
    expect(result!.files.some((file) => file.path === 'node_modules/fixture/index.js')).toBe(true)
    await expect(
      executeTaskImagePlugin(
        { method: 'install', pluginId: 'plugin', generationId: 'generation', spec: 'changed@1' },
        undefined,
        root,
      ),
    ).rejects.toThrow('request-changed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
