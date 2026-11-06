// RFC-083 PR-A — end-to-end baseline extraction + graphDiff over real
// before/after source for the 4 first-class-on-baseline languages
// (Python/Go/TypeScript/JavaScript). Locks that tree-sitter extraction +
// qualifiedName/parentId derivation + the set-diff produce the expected
// add/modify/remove changeset a human would name. If a grammar swap or query
// edit changes extraction semantics, these go red.
//
// Runs the actual web-tree-sitter WASM runtime (matched pair:
// web-tree-sitter@0.22 + tree-sitter-wasms grammars), so it also guards the
// runtime-loads-in-Bun path.

import { describe, expect, test } from 'bun:test'
import { analyzeFile } from '../src/modules/workspace-insight/engine/structuralDiff/baseline'
import type { FileStructuralDiff } from '@agent-workflow/shared'

/** Index changes as `${kind}:${qualifiedName}` → changeType. */
function changeIndex(file: FileStructuralDiff): Map<string, string> {
  const m = new Map<string, string>()
  for (const c of file.changes) {
    const node = c.after ?? c.before
    m.set(`${c.kind}:${node?.qualifiedName ?? '?'}`, c.changeType)
  }
  return m
}

describe('baseline — python', () => {
  test('add/modify/remove of import, class field, method, function', async () => {
    const before = `import os

class Animal:
    legs = 4
    def speak(self):
        return "..."
    def walk(self):
        return "walking"

def helper():
    return 1
`
    const after = `import os
import sys

class Animal:
    legs = 4
    sound = "generic"
    def speak(self):
        return "woof"

def helper():
    return 1

def extra():
    return 2
`
    const file = await analyzeFile({ filePath: 'a.py', oldText: before, newText: after })
    expect(file.status).toBe('ok')
    const idx = changeIndex(file)
    expect(idx.get('import:import sys')).toBe('added')
    expect(idx.get('field:Animal.sound')).toBe('added')
    expect(idx.get('method:Animal.speak')).toBe('modified')
    expect(idx.get('method:Animal.walk')).toBe('removed')
    expect(idx.get('function:extra')).toBe('added')
    // unchanged things emit nothing
    expect(idx.has('class:Animal')).toBe(false)
    expect(idx.has('function:helper')).toBe(false)
    expect(idx.has('field:Animal.legs')).toBe(false)
    expect(idx.has('import:import os')).toBe(false)
  })
})

describe('baseline — go', () => {
  test('struct field, method (receiver-qualified), function, import', async () => {
    const before = `package m

import "fmt"

type Animal struct {
\tLegs int
}

func (a Animal) Speak() string {
\treturn "..."
}

func Helper() int {
\treturn 1
}
`
    const after = `package m

import "fmt"
import "errors"

type Animal struct {
\tLegs int
\tName string
}

func (a Animal) Speak() string {
\treturn "woof"
}

func Extra() int {
\treturn 2
}
`
    const file = await analyzeFile({ filePath: 'a.go', oldText: before, newText: after })
    expect(file.status).toBe('ok')
    const idx = changeIndex(file)
    expect(idx.get('import:errors')).toBe('added')
    expect(idx.get('field:Animal.Name')).toBe('added')
    expect(idx.get('method:Animal.Speak')).toBe('modified')
    expect(idx.get('function:Helper')).toBe('removed')
    expect(idx.get('function:Extra')).toBe('added')
    expect(idx.has('struct:Animal')).toBe(false)
    expect(idx.has('field:Animal.Legs')).toBe(false)
    expect(idx.has('import:fmt')).toBe(false)
  })
})

describe('baseline — typescript', () => {
  test('class field, method, arrow-const function, interface, import', async () => {
    const before = `import { a } from "lib"

export class Service {
  count = 0
  start(): void {
    this.count = 1
  }
  stop(): void {}
}

interface Opts {
  x: number
}

function helper(): number {
  return 1
}
`
    const after = `import { a } from "lib"
import { b } from "lib2"

export class Service {
  count = 0
  name = "svc"
  start(): void {
    this.count = 2
  }
}

interface Opts {
  x: number
}

const extra = () => 5
`
    const file = await analyzeFile({ filePath: 'a.ts', oldText: before, newText: after })
    expect(file.status).toBe('ok')
    const idx = changeIndex(file)
    expect(idx.get('import:lib2')).toBe('added')
    expect(idx.get('field:Service.name')).toBe('added')
    expect(idx.get('method:Service.start')).toBe('modified')
    expect(idx.get('method:Service.stop')).toBe('removed')
    expect(idx.get('function:extra')).toBe('added')
    expect(idx.get('function:helper')).toBe('removed')
    expect(idx.has('class:Service')).toBe(false)
    expect(idx.has('interface:Opts')).toBe(false)
    expect(idx.has('field:Service.count')).toBe(false)
  })
})

describe('baseline — javascript', () => {
  test('class field, method, function, arrow-const, import', async () => {
    const before = `import x from "y"

class Box {
  size = 1
  open() { return 1 }
  close() { return 2 }
}

function run() { return 0 }
`
    const after = `import x from "y"
import z from "w"

class Box {
  size = 1
  color = "red"
  open() { return 9 }
}

const run2 = () => 1
`
    const file = await analyzeFile({ filePath: 'a.js', oldText: before, newText: after })
    expect(file.status).toBe('ok')
    const idx = changeIndex(file)
    expect(idx.get('import:w')).toBe('added')
    expect(idx.get('field:Box.color')).toBe('added')
    expect(idx.get('method:Box.open')).toBe('modified')
    expect(idx.get('method:Box.close')).toBe('removed')
    expect(idx.get('function:run')).toBe('removed')
    expect(idx.get('function:run2')).toBe('added')
    expect(idx.has('class:Box')).toBe(false)
    expect(idx.has('field:Box.size')).toBe(false)
  })
})

describe('baseline — added / removed whole file + guards', () => {
  test('added file (oldText null) → all symbols added', async () => {
    const file = await analyzeFile({
      filePath: 'n.py',
      oldText: null,
      newText: 'class A:\n    def m(self):\n        return 1\n',
    })
    expect(file.status).toBe('ok')
    const idx = changeIndex(file)
    expect(idx.get('class:A')).toBe('added')
    expect(idx.get('method:A.m')).toBe('added')
  })

  test('removed file (newText null) → all symbols removed', async () => {
    const file = await analyzeFile({
      filePath: 'n.go',
      oldText: 'package m\nfunc F() {}\n',
      newText: null,
    })
    const idx = changeIndex(file)
    expect(idx.get('function:F')).toBe('removed')
  })

  test('unsupported extension → status unsupported, no changes', async () => {
    const file = await analyzeFile({ filePath: 'notes.txt', oldText: 'a', newText: 'b' })
    expect(file.status).toBe('unsupported')
    expect(file.lang).toBe('unknown')
    expect(file.changes).toEqual([])
  })

  test('unmapped-but-known-extension file (ruby) → unsupported', async () => {
    // tree-sitter-wasms ships a ruby grammar, but RFC-083 does not map `.rb`,
    // so resolveLang returns null → unsupported (lang 'unknown').
    const file = await analyzeFile({
      filePath: 'a.rb',
      oldText: 'class A; end',
      newText: 'class A; def m; end; end',
    })
    expect(file.status).toBe('unsupported')
    expect(file.lang).toBe('unknown')
  })

  test('syntax error (recovered by tree-sitter) → status degraded, not silent ok', async () => {
    // tree-sitter recovers instead of throwing; a broken construct must still
    // downgrade the file to 'degraded' so the UI flags incompleteness.
    const file = await analyzeFile({
      filePath: 'b.py',
      oldText: 'def f():\n    return 1\n',
      newText: 'def f():\n    return 1\nclass @@@ broken(:\n',
    })
    expect(file.status).toBe('degraded')
  })

  test('binary content → skipped-binary', async () => {
    const bin = 'abc' + String.fromCharCode(0) + 'def'
    const file = await analyzeFile({ filePath: 'a.py', oldText: null, newText: bin })
    expect(file.status).toBe('skipped-binary')
  })

  test('hunkAnchor attached to changes', async () => {
    const file = await analyzeFile({
      filePath: 'a.py',
      oldText: 'def a():\n    return 1\n',
      newText: 'def a():\n    return 1\n\ndef b():\n    return 2\n',
    })
    const added = file.changes.find((c) => c.after?.qualifiedName === 'b')
    expect(added?.hunkAnchor?.filePath).toBe('a.py')
    expect(added?.hunkAnchor?.startLine).toBeGreaterThan(0)
  })
})
