// RFC-271 T18 —— `encodeZip` ↔ `decodeZip` 往返，以及**字节可复现**。
//
// 可复现不是洁癖：AC-7b 要求「name 域零匹配」与「name 域全不可见」产出**逐字节
// 相同**的包（否则导出本身成了存在性预言机——攻击者比较两份 zip 的字节就能推断
// 「那个名字到底存不存在」）。而只要 zip 里带了当前时间、或者条目顺序随 Map 遍历
// 序漂移，这条断言就永远写不出来。所以时间戳与条目序都钉死。

//
// 覆盖验收条款：AC-23（formatVersion 高于本二进制 ⇒ 拒绝）
//   （编号锚点由 rfc271-ac-coverage.test.ts 机械核查，别删）

import { describe, expect, test } from 'bun:test'
import { decodeZip } from '../src/services/skill-zip'
import { encodeZip } from '../src/util/zip'

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (u: Uint8Array): string => new TextDecoder().decode(u)

describe('往返', () => {
  test('多文件 + 嵌套目录 + 非 ASCII 路径', () => {
    const zip = encodeZip([
      { path: 'manifest.yaml', bytes: bytes('formatVersion: 1\n') },
      { path: 'skills/助手/SKILL.md', bytes: bytes('# 你好\n') },
      { path: 'skills/助手/files/a.bin', bytes: new Uint8Array([0, 1, 2, 255]) },
    ])
    const entries = decodeZip(zip)
    const byPath = new Map(entries.map((e) => [e.path, e]))
    expect([...byPath.keys()].sort()).toEqual([
      'manifest.yaml',
      'skills/助手/SKILL.md',
      'skills/助手/files/a.bin',
    ])
    expect(text(byPath.get('manifest.yaml')!.bytes())).toBe('formatVersion: 1\n')
    expect([...byPath.get('skills/助手/files/a.bin')!.bytes()]).toEqual([0, 1, 2, 255])
  })

  test('空文件与空包', () => {
    const zip = encodeZip([{ path: 'empty', bytes: new Uint8Array() }])
    // ⚠️ `ZipEntryRef.bytes` 是**惰性取值函数**，不是属性（解码器为大包避免一次性驻留）。
    expect(
      decodeZip(zip)
        .find((e) => e.path === 'empty')
        ?.bytes().byteLength,
    ).toBe(0)
    expect(decodeZip(encodeZip([]))).toEqual([])
  })
})

describe('字节可复现 —— AC-7b 的前提', () => {
  test('同一份内容编码两次，字节完全相同', () => {
    const files = [
      { path: 'b.txt', bytes: bytes('b') },
      { path: 'a.txt', bytes: bytes('a') },
    ]
    expect([...encodeZip(files)]).toEqual([...encodeZip(files)])
  })

  test('**条目声明序不影响产出** —— 内部按路径字典序写', () => {
    const one = encodeZip([
      { path: 'a.txt', bytes: bytes('a') },
      { path: 'b.txt', bytes: bytes('b') },
    ])
    const other = encodeZip([
      { path: 'b.txt', bytes: bytes('b') },
      { path: 'a.txt', bytes: bytes('a') },
    ])
    expect([...one]).toEqual([...other])
  })

  test('内容不同则字节不同（可复现 ≠ 常量）', () => {
    expect([...encodeZip([{ path: 'a', bytes: bytes('x') }])]).not.toEqual([
      ...encodeZip([{ path: 'a', bytes: bytes('y') }]),
    ])
  })
})

describe('路径守卫（zip slip 从**写入侧**就堵住）', () => {
  test('绝对路径 / 越界 / 重复条目一律拒绝', () => {
    expect(() => encodeZip([{ path: '/etc/passwd', bytes: bytes('x') }])).toThrow()
    expect(() => encodeZip([{ path: '../outside', bytes: bytes('x') }])).toThrow()
    expect(() => encodeZip([{ path: 'a/../../b', bytes: bytes('x') }])).toThrow()
    expect(() => encodeZip([{ path: '', bytes: bytes('x') }])).toThrow()
    expect(() =>
      encodeZip([
        { path: 'dup', bytes: bytes('1') },
        { path: 'dup', bytes: bytes('2') },
      ]),
    ).toThrow()
  })

  test('反斜杠归一成正斜杠（Windows 侧写出的路径不该产生第二种形态）', () => {
    const zip = encodeZip([{ path: 'a\\b\\c.txt', bytes: bytes('x') }])
    expect(decodeZip(zip).map((e) => e.path)).toEqual(['a/b/c.txt'])
  })
})
