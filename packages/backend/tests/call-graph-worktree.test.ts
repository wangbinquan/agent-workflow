// RFC-085 T3 — worktree-backed expansion: the class→file index + path-safe reader
// over a real temp directory resolve a cross-file call.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  worktreeExpandCtx,
  invalidateCallGraphIndex,
} from '../src/modules/workspace-insight/application/callGraph/callTargets'
import { expandMethod } from '../src/modules/workspace-insight/engine/callGraph/expandMethod'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

describe('worktreeExpandCtx', () => {
  test('indexes the repo + resolves a cross-file field-typed call from disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc085-'))
    dirs.push(root)
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'junk'), { recursive: true })
    await writeFile(
      join(root, 'src', 'A.java'),
      'class A {\n  private OrderService svc;\n  void run() {\n    svc.charge();\n  }\n}\n',
    )
    await writeFile(
      join(root, 'src', 'OrderService.java'),
      'class OrderService {\n  void charge() {}\n}\n',
    )
    // a class under an ignored dir must NOT be indexed
    await writeFile(
      join(root, 'node_modules', 'junk', 'OrderService.java'),
      'class OrderService {}\n',
    )

    invalidateCallGraphIndex(root)
    const ctx = await worktreeExpandCtx(root)
    const out = await expandMethod('src/A.java#A.run', ctx)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      label: 'charge()',
      resolution: 'resolved',
      ref: 'src/OrderService.java#OrderService.charge',
    })
  })

  test('path-safe reader refuses traversal outside the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc085-'))
    dirs.push(root)
    await writeFile(join(root, 'x.ts'), 'export class X {}\n')
    const ctx = await worktreeExpandCtx(root)
    expect(await ctx.readFile('../../../etc/hosts')).toBeNull()
    expect(await ctx.readFile('x.ts')).toContain('class X')
  })
})
