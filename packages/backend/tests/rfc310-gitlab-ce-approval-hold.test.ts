import { describe, expect, test } from 'bun:test'

import { resolveGitlabApprovalHold } from '../src/modules/integration/application/mrFacts'

describe('RFC-310 GitLab approval hold compatibility', () => {
  test('prefers the required-rule count exposed by GitLab EE', () => {
    expect(resolveGitlabApprovalHold({ approvals_left: 2, approved: true }, [])).toBe(true)
    expect(resolveGitlabApprovalHold({ approvals_left: 0, approved: false }, [{}])).toBe(false)
  })

  test('uses the GitLab CE aggregate bit only for an explicitly requested reviewer', () => {
    expect(resolveGitlabApprovalHold({ approved: false }, [{ id: 34 }])).toBe(true)
    expect(resolveGitlabApprovalHold({ approved: true }, [{ id: 34 }])).toBe(false)
  })

  test('keeps an unapproved CE merge request without reviewers indeterminate', () => {
    expect(resolveGitlabApprovalHold({ approved: false }, [])).toBeNull()
    expect(resolveGitlabApprovalHold({ approved: false }, undefined)).toBeNull()
    expect(resolveGitlabApprovalHold({}, [{}])).toBeNull()
    expect(resolveGitlabApprovalHold(null, [{}])).toBeNull()
  })
})
