// RFC-201 T10.1 — MCP field errors are translated and programmatically tied
// to the invalid control so hidden-tab handoff has a real focus target.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { McpFields } from '../src/components/McpFields'
import { EMPTY_LOCAL_FORM } from '../src/lib/mcp-form'
import '../src/i18n'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('MCP translated field error ARIA', () => {
  test('command error uses localized text plus invalid/describedby linkage', () => {
    render(
      <McpFields
        value={EMPTY_LOCAL_FORM}
        onChange={() => undefined}
        errors={{ command: 'mcps.errors.commandRequired' }}
      />,
    )
    const command = screen.getByRole('textbox', { name: /Command/ })
    expect(command.getAttribute('aria-invalid')).toBe('true')
    expect(command.getAttribute('aria-describedby')).toBe('mcp-field-command-error')
    expect(command.getAttribute('aria-errormessage')).toBe('mcp-field-command-error')
    expect(document.getElementById('mcp-field-command-error')?.textContent).not.toBe(
      'mcps.errors.commandRequired',
    )
  })
})
