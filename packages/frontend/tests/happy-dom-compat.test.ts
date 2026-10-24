// Dependency migration: the test DOM must expose the browser's Node getter contract.
import { expect, test } from 'vitest'
import DOMPurify from 'dompurify'

test('Node.prototype.nodeName reads the concrete node name', () => {
  const getter = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeName')!.get!
  const nodes: Node[] = [
    document,
    document.createElement('div'),
    document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
    document.createTextNode('label'),
    document.createComment('note'),
    document.createDocumentFragment(),
    document.implementation.createDocumentType('html', '', ''),
  ]
  expect(nodes.map((node) => getter.call(node))).toEqual([
    '#document',
    'DIV',
    'svg',
    '#text',
    '#comment',
    '#document-fragment',
    'html',
  ])
})

test('the real sanitizer preserves a normal SVG and its visible label', () => {
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20"/><text x="1" y="10">label</text></svg>'
  const clean = DOMPurify.sanitize(source, { USE_PROFILES: { svg: true, svgFilters: true } })
  const mount = document.createElement('div')
  mount.innerHTML = clean
  expect(mount.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 40 20')
  expect(mount.querySelector('svg rect')?.getAttribute('width')).toBe('40')
  expect(mount.querySelector('svg text')?.textContent).toBe('label')
})
