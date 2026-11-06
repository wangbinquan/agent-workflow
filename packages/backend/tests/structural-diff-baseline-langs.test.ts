// RFC-083 PR-B — baseline extraction for the remaining 4 languages:
// Java + Rust first-class (own queries incl. fields/imports + Rust impl-method
// receiver qualification), C++ + Scala best-effort (status 'degraded', symbols
// flagged). Locks that all 8 RFC-083 languages produce a sane changeset.

import { describe, expect, test } from 'bun:test'
import { analyzeFile } from '../src/modules/workspace-insight/engine/structuralDiff/baseline'
import type { FileStructuralDiff } from '@agent-workflow/shared'

function changeIndex(file: FileStructuralDiff): Map<string, string> {
  const m = new Map<string, string>()
  for (const c of file.changes) {
    const node = c.after ?? c.before
    m.set(`${c.kind}:${node?.qualifiedName ?? '?'}`, c.changeType)
  }
  return m
}

describe('baseline — java (first-class)', () => {
  test('class field, method, constructor preserved, interface, import', async () => {
    const before = `import java.util.List;
class Service {
  int count;
  Service() {}
  void start() {}
  void stop() {}
}
interface Repo { void save(); }
`
    const after = `import java.util.List;
import java.util.Map;
class Service {
  int count;
  String name;
  Service() {}
  void start() { count = 1; }
}
interface Repo { void save(); }
`
    const file = await analyzeFile({ filePath: 'A.java', oldText: before, newText: after })
    expect(file.status).toBe('ok')
    const idx = changeIndex(file)
    expect(idx.get('import:java.util.Map')).toBe('added')
    expect(idx.get('field:Service.name')).toBe('added')
    expect(idx.get('method:Service.start')).toBe('modified')
    expect(idx.get('method:Service.stop')).toBe('removed')
    expect(idx.has('constructor:Service.Service')).toBe(false)
    expect(idx.has('field:Service.count')).toBe(false)
    expect(idx.has('interface:Repo')).toBe(false)
  })
})

describe('baseline — rust (first-class, impl-method receiver)', () => {
  test('struct field, impl method (receiver-qualified), use import', async () => {
    const before = `use std::fmt;
struct Point { x: i32, y: i32 }
impl Point {
  fn norm(&self) -> i32 { self.x }
  fn scale(&self) {}
}
fn helper() -> i32 { 1 }
`
    const after = `use std::fmt;
use std::io;
struct Point { x: i32, y: i32, z: i32 }
impl Point {
  fn norm(&self) -> i32 { self.x + self.y }
}
fn helper() -> i32 { 1 }
`
    const file = await analyzeFile({ filePath: 'p.rs', oldText: before, newText: after })
    expect(file.status).toBe('ok')
    const idx = changeIndex(file)
    expect(idx.get('import:use std::io;')).toBe('added')
    expect(idx.get('field:Point.z')).toBe('added')
    expect(idx.get('method:Point.norm')).toBe('modified') // impl method qualified by receiver
    expect(idx.get('method:Point.scale')).toBe('removed')
    expect(idx.has('function:helper')).toBe(false)
    expect(idx.has('struct:Point')).toBe(false)
  })
})

describe('baseline — cpp (best-effort / degraded)', () => {
  test('class field, free function, include; status degraded + symbols flagged', async () => {
    const before = `#include <vector>
class Widget { public: int width; int height; };
int compute() { return 1; }
`
    const after = `#include <vector>
#include <string>
class Widget { public: int width; int height; int depth; };
int compute() { return 2; }
`
    const file = await analyzeFile({ filePath: 'w.cpp', oldText: before, newText: after })
    expect(file.status).toBe('degraded')
    const idx = changeIndex(file)
    expect(idx.get('field:Widget.depth')).toBe('added')
    expect(idx.get('function:compute')).toBe('modified')
    expect(idx.get('import:#include <string>')).toBe('added')
    // degraded symbols are flagged so the UI can mark "analysis incomplete"
    const added = file.changes.find((c) => c.after?.qualifiedName === 'Widget.depth')
    expect(added?.after?.degraded).toBe(true)
    expect(added?.after?.confidence).toBe('inferred')
  })
})

describe('baseline — scala (best-effort / degraded)', () => {
  test('class val field, method, object; status degraded', async () => {
    const before = `import scala.collection.mutable
class Account(id: Int) {
  val balance = 0
  def deposit(n: Int): Int = balance + n
  def withdraw(n: Int): Int = balance - n
}
object Bank { def open = 1 }
`
    const after = `import scala.collection.mutable
import scala.util.Try
class Account(id: Int) {
  val balance = 0
  val owner = "x"
  def deposit(n: Int): Int = balance + n
}
object Bank { def open = 1 }
`
    const file = await analyzeFile({ filePath: 'a.scala', oldText: before, newText: after })
    expect(file.status).toBe('degraded')
    const idx = changeIndex(file)
    expect(idx.get('import:import scala.util.Try')).toBe('added')
    expect(idx.get('field:Account.owner')).toBe('added')
    expect(idx.get('method:Account.withdraw')).toBe('removed')
    expect(idx.has('method:Account.deposit')).toBe(false) // unchanged
    expect(idx.has('object:Bank')).toBe(false)
  })
})
