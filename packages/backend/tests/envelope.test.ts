import { describe, expect, test } from 'bun:test'
import { extractLastEnvelope, parseEnvelope } from '../src/services/envelope'

describe('extractLastEnvelope', () => {
  test('returns null when no envelope present', () => {
    expect(extractLastEnvelope('just some text\nwith no envelope')).toBeNull()
  })

  test('returns the only envelope', () => {
    const s = 'preamble\n<workflow-output>\n  <port name="x">v</port>\n</workflow-output>\ntrailer'
    const env = extractLastEnvelope(s)
    expect(env).toContain('<port name="x">v</port>')
  })

  test('returns the LAST envelope when agent emits drafts first', () => {
    const s = `
intermediate thoughts...
<workflow-output>
  <port name="x">draft1</port>
</workflow-output>
later reasoning...
<workflow-output>
  <port name="x">final</port>
</workflow-output>
trailing log
`
    const env = extractLastEnvelope(s) ?? ''
    expect(env).toContain('final')
    expect(env).not.toContain('draft1')
  })

  test('handles whitespace-only envelope', () => {
    const s = '<workflow-output></workflow-output>'
    expect(extractLastEnvelope(s)).toBe('<workflow-output></workflow-output>')
  })
})

describe('parseEnvelope', () => {
  test('extracts declared ports + trims content', () => {
    const envelope = `<workflow-output>
  <port name="summary">
    Found 2 issues.
  </port>
  <port name="findings">a\nb\nc</port>
</workflow-output>`
    const r = parseEnvelope(envelope, ['summary', 'findings'])
    expect(r.ports.get('summary')).toBe('Found 2 issues.')
    expect(r.ports.get('findings')).toBe('a\nb\nc')
    expect(r.missingDeclared).toEqual([])
    expect(r.undeclared).toEqual([])
  })

  test('missing declared ports surface as empty strings + missingDeclared list', () => {
    const envelope = `<workflow-output>
  <port name="summary">just summary</port>
</workflow-output>`
    const r = parseEnvelope(envelope, ['summary', 'findings'])
    expect(r.ports.get('summary')).toBe('just summary')
    expect(r.ports.get('findings')).toBe('')
    expect(r.missingDeclared).toEqual(['findings'])
  })

  test('preserves declaredOutputs iteration order in result map', () => {
    const envelope = `<workflow-output>
  <port name="b">B</port>
  <port name="a">A</port>
</workflow-output>`
    const r = parseEnvelope(envelope, ['a', 'b'])
    expect([...r.ports.keys()]).toEqual(['a', 'b'])
  })

  test('undeclared ports are kept in `undeclared`, not in ports', () => {
    const envelope = `<workflow-output>
  <port name="summary">s</port>
  <port name="extra">x</port>
</workflow-output>`
    const r = parseEnvelope(envelope, ['summary'])
    expect(r.ports.has('extra')).toBe(false)
    expect(r.undeclared).toEqual([{ name: 'extra', content: 'x' }])
  })

  test('single-quoted name attribute also accepted', () => {
    const envelope = `<workflow-output><port name='a'>v</port></workflow-output>`
    const r = parseEnvelope(envelope, ['a'])
    expect(r.ports.get('a')).toBe('v')
  })

  test('duplicate same-name ports — last one wins', () => {
    const envelope = `<workflow-output>
  <port name="x">first</port>
  <port name="x">second</port>
</workflow-output>`
    const r = parseEnvelope(envelope, ['x'])
    expect(r.ports.get('x')).toBe('second')
  })

  test('empty envelope -> all declared missing', () => {
    const envelope = `<workflow-output></workflow-output>`
    const r = parseEnvelope(envelope, ['a', 'b'])
    expect(r.ports.get('a')).toBe('')
    expect(r.ports.get('b')).toBe('')
    expect(r.missingDeclared).toEqual(['a', 'b'])
  })

  test('multiline content with XML-looking chars survives', () => {
    const envelope = `<workflow-output>
<port name="diff">
diff --git a/x b/x
@@ -1 +1 @@
-old
+new
</port>
</workflow-output>`
    const r = parseEnvelope(envelope, ['diff'])
    expect(r.ports.get('diff')).toContain('-old')
    expect(r.ports.get('diff')).toContain('+new')
  })
})
