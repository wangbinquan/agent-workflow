// RFC-221 — ready output never advertises a retired daemon token.

import { expect, test } from 'bun:test'
import { readyBrowserUrl } from '../src/cli/start'

test('ready URL includes daemon token only while bootstrap is required', () => {
  expect(readyBrowserUrl('http://127.0.0.1:3000/', 'secret', true)).toBe(
    'http://127.0.0.1:3000/?token=secret',
  )
  expect(readyBrowserUrl('http://127.0.0.1:3000/', 'secret', false)).toBe('http://127.0.0.1:3000/')
})
