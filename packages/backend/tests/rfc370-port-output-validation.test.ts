// RFC-370: selected validation must retain the original rules, ordering and error payloads.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  composePortOutputContentValidation,
  createNativePortOutputValidationContent,
} from '@/modules/task-execution/composition/portOutputValidation'
import type { PortOutputValidationContent } from '@/modules/task-execution/application/ports/portOutputValidation'
import {
  NODE_VALIDATE_IO,
  PortValidationError,
  resolvePortContent,
  resolvePortContentDetailed,
} from '@/services/envelope'

function held<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const workspaceRef = 'workspace:remote-g17'
function noReadContent(): PortOutputValidationContent {
  return {
    resolve() {
      throw new Error('unexpected resolution')
    },
    readUtf8() {
      throw new Error('unexpected read')
    },
  }
}

describe('RFC-370 selected port output validation', () => {
  test('requires a complete receiver without invoking either method at construction', () => {
    const content = noReadContent()
    expect(typeof composePortOutputContentValidation(content).resolve).toBe('function')
    for (const value of [undefined, null, {}, { resolve() {} }, { readUtf8() {} }]) {
      expect(() =>
        composePortOutputContentValidation(value as unknown as PortOutputValidationContent),
      ).toThrow('Port output validation requires a complete content receiver')
    }
  })

  test('awaits the selected resolution and read with original receivers and opaque refs', async () => {
    const resolveStarted = held<void>()
    const readStarted = held<void>()
    const resolution = held<{ targetRef: string; relativePath: string; insideWorkspace: boolean }>()
    const read = held<string>()
    const calls: string[] = []
    const content: PortOutputValidationContent = {
      resolve(ref, raw) {
        expect(this).toBe(content)
        expect(ref).toBe(workspaceRef)
        calls.push(`resolve:${raw}`)
        resolveStarted.release()
        return resolution.promise
      },
      readUtf8(ref) {
        expect(this).toBe(content)
        expect(ref).toBe('content:remote-v3')
        calls.push(`read:${ref}`)
        readStarted.release()
        return read.promise
      },
    }
    const validation = composePortOutputContentValidation(content)
    expect(calls).toEqual([])
    let settled = false
    const pending = validation
      .resolve({ workspaceRef, rawContent: '  report.md  ', kind: 'path<md>', port: 'summary' })
      .then((value) => {
        settled = true
        return value
      })
    await resolveStarted.promise
    expect(calls).toEqual(['resolve:report.md'])
    expect(settled).toBe(false)
    resolution.release({
      targetRef: 'content:remote-v3',
      relativePath: 'docs/report.md',
      insideWorkspace: true,
    })
    await readStarted.promise
    expect(calls).toEqual(['resolve:report.md', 'read:content:remote-v3'])
    expect(settled).toBe(false)
    read.release('# Report\n\n  original indentation\n')
    expect(await pending).toEqual({
      body: '# Report\n\n  original indentation\n',
      sourcePath: 'docs/report.md',
    })
  })

  test('undeclared, scalar, signal and empty lists do not resolve or read', async () => {
    const validation = composePortOutputContentValidation(noReadContent())
    expect(await validation.resolve({ workspaceRef, rawContent: 'report.md' })).toEqual({
      body: 'report.md',
    })
    expect(
      await validation.resolve({ workspaceRef, rawContent: '  report.md  ', kind: 'string' }),
    ).toEqual({ body: '  report.md  ' })
    expect(
      await validation.resolve({ workspaceRef, rawContent: '# M\n\n  body\n', kind: 'markdown' }),
    ).toEqual({ body: '# M\n\n  body\n' })
    expect(
      await validation.resolve({ workspaceRef, rawContent: 'ignored', kind: 'signal' }),
    ).toEqual({ body: '' })
    expect(
      await validation.resolve({ workspaceRef, rawContent: '\n  \n', kind: 'list<path<md>>' }),
    ).toEqual({ body: '' })
  })

  test('empty path fails before resolution; outside and wrong extensions fail before read', async () => {
    let resolutions = 0
    const content: PortOutputValidationContent = {
      resolve(_ref, raw) {
        resolutions += 1
        return {
          targetRef: 'content:opaque',
          relativePath: raw,
          insideWorkspace: raw !== '../outside.md',
        }
      },
      readUtf8() {
        throw new Error('unexpected read')
      },
    }
    const validation = composePortOutputContentValidation(content)
    for (const [rawContent, subReason] of [
      ['  ', 'empty-path'],
      ['../outside.md', 'escapes-worktree'],
      ['report.json', 'wrong-extension'],
    ]) {
      const error: unknown = await validation
        .resolve({ workspaceRef, rawContent: rawContent!, kind: 'path<md>', port: 'summary' })
        .catch((error: unknown) => error)
      expect(error).toBeInstanceOf(PortValidationError)
      expect(error).toMatchObject({ failure: { port: 'summary', kind: 'path<md>', subReason } })
    }
    expect(resolutions).toBe(2)
  })

  test('resolution rejection escapes unchanged instead of becoming missing-file', async () => {
    const rejected = Object.freeze({ marker: 'raw-resolution-error' })
    const content: PortOutputValidationContent = {
      async resolve() {
        throw rejected
      },
      readUtf8() {
        throw new Error('unexpected read')
      },
    }
    const error: unknown = await composePortOutputContentValidation(content)
      .resolve({ workspaceRef, rawContent: 'report.md', kind: 'markdown_file' })
      .catch((error: unknown) => error)
    expect<unknown>(error).toBe(rejected)
  })

  test('read rejection returns the original structured missing-file failure and wire namespace', async () => {
    const content: PortOutputValidationContent = {
      resolve() {
        return { targetRef: 'content:v9', relativePath: 'report.md', insideWorkspace: true }
      },
      async readUtf8() {
        throw new Error('remote body missing')
      },
    }
    const error: unknown = await composePortOutputContentValidation(content)
      .resolve({ workspaceRef, rawContent: ' report.md ', kind: 'markdown_file', port: 'report' })
      .catch((error: unknown) => error)
    expect(error).toBeInstanceOf(PortValidationError)
    expect(error).toMatchObject({
      code: 'port-validation-path-missing-file',
      message: "port-validation-path-missing-file: path 'report.md': remote body missing",
      failure: {
        port: 'report',
        kind: 'markdown_file',
        subReason: 'missing-file',
        detail: "path 'report.md': remote body missing",
      },
    })
  })

  test('list awaits each item and collects every failure in original index order', async () => {
    const calls: string[] = []
    const content: PortOutputValidationContent = {
      async resolve(_ref, raw) {
        calls.push(`resolve:${raw}`)
        return { targetRef: `content:${raw}`, relativePath: raw, insideWorkspace: true }
      },
      async readUtf8(ref) {
        calls.push(`read:${ref}`)
        if (ref === 'content:a.md') throw new Error('missing A')
        return ' \n '
      },
    }
    const error: unknown = await composePortOutputContentValidation(content)
      .resolve({
        workspaceRef,
        rawContent: 'a.md\nwrong.json\nb.md',
        kind: 'list<path<md>>',
        port: 'docs',
      })
      .catch((error: unknown) => error)
    expect(calls).toEqual([
      'resolve:a.md',
      'read:content:a.md',
      'resolve:wrong.json',
      'resolve:b.md',
      'read:content:b.md',
    ])
    expect(error).toMatchObject({
      code: 'port-validation-list-list-item-validate-failed',
      failure: {
        subReason: 'list-item-validate-failed',
        detail:
          "[0] missing-file: path 'a.md': missing A; [1] wrong-extension: path<md> port content 'wrong.json': extension must be .md or .markdown; [2] empty-file: path 'b.md': file exists but its content is empty after trim",
      },
    })
  })

  test('list success retains selected item bodies, portable source refs and normalized wire', async () => {
    const content: PortOutputValidationContent = {
      resolve(_ref, raw) {
        return { targetRef: `content:${raw}`, relativePath: `docs/${raw}`, insideWorkspace: true }
      },
      readUtf8(ref) {
        return ref === 'content:a.md' ? 'A\n\n  text' : 'B'
      },
    }
    expect(
      await composePortOutputContentValidation(content).resolve({
        workspaceRef,
        rawContent: ' a.md\n\nb.md\n',
        kind: 'list<path<md>>',
      }),
    ).toEqual({
      body: 'a.md\nb.md',
      items: [
        { body: 'A\n\n  text', sourcePath: 'docs/a.md' },
        { body: 'B', sourcePath: 'docs/b.md' },
      ],
    })
  })

  test('multi-line markdown list retains document boundaries and body bytes without IO', async () => {
    const first = '# A\n\n  indented\n\n```\n  code\n```'
    const second = '# B\n\nsecond paragraph'
    const rawContent = `${first}\n<!-- @@aw-doc-boundary@@ -->\n${second}`
    expect(
      await composePortOutputContentValidation(noReadContent()).resolve({
        workspaceRef,
        rawContent,
        kind: 'list<markdown>',
      }),
    ).toEqual({ body: rawContent, items: [{ body: first }, { body: second }] })
  })

  test('await assimilates a selected thenable read', async () => {
    const content: PortOutputValidationContent = {
      resolve() {
        return { targetRef: 'content:thenable', relativePath: 'report.md', insideWorkspace: true }
      },
      readUtf8() {
        return {
          then(resolve: (value: string) => void) {
            resolve('thenable body')
          },
        } as unknown as Promise<string>
      },
    }
    expect(
      await composePortOutputContentValidation(content).resolve({
        workspaceRef,
        rawContent: 'report.md',
        kind: 'path<md>',
      }),
    ).toEqual({ body: 'thenable body', sourcePath: 'report.md' })
  })

  test('legacy resolution stays synchronous and the real native selected content matches it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aw-rfc370-validation-'))
    try {
      writeFileSync(join(directory, 'report.md'), '# Native\n\nbody\n')
      const opts = {
        worktreePath: directory,
        rawContent: 'report.md',
        kind: 'markdown_file' as const,
        port: 'report',
      }
      const legacy = resolvePortContentDetailed(opts)
      expect(legacy).toEqual({ body: '# Native\n\nbody\n', sourcePath: 'report.md' })
      expect(resolvePortContent(opts)).toBe(legacy.body)
      expect(NODE_VALIDATE_IO.resolveWorktreePath(directory, 'report.md')).toMatchObject({
        relativePath: 'report.md',
        insideWorktree: true,
      })
      expect(
        await composePortOutputContentValidation(createNativePortOutputValidationContent()).resolve(
          {
            workspaceRef: directory,
            rawContent: opts.rawContent,
            kind: opts.kind,
            port: opts.port,
          },
        ),
      ).toEqual(legacy)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
