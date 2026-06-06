// RFC-083 PR-C — assembly + git-backed orchestration.
//  - assembleStructuralDiff: injected in-memory readers, mixes code + manifest
//    files into one artifact (files + dependencyChanges + summary).
//  - computeFromWorktree: end-to-end against a real temp git repo (changed-file
//    enumeration + `git show <ref>:<path>` old side + worktree new side).

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleStructuralDiff } from '../src/services/structuralDiff/assemble'
import { computeFromWorktree, computeBetweenRefs } from '../src/services/structuralDiff/gitBackend'
import { runGit } from '../src/util/git'

describe('assembleStructuralDiff — in-memory', () => {
  test('mixes code symbol changes + manifest dependency changes', async () => {
    const oldMap: Record<string, string> = {
      'src/a.ts': 'export class A {\n  foo() { return 1 }\n}\n',
      'package.json': '{"dependencies":{"left":"1"}}',
    }
    const newMap: Record<string, string> = {
      'src/a.ts': 'export class A {\n  foo() { return 2 }\n  bar() { return 3 }\n}\n',
      'package.json': '{"dependencies":{"left":"1","zod":"3"}}',
    }
    const diff = await assembleStructuralDiff({
      taskId: 't1',
      scope: 'task',
      fromRef: 'base',
      toRef: 'WORKTREE',
      changedFiles: ['src/a.ts', 'package.json', 'README.md'],
      readOld: async (p) => oldMap[p] ?? null,
      readNew: async (p) => newMap[p] ?? null,
    })
    expect(diff.engine).toBe('baseline')
    expect(diff.status).toBe('ok')
    // code file present (README.md skipped — unsupported, not code/manifest)
    const codeFile = diff.files.find((f) => f.filePath === 'src/a.ts')
    expect(codeFile).toBeDefined()
    const kinds = codeFile?.changes.map(
      (c) => `${c.changeType} ${(c.after ?? c.before)?.qualifiedName}`,
    )
    expect(kinds).toContain('modified A.foo')
    expect(kinds).toContain('added A.bar')
    expect(diff.files.some((f) => f.filePath === 'README.md')).toBe(false)
    // dependency change — added but not imported in the (import-less) code file
    const zod = diff.dependencyChanges.find((d) => d.packageName === 'zod')
    expect(zod?.changeType).toBe('added')
    expect(zod?.viaImport).toBe(false)
    // summary aggregates both
    expect(diff.summary.methods.added).toBe(1)
    expect(diff.summary.methods.modified).toBe(1)
    expect(diff.summary.dependencies.added).toBe(1)
  })

  test('viaImport: a new source import of an added package flips viaImport', async () => {
    const diff = await assembleStructuralDiff({
      taskId: 't',
      scope: 'task',
      fromRef: 'a',
      toRef: 'WORKTREE',
      changedFiles: ['src/m.rs', 'Cargo.toml'],
      readOld: async () => null,
      readNew: async (p) =>
        p === 'src/m.rs' ? 'use tokio::time;\nfn f() {}\n' : '[dependencies]\ntokio = "1"\n',
    })
    const tokio = diff.dependencyChanges.find((d) => d.packageName === 'tokio')
    expect(tokio?.changeType).toBe('added')
    expect(tokio?.viaManifest).toBe(true)
    expect(tokio?.viaImport).toBe(true) // `use tokio::time;` references it
  })
})

describe('computeFromWorktree — real git repo', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  async function makeRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'aw-rfc083-'))
    dirs.push(dir)
    await runGit(dir, ['init', '-q', '-b', 'main'])
    await runGit(dir, ['config', 'user.email', 't@t.test'])
    await runGit(dir, ['config', 'user.name', 't'])
    return dir
  }

  test('symbol changes + dependency change between HEAD and worktree', async () => {
    const dir = await makeRepo()
    writeFileSync(
      join(dir, 'mod.py'),
      'class Animal:\n    legs = 4\n    def speak(self):\n        return "..."\n',
    )
    writeFileSync(join(dir, 'Cargo.toml'), '[dependencies]\ntokio = "1.0"\n')
    await runGit(dir, ['add', '.'])
    await runGit(dir, ['commit', '-q', '-m', 'init'])

    // Uncommitted edits: change method body, add a method, add a new file, add a dep.
    writeFileSync(
      join(dir, 'mod.py'),
      'class Animal:\n    legs = 4\n    def speak(self):\n        return "woof"\n    def walk(self):\n        return "x"\n',
    )
    writeFileSync(join(dir, 'Cargo.toml'), '[dependencies]\ntokio = "1.0"\nserde = "1"\n')
    writeFileSync(join(dir, 'new.go'), 'package m\nfunc Added() int { return 1 }\n')

    const diff = await computeFromWorktree({
      taskId: 't1',
      scope: 'task',
      worktreePath: dir,
      fromRef: 'HEAD',
    })

    expect(diff.toRef).toBe('WORKTREE')
    const py = diff.files.find((f) => f.filePath === 'mod.py')
    const pyChanges = py?.changes.map(
      (c) => `${c.changeType} ${(c.after ?? c.before)?.qualifiedName}`,
    )
    expect(pyChanges).toContain('modified Animal.speak')
    expect(pyChanges).toContain('added Animal.walk')
    const go = diff.files.find((f) => f.filePath === 'new.go')
    expect(
      go?.changes.some((c) => c.changeType === 'added' && c.after?.qualifiedName === 'Added'),
    ).toBe(true)
    expect(diff.dependencyChanges.find((d) => d.packageName === 'serde')?.changeType).toBe('added')
    expect(diff.summary.dependencies.added).toBe(1)
  })

  test('computeBetweenRefs: structural diff between two commits (node-scope pairing)', async () => {
    const dir = await makeRepo()
    writeFileSync(join(dir, 'mod.py'), 'class A:\n    def m(self):\n        return 1\n')
    await runGit(dir, ['add', '.'])
    await runGit(dir, ['commit', '-q', '-m', 'v1'])
    const from = (await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim()
    writeFileSync(
      join(dir, 'mod.py'),
      'class A:\n    def m(self):\n        return 2\n    def n(self):\n        return 3\n',
    )
    await runGit(dir, ['add', '.'])
    await runGit(dir, ['commit', '-q', '-m', 'v2'])
    const to = (await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim()

    const diff = await computeBetweenRefs({
      taskId: 't',
      scope: 'node',
      worktreePath: dir,
      fromRef: from,
      toRef: to,
    })
    expect(diff.fromRef).toBe(from)
    expect(diff.toRef).toBe(to)
    const idx = diff.files
      .find((f) => f.filePath === 'mod.py')
      ?.changes.map((c) => `${c.changeType} ${(c.after ?? c.before)?.qualifiedName}`)
    expect(idx).toContain('modified A.m')
    expect(idx).toContain('added A.n')
  })

  test('cross-file impact: a method changed in one file, called from another', async () => {
    const dir = await makeRepo()
    writeFileSync(
      join(dir, 'svc.py'),
      'class Svc:\n    def charge(self, amt):\n        return amt\n',
    )
    writeFileSync(
      join(dir, 'caller.py'),
      'from svc import Svc\nclass Order:\n    def pay(self):\n        return Svc().charge(10)\n',
    )
    await runGit(dir, ['add', '.'])
    await runGit(dir, ['commit', '-q', '-m', 'init'])
    // modify charge's body (uncommitted)
    writeFileSync(
      join(dir, 'svc.py'),
      'class Svc:\n    def charge(self, amt):\n        return amt * 2\n',
    )

    const diff = await computeFromWorktree({
      taskId: 't',
      scope: 'task',
      worktreePath: dir,
      fromRef: 'HEAD',
    })
    const chargeImpact = diff.impact.find((i) => i.changedSymbolId.includes('charge'))
    expect(chargeImpact).toBeDefined()
    // the caller lives in a DIFFERENT file (caller.py), found via cross-file scan
    expect(chargeImpact?.callers.some((c) => c.filePath === 'caller.py')).toBe(true)
  })

  test('classEdges: inheritance + construction among new classes (PR-G)', async () => {
    const dir = await makeRepo()
    writeFileSync(join(dir, 'README.md'), '# repo\n')
    await runGit(dir, ['add', '.'])
    await runGit(dir, ['commit', '-q', '-m', 'init'])
    // ALL three classes are new (changed) so each gets a graph node
    writeFileSync(join(dir, 'base.ts'), 'export class Base {\n  hi() {}\n}\n')
    writeFileSync(
      join(dir, 'a.ts'),
      'import { Base } from "./base"\nclass A extends Base {\n  d = new Dep()\n  run() {\n    return this.d\n  }\n}\n',
    )
    writeFileSync(join(dir, 'dep.ts'), 'class Dep {\n  work() {}\n}\n')

    const diff = await computeFromWorktree({
      taskId: 't',
      scope: 'task',
      worktreePath: dir,
      fromRef: 'HEAD',
    })
    expect(diff.classEdges).toContainEqual({
      from: 'a.ts::A',
      to: 'base.ts::Base',
      kind: 'inherits',
    })
    // the reference (`new Dep()`) is attributed to the member of A it sits in,
    // so the graph can highlight that exact method/field (not the whole class)
    const ref = diff.classEdges.find((e) => e.from === 'a.ts::A' && e.to === 'dep.ts::Dep')
    expect(ref?.kind).toBe('references')
    expect(ref?.fromMembers?.length).toBeGreaterThan(0)
    expect(ref?.fromMembers?.some((m) => m.includes('a.ts#A'))).toBe(true)
  })

  test('clean worktree → empty diff', async () => {
    const dir = await makeRepo()
    writeFileSync(join(dir, 'a.py'), 'def f():\n    return 1\n')
    await runGit(dir, ['add', '.'])
    await runGit(dir, ['commit', '-q', '-m', 'init'])
    const diff = await computeFromWorktree({
      taskId: 't',
      scope: 'task',
      worktreePath: dir,
      fromRef: 'HEAD',
    })
    expect(diff.files).toEqual([])
    expect(diff.dependencyChanges).toEqual([])
    expect(diff.summary.files).toBe(0)
  })
})
