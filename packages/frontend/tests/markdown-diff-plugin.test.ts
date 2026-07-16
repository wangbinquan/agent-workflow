// RFC-010 — remarkDiffMarkers 单元测试。
// 锚定：splitMarkers 的字符状态机正确切分 PUA marker；插件递归 visit 把
// markdown text 节点替换成 (text | diffMark)[]；mdast→hast 阶段
// hName/hProperties 的形状不能变（一旦变会让 react-markdown 渲染丢 class）。

import { describe, expect, test } from 'vitest'
import { MARKERS } from '@/lib/review/markdownDiff'
import { remarkDiffMarkers, splitMarkers } from '@/lib/review/remarkDiffMarkers'

const { INS_OPEN, INS_CLOSE, DEL_OPEN, DEL_CLOSE } = MARKERS

describe('splitMarkers', () => {
  test('纯文本 → 单 text 节点', () => {
    const out = splitMarkers('hello world')
    expect(out).toEqual([{ type: 'text', value: 'hello world' }])
  })

  test('INS marker → diffMark + 正确 hName/hProperties', () => {
    const out = splitMarkers(`hello ${INS_OPEN}new${INS_CLOSE} world`)
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({ type: 'text', value: 'hello ' })
    expect(out[1]).toEqual({
      type: 'diffMark',
      data: {
        hName: 'span',
        hProperties: { className: ['diff-ins'] },
      },
      children: [{ type: 'text', value: 'new' }],
    })
    expect(out[2]).toEqual({ type: 'text', value: ' world' })
  })

  test('DEL marker → className=diff-del', () => {
    const out = splitMarkers(`${DEL_OPEN}old${DEL_CLOSE}`)
    expect(out).toHaveLength(1)
    const node = out[0] as { type: 'diffMark'; data: { hProperties: { className: string[] } } }
    expect(node.type).toBe('diffMark')
    expect(node.data.hProperties.className).toEqual(['diff-del'])
  })

  test('混合 ins+del 段', () => {
    const out = splitMarkers(`${DEL_OPEN}a${DEL_CLOSE} ${INS_OPEN}b${INS_CLOSE}`)
    const kinds = out.map((n) => {
      if (n.type === 'diffMark') return n.data.hProperties.className[0]
      return 'text'
    })
    expect(kinds).toEqual(['diff-del', 'text', 'diff-ins'])
  })

  test('未配对 open marker → 内容不丢，仅丢 marker 本身', () => {
    const out = splitMarkers(`hello ${INS_OPEN}world`)
    // 终止时 'world' 在 ins buf 内未闭合 → 当成 text flush
    const concat = out
      .map((n) =>
        n.type === 'text'
          ? n.value
          : ((n.children[0] as { value?: string } | undefined)?.value ?? ''),
      )
      .join('')
    expect(concat.includes('world')).toBe(true)
    expect(concat.includes(INS_OPEN)).toBe(false)
  })

  test('未配对 close marker → 当无效字符吞掉', () => {
    const out = splitMarkers(`hello${INS_CLOSE}world`)
    const concat = out.map((n) => (n.type === 'text' ? n.value : '')).join('')
    expect(concat).toBe('helloworld')
  })

  test('错位嵌套 → 优雅闭合不崩', () => {
    const out = splitMarkers(`${INS_OPEN}a${DEL_OPEN}b${DEL_CLOSE}`)
    // 入 ins 模式 → 遇 DEL_OPEN → 闭合 ins 段 'a' 然后开 del 段 'b'
    expect(out.length).toBeGreaterThan(0)
    const insClasses = out
      .filter((n) => n.type === 'diffMark')
      .map(
        (n) =>
          (n as { data: { hProperties: { className: string[] } } }).data.hProperties.className[0],
      )
    expect(insClasses).toContain('diff-ins')
    expect(insClasses).toContain('diff-del')
  })
})

describe('remarkDiffMarkers plugin', () => {
  test('递归 visit：替换 text 子节点', () => {
    // 模拟一棵 mdast root → paragraph → text，text 内含 INS marker
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: `hello ${INS_OPEN}new${INS_CLOSE}` }],
        },
      ],
    }
    const transform = remarkDiffMarkers()
    transform(tree)
    const para = tree.children[0] as { children: Array<{ type: string }> }
    expect(para.children).toHaveLength(2)
    expect(para.children[0]?.type).toBe('text')
    expect(para.children[1]?.type).toBe('diffMark')
  })

  test('深嵌套（emphasis 内）：marker 仍被替换', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'emphasis',
              children: [{ type: 'text', value: `${INS_OPEN}bold${INS_CLOSE}` }],
            },
          ],
        },
      ],
    }
    const transform = remarkDiffMarkers()
    transform(tree)
    const emphasis = (
      tree.children[0] as { children: Array<{ children: Array<{ type: string }> }> }
    ).children[0]
    expect(emphasis?.children[0]?.type).toBe('diffMark')
  })

  test('无 marker 的 text → 不动', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'plain' }] }],
    }
    const before = JSON.stringify(tree)
    remarkDiffMarkers()(tree)
    expect(JSON.stringify(tree)).toBe(before)
  })
})

// 2026-07-16 — 跨节点归组 + value 叶子剥 marker（乱码 / 高亮丢失修复回归）。
// 旧实现逐 text 节点独立配对：open/close 分居不同 text 节点（整行新增里夹
// **bold** / `code` 时必然如此）两侧都被吞，整行高亮静默消失；code 节点
// value 里的残留 marker 直接渲染成 tofu 方块。
describe('remarkDiffMarkers — 跨节点归组与 value 剥 marker', () => {
  test('open/close 分居 strong 两侧 → 单个 diffMark 收编整段（含 strong）', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: `${INS_OPEN}new ` },
            { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
            { type: 'text', value: ` words${INS_CLOSE} tail` },
          ],
        },
      ],
    }
    remarkDiffMarkers()(tree)
    const para = tree.children[0] as {
      children: Array<{ type: string; children?: Array<{ type: string }> }>
    }
    expect(para.children).toHaveLength(2)
    const mark = para.children[0]
    expect(mark?.type).toBe('diffMark')
    // diffMark 内部依次是 text('new ') / strong / text(' words')
    expect(mark?.children?.map((n) => n.type)).toEqual(['text', 'strong', 'text'])
    expect(para.children[1]?.type).toBe('text')
  })

  test('inlineCode 元素被 open/close 夹住 → 整个收进 diffMark（高亮包 code）', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: `run ${DEL_OPEN}` },
            { type: 'inlineCode', value: 'foo bar' },
            { type: 'text', value: `${DEL_CLOSE} now` },
          ],
        },
      ],
    }
    remarkDiffMarkers()(tree)
    const para = tree.children[0] as {
      children: Array<{ type: string; children?: Array<{ type: string }> }>
    }
    const mark = para.children.find((n) => n.type === 'diffMark')
    expect(mark).toBeDefined()
    expect(mark?.children?.some((n) => n.type === 'inlineCode')).toBe(true)
  })

  test('code / inlineCode 节点 value 内残留 marker 被剥掉（乱码保险丝）', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'code', value: `const b = ${DEL_OPEN}2${DEL_CLOSE}${INS_OPEN}99${INS_CLOSE}` },
        {
          type: 'paragraph',
          children: [{ type: 'inlineCode', value: `foo ${INS_OPEN}baz${INS_CLOSE}` }],
        },
      ],
    }
    remarkDiffMarkers()(tree)
    // resolve 语义:value 取新版本视图(context+ins),不再新旧拼接
    expect((tree.children[0] as { value: string }).value).toBe('const b = 99')
    const para = tree.children[1] as { children: Array<{ value?: string }> }
    expect(para.children[0]?.value).toBe('foo baz')
  })

  test('link url / title 内残留 marker 被剥掉（href 不携带 PUA）', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              url: `http://a.example/${INS_OPEN}x${INS_CLOSE}`,
              title: `t${DEL_OPEN}1${DEL_CLOSE}`,
              children: [{ type: 'text', value: 'a' }],
            },
          ],
        },
      ],
    }
    remarkDiffMarkers()(tree)
    const link = (tree.children[0] as { children: Array<{ url?: string; title?: string }> })
      .children[0]
    expect(link?.url).toBe('http://a.example/x')
    expect(link?.title).toBe('t')
  })

  test('未配对 open 跨 sibling 到结尾 → 内容摊平不丢、不加高亮', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: `${INS_OPEN}aa ` },
            { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
            { type: 'text', value: ' bb' },
          ],
        },
      ],
    }
    remarkDiffMarkers()(tree)
    const para = tree.children[0] as { children: Array<{ type: string; value?: string }> }
    // 无 diffMark，内容原样摊平（marker 本身被吞）
    expect(para.children.some((n) => n.type === 'diffMark')).toBe(false)
    expect(para.children.map((n) => n.type)).toEqual(['text', 'strong', 'text'])
    expect(para.children[0]?.value).toBe('aa ')
  })
})

// 2026-07-16 — Codex 实现门 F2/F6:url / math 缓存的"新旧拼接"解析。
describe('remarkDiffMarkers — resolveMarkedString(Codex F2/F6)', () => {
  test('F2: link url 整体替换 → 解析为新版本 URL,不拼接', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              url: `${DEL_OPEN}https://old.example/a${DEL_CLOSE}${INS_OPEN}https://new.example/b${INS_CLOSE}`,
              children: [{ type: 'text', value: 'x' }],
            },
          ],
        },
      ],
    }
    remarkDiffMarkers()(tree)
    const link = (tree.children[0] as { children: Array<{ url?: string }> }).children[0]
    expect(link?.url).toBe('https://new.example/b')
  })

  test('F2: 纯删除的 url(无 ins 段)回退保留旧 URL', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              url: `${DEL_OPEN}https://gone.example${DEL_CLOSE}`,
              children: [{ type: 'text', value: 'x' }],
            },
          ],
        },
      ],
    }
    remarkDiffMarkers()(tree)
    const link = (tree.children[0] as { children: Array<{ url?: string }> }).children[0]
    expect(link?.url).toBe('https://gone.example')
  })

  test('F6: remark-math 缓存的 data.hChildren 同步解析(KaTeX 不再收到 marker)', () => {
    const mathValue = `x${DEL_OPEN}+${DEL_CLOSE}${INS_OPEN}-${INS_CLOSE}y`
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'inlineMath',
              value: mathValue,
              data: {
                hName: 'code',
                hProperties: { className: ['language-math'] },
                hChildren: [{ type: 'text', value: mathValue }],
              },
            },
          ],
        },
      ],
    }
    remarkDiffMarkers()(tree)
    const math = (
      tree.children[0] as {
        children: Array<{ value?: string; data?: { hChildren?: Array<{ value?: string }> } }>
      }
    ).children[0]
    expect(math?.value).toBe('x-y')
    expect(math?.data?.hChildren?.[0]?.value).toBe('x-y')
  })
})
