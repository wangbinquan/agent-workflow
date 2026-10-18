// RFC-376 T10: retain platform behavior coverage after removing canonical projections.
import { expect, test } from 'bun:test'
import { toPublicError } from '../src/platform/errors/publicError'

test('the public-error mapper never copies private messages, causes or unknown detail keys', () => {
  const privateError = Object.assign(new Error('/secret/path: SELECT token FROM credentials'), {
    code: 'forbidden',
    details: { token: 'secret-token' },
    cause: new Error('private cause'),
    debugSql: 'SELECT * FROM credentials',
  })
  const forbidden = toPublicError(privateError, 'corr-1')
  expect(forbidden).toEqual({
    code: 'forbidden',
    category: 'forbidden',
    message: 'Access is forbidden.',
    correlationId: 'corr-1',
  })
  expect(JSON.stringify(forbidden)).not.toMatch(/secret|SELECT|cause|debugSql/)

  const stale = toPublicError(
    {
      code: 'resource-operation-stale',
      message: 'private target',
      details: { expectedRevision: 4, actualRevision: 5 },
    },
    'corr-2',
  )
  expect(stale.details).toEqual({ expectedRevision: 4, actualRevision: 5 })
  expect(
    toPublicError(
      {
        code: 'resource-operation-stale',
        details: { expectedRevision: 4, actualRevision: 5, token: 'must-reject' },
      },
      'corr-3',
    ),
  ).not.toHaveProperty('details')
  expect(toPublicError({ code: 'unknown', message: '/private' }, 'corr-4')).toEqual({
    code: 'internal-error',
    category: 'internal',
    message: 'An internal error occurred.',
    correlationId: 'corr-4',
  })
})
