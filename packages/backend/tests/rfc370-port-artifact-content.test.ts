// RFC-370: archive and fallback rules use one selected content receiver; native helpers stay synchronous.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKTREE_FILE_MAX_BYTES } from '@agent-workflow/shared'
import {
  composePortArtifactOperations,
  selectPortArtifactOperations,
  selectPortArtifactReader,
} from '@/modules/task-execution/composition/portArtifacts'
import type {
  PortArtifactArchiveRequest,
  PortArtifactContentEffects,
  PortArtifactOperations,
  PortArtifactReadRequest,
  PortArtifactReader,
} from '@/modules/task-execution/application/ports/portArtifactContent'
import {
  archivePortArtifacts,
  readPortArtifact,
  readInsideRoot,
  truncationNotice,
  parseArchiveJson,
} from '@/services/portArtifacts'
import { archivePortArtifacts as publicArchive } from '@/modules/task-execution/public/commands'
import { readPortArtifact as publicRead } from '@/modules/task-execution/public/queries'
import { readInsideRoot as nativeReadInsideRoot } from '@/platform/content/local/rootFileQueries'
import { held, callablePromise, MemoryPortArtifactContent } from './helpers/portArtifactContent'

const source = Object.freeze({
  workspaceRef: 'workspace:opaque',
  relativePath: 'report.md',
  generation: 'g7',
  version: 'v3',
})
function archiveRequest(): PortArtifactArchiveRequest {
  return {
    taskId: 'task',
    nodeRunId: 'run',
    portName: 'report',
    items: [{ source, sourcePath: 'report.md' }],
    worktreeDirName: 'repo0',
  }
}
function readRequest(archiveJson: string | null): PortArtifactReadRequest {
  return {
    taskId: 'task',
    archiveJson,
    content: 'report.md',
    kind: 'path<md>',
    fallbackWorkspaceRef: null,
  }
}

function archiveRoster() {
  return JSON.stringify({
    v: 1,
    items: [
      { path: 'repo0/a.md', file: 'object:a', size: 20, truncated: false },
      { path: 'repo0/b.md', file: 'object:b', size: 30, truncated: true },
      { path: 'repo0/c.bin', file: null, size: 40, truncated: true },
    ],
  })
}

describe('RFC-370 port artifact content', () => {
  test('frozen prototype effects retain private state, opaque references and the source binding', async () => {
    const content = Object.freeze(new MemoryPortArtifactContent())
    const bytes = Buffer.from('selected UTF-8 内容\0binary')
    content.put(source, bytes)
    const operations = composePortArtifactOperations(content, '/never-used-native-home')
    const stored = await operations.archive(archiveRequest())
    const roster = parseArchiveJson(stored.archiveJson)!
    expect(roster).toEqual({
      v: 1,
      items: [
        {
          path: join('repo0', 'report.md'),
          file: 'object:task/run/report/0.md',
          size: bytes.length,
          truncated: false,
        },
      ],
    })
    expect(stored.portFilePaths).toEqual(['report.md'])
    expect(content.sources).toEqual([source])
    const result = await operations.read(readRequest(stored.archiveJson))
    expect(result.items[0]).toMatchObject({
      body: bytes.toString('utf8'),
      source: 'archive',
      size: bytes.length,
      truncated: false,
    })
    expect(Array.from(result.items[0]!.bytes)).toEqual(Array.from(bytes))
    expect(content.calls).toEqual([
      'prepare:report',
      'size:report.md',
      'reference:0',
      'copy:report.md',
      'copy-ack',
      'link:report.md',
      'read:object:task/run/report/0.md',
    ])
  })

  test('the exact 2MiB boundary copies bytes and oversized text uses the original sample, prefix and notice', async () => {
    const content = Object.freeze(new MemoryPortArtifactContent())
    content.put(source, Buffer.alloc(WORKTREE_FILE_MAX_BYTES, 120))
    const operations = composePortArtifactOperations(content)
    expect(
      parseArchiveJson((await operations.archive(archiveRequest())).archiveJson)!.items[0]!
        .truncated,
    ).toBe(false)
    expect(content.calls.filter((c) => c.startsWith('prefix:'))).toEqual([])
    const text = Buffer.from('界'.repeat(Math.ceil((WORKTREE_FILE_MAX_BYTES + 1) / 3)))
    content.put(source, text)
    content.calls.length = 0
    const stored = await operations.archive(archiveRequest())
    expect(content.calls.filter((c) => c.startsWith('prefix:'))).toEqual([
      'prefix:8192',
      'prefix:' + WORKTREE_FILE_MAX_BYTES,
    ])
    expect(parseArchiveJson(stored.archiveJson)!.items[0]).toMatchObject({
      size: text.length,
      truncated: true,
      file: 'object:task/run/report/0.md',
    })
    const expected = Buffer.concat([
      text.subarray(0, WORKTREE_FILE_MAX_BYTES),
      Buffer.from(truncationNotice(join('repo0', 'report.md'))),
    ])
    expect(Buffer.from(content.archives.get('object:task/run/report/0.md')!)).toEqual(expected)
  })

  test('oversized binary skips the copy while retaining the original roster and metadata target', async () => {
    const content = Object.freeze(new MemoryPortArtifactContent())
    const binary = Buffer.alloc(8192, 120)
    binary[8191] = 0
    content.put(source, binary)
    content.sizes.set(content.key(source), WORKTREE_FILE_MAX_BYTES + 1)
    content.links.set(content.key(source), { kind: 'inside', relativePath: 'ignored/target.bin' })
    const result = await composePortArtifactOperations(content).archive(archiveRequest())
    expect(parseArchiveJson(result.archiveJson)).toEqual({
      v: 1,
      items: [
        {
          path: join('repo0', 'report.md'),
          file: null,
          size: WORKTREE_FILE_MAX_BYTES + 1,
          truncated: true,
          linkTarget: join('repo0', 'ignored', 'target.bin'),
        },
      ],
    })
    expect(result.portFilePaths).toEqual(['report.md', 'ignored/target.bin'])
    expect(content.archives.size).toBe(0)
    expect(content.calls).toEqual([
      'prepare:report',
      'size:report.md',
      'reference:0',
      'prefix:8192',
      'link:report.md',
    ])
  })

  test('missing or rejected archive reads fall back to the selected workspace and then missing', async () => {
    const reason = Object.create(null)
    const content = Object.freeze(
      new MemoryPortArtifactContent({ read: () => Promise.reject(reason) }),
    )
    content.put(
      { workspaceRef: 'workspace:fallback', relativePath: 'repo0/a.md' },
      Buffer.from('workspace body'),
    )
    const result = await composePortArtifactOperations(content).read({
      ...readRequest(archiveRoster()),
      fallbackWorkspaceRef: 'workspace:fallback',
    })
    expect(result.items.map((it) => it.source)).toEqual(['worktree', 'missing', 'missing'])
    expect(result.items[0]).toMatchObject({ body: 'workspace body', size: 20, truncated: false })
    expect(content.sources.map((it) => it.workspaceRef)).toEqual([
      'workspace:fallback',
      'workspace:fallback',
      'workspace:fallback',
    ])
    expect(result.items[1]).toMatchObject({ body: '', size: 30, truncated: true })
  })

  test('meta reads no bytes and numeric only reads the requested item in the same order', async () => {
    const content = Object.freeze(new MemoryPortArtifactContent())
    content.archives.set('object:a', Buffer.from('A'))
    content.archives.set('object:b', Buffer.from('B'))
    content.put(
      { workspaceRef: 'workspace:fallback', relativePath: 'repo0/c.bin' },
      Buffer.from('C'),
    )
    const operations = composePortArtifactOperations(content)
    const request = { ...readRequest(archiveRoster()), fallbackWorkspaceRef: 'workspace:fallback' }
    const meta = await operations.read({ ...request, only: 'meta' })
    expect(meta.items.map((it) => [it.path, it.source, it.body, it.bytes.length])).toEqual([
      ['repo0/a.md', 'archive', '', 0],
      ['repo0/b.md', 'archive', '', 0],
      ['repo0/c.bin', 'worktree', '', 0],
    ])
    expect(content.calls).toEqual([
      'exists:object:a',
      'exists:object:b',
      'workspace-exists:repo0/c.bin',
    ])
    content.calls.length = 0
    const selected = await operations.read({ ...request, only: 1 })
    expect(selected.items.map((it) => it.body)).toEqual(['', 'B', ''])
    expect(content.calls).toEqual([
      'exists:object:a',
      'read:object:b',
      'workspace-exists:repo0/c.bin',
    ])
  })

  test('legacy path/list codecs, repo prefix and inline content preserve the original results', async () => {
    const content = Object.freeze(new MemoryPortArtifactContent())
    content.put(
      { workspaceRef: 'workspace:legacy', relativePath: join('repo', 'a.md') },
      Buffer.from('A'),
    )
    content.put(
      { workspaceRef: 'workspace:legacy', relativePath: join('repo', 'b.md') },
      Buffer.from('B'),
    )
    const operations = composePortArtifactOperations(content)
    const result = await operations.read({
      ...readRequest(null),
      kind: 'list<path<md>>',
      content: 'a.md\nb.md',
      fallbackWorkspaceRef: 'workspace:legacy',
      legacyRepoDirName: 'repo',
    })
    expect(result.items.map((it) => [it.path, it.body, it.source])).toEqual([
      [join('repo', 'a.md'), 'A', 'worktree'],
      [join('repo', 'b.md'), 'B', 'worktree'],
    ])
    content.calls.length = 0
    const inline = await operations.read({
      ...readRequest('{invalid'),
      kind: 'text',
      content: '内联\0',
      only: 'meta',
    })
    expect(inline.items[0]).toMatchObject({
      path: null,
      body: '内联\0',
      size: Buffer.byteLength('内联\0'),
      source: 'archive',
    })
    expect(content.calls).toEqual([])
  })

  test('object and callable Promise ACKs hold archive and read results until durable completion', async () => {
    for (const wrap of [(promise: Promise<void>) => promise, callablePromise<void>]) {
      const entered = held<void>(),
        ack = held<void>()
      const content = Object.freeze(
        new MemoryPortArtifactContent({
          copy: () => {
            entered.resolve(undefined)
            return wrap(ack.promise)
          },
        }),
      )
      content.put(source, Buffer.from('body'))
      const operations = composePortArtifactOperations(content)
      let settled = false
      const pending = operations.archive(archiveRequest()).then((result) => {
        settled = true
        return result
      })
      try {
        await entered.promise
        expect(settled).toBe(false)
        expect(content.archives.size).toBe(0)
        ack.resolve(undefined)
        expect((await pending).portFilePaths).toEqual(['report.md'])
      } finally {
        ack.resolve(undefined)
        await pending
      }
      const readEntered = held<void>(),
        readAck = held<void>()
      const reader = Object.freeze(
        new MemoryPortArtifactContent({
          read: () => {
            readEntered.resolve(undefined)
            return wrap(readAck.promise)
          },
        }),
      )
      reader.archives.set('object:a', Buffer.from('acknowledged'))
      let readSettled = false
      const reading = composePortArtifactOperations(reader)
        .read(
          readRequest(
            JSON.stringify({
              v: 1,
              items: [{ path: 'a.md', file: 'object:a', size: 12, truncated: false }],
            }),
          ),
        )
        .then((result) => {
          readSettled = true
          return result
        })
      try {
        await readEntered.promise
        expect(readSettled).toBe(false)
        readAck.resolve(undefined)
        expect((await reading).items[0]!.body).toBe('acknowledged')
      } finally {
        readAck.resolve(undefined)
        await reading
      }
    }
  })

  test('synchronous and asynchronous content failures propagate while metadata failure stays nonfatal', async () => {
    const reason = new Error('transport failed')
    for (const fail of [
      () => {
        throw reason
      },
      () => Promise.reject(reason),
    ]) {
      const content = Object.freeze(new MemoryPortArtifactContent({ copy: fail }))
      content.put(source, Buffer.from('body'))
      await expect(composePortArtifactOperations(content).archive(archiveRequest())).rejects.toBe(
        reason,
      )
    }
    class FailedMetadata extends MemoryPortArtifactContent {
      override async linkTarget(): Promise<never> {
        throw reason
      }
    }
    const content = Object.freeze(new FailedMetadata())
    content.put(source, Buffer.from('body'))
    expect(
      (await composePortArtifactOperations(content).archive(archiveRequest())).portFilePaths,
    ).toEqual(['report.md'])
  })

  test('explicit null or partial selections are rejected whole, while preselected receivers retain identity', async () => {
    for (const value of [null, {}, { reference: () => 'object:partial' }]) {
      expect(() =>
        composePortArtifactOperations(value as unknown as PortArtifactContentEffects),
      ).toThrow('complete content effects receiver')
    }
    for (const value of [null, {}, { read: async () => ({ items: [] }) }]) {
      expect(() =>
        selectPortArtifactOperations(value as unknown as PortArtifactOperations),
      ).toThrow('complete operations')
    }
    expect(() => selectPortArtifactReader(null as unknown as PortArtifactReader)).toThrow(
      'complete reader',
    )
    class Operations implements PortArtifactOperations {
      #body = 'receiver body'
      async archive() {
        return { archiveJson: '{"v":1,"items":[]}', portFilePaths: [] }
      }
      async read() {
        return {
          items: [
            {
              path: null,
              body: this.#body,
              bytes: Buffer.from(this.#body),
              size: this.#body.length,
              truncated: false,
              source: 'archive' as const,
            },
          ],
        }
      }
    }
    const receiver = Object.freeze(new Operations())
    expect(selectPortArtifactOperations(receiver)).toBe(receiver)
    expect(selectPortArtifactReader(receiver)).toBe(receiver)
    expect((await selectPortArtifactReader(receiver).read(readRequest(null))).items[0]!.body).toBe(
      'receiver body',
    )
  })

  test('native construction performs no IO; sync helpers preserve original sourceAbs and repeat overwrite', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-port-native-'))
    try {
      const appHome = join(root, 'not-created'),
        wt = join(root, 'wt')
      const selected = composePortArtifactOperations(undefined, appHome)
      expect(existsSync(appHome)).toBe(false)
      mkdirSync(wt)
      const original = join(root, 'actual-source.md')
      writeFileSync(original, 'from explicit sourceAbs')
      writeFileSync(join(wt, 'report.md'), 'from relative workspace binding')
      // Keep the legacy Buffer contract, including its byte methods, through the exact public query.
      const publicBytes: Buffer | null = nativeReadInsideRoot(wt, 'report.md')
      const legacyBytes: Buffer | null = readInsideRoot(wt, 'report.md')
      expect(nativeReadInsideRoot).toBe(readInsideRoot)
      expect(Buffer.isBuffer(publicBytes)).toBe(true)
      expect(publicBytes?.equals(legacyBytes!)).toBe(true)
      expect(publicBytes?.toString('utf8')).toBe('from relative workspace binding')
      const legacy = archivePortArtifacts({
        taskId: 'task',
        nodeRunId: 'run',
        portName: 'report',
        appHome,
        items: [{ sourceAbs: original, sourcePath: 'report.md' }],
        worktreeDirName: '',
        worktreeRootAbs: wt,
      })
      const file = parseArchiveJson(legacy.archiveJson)!.items[0]!.file!
      expect(readFileSync(join(appHome, file), 'utf8')).toBe('from explicit sourceAbs')
      expect(
        readPortArtifact({
          ...readRequest(legacy.archiveJson),
          appHome,
          fallbackWorktreeRoot: null,
        }).items[0]!.body,
      ).toBe('from explicit sourceAbs')
      const asyncResult = await selected.archive({
        ...archiveRequest(),
        worktreeDirName: '',
        items: [
          { source: { workspaceRef: wt, relativePath: 'report.md' }, sourcePath: 'report.md' },
        ],
      })
      expect(parseArchiveJson(asyncResult.archiveJson)!.items[0]!.file).toBe(file)
      expect((await selected.read(readRequest(asyncResult.archiveJson))).items[0]!.body).toBe(
        'from relative workspace binding',
      )
      expect(
        readPortArtifact({
          ...readRequest(asyncResult.archiveJson),
          appHome,
          fallbackWorktreeRoot: null,
        }).items[0]!.body,
      ).toBe('from relative workspace binding')
      expect(publicArchive).toBe(archivePortArtifacts)
      expect(publicRead).toBe(readPortArtifact)
      expect(
        parseArchiveJson((await selected.archive({ ...archiveRequest(), items: [] })).archiveJson),
      ).toEqual({ v: 1, items: [] })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
