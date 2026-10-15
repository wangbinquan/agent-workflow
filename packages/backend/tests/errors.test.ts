import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import {
  ConflictError,
  DomainError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  errorHandler,
} from '../src/util/errors'
import { UserAccessError } from '../src/modules/identity-access/public/types'

function buildApp(handler: () => never): Hono {
  const app = new Hono()
  app.get('/', () => handler())
  app.onError(errorHandler)
  return app
}

describe('error classes', () => {
  test('DomainError default status is 400', () => {
    const e = new DomainError('bad-thing', 'oops')
    expect(e.status).toBe(400)
    expect(e.toPayload()).toEqual({ ok: false, code: 'bad-thing', message: 'oops' })
  })

  test('details are included when provided', () => {
    const e = new ValidationError('invalid-foo', 'field foo invalid', { field: 'foo' })
    expect(e.status).toBe(422)
    expect(e.toPayload()).toEqual({
      ok: false,
      code: 'invalid-foo',
      message: 'field foo invalid',
      details: { field: 'foo' },
    })
  })

  test('subclasses set correct status codes', () => {
    expect(new NotFoundError('x', 'x').status).toBe(404)
    expect(new ValidationError('x', 'x').status).toBe(422)
    expect(new ConflictError('x', 'x').status).toBe(409)
    expect(new UnauthorizedError().status).toBe(401)
  })
})

describe('errorHandler middleware', () => {
  test('translates DomainError to JSON with right status', async () => {
    const app = buildApp(() => {
      throw new NotFoundError('agent-not-found', 'agent foo not found', { name: 'foo' })
    })
    const res = await app.request('/')
    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({
      ok: false,
      code: 'agent-not-found',
      message: 'agent foo not found',
      details: { name: 'foo' },
    })
  })

  test('unknown errors become 500 / internal-error', async () => {
    const app = buildApp(() => {
      throw new Error('boom')
    })
    const res = await app.request('/')
    expect(res.status).toBe(500)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({
      ok: false,
      code: 'internal-error',
      message: 'internal server error',
    })
  })

  test('UnauthorizedError returns 401', async () => {
    const app = buildApp(() => {
      throw new UnauthorizedError()
    })
    const res = await app.request('/')
    expect(res.status).toBe(401)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('unauthorized')
  })
})

// Locks the 2026-10-14 verification finding: POST /api/tasks for an account
// without an email answered `500 internal-error`, because the launch path
// forwarded identity-access's HTTP-free UserAccessError unmapped.
describe('errorHandler maps identity-access errors', () => {
  test.each([
    ['validation', 422],
    ['conflict', 409],
    ['forbidden', 403],
    ['not-found', 404],
  ] as const)('%s → %i with the access code', async (kind, status) => {
    const app = buildApp(() => {
      throw new UserAccessError(
        kind,
        'git-identity-email-missing',
        'configure an account email before creating a task',
        { field: 'email' },
      )
    })
    const res = await app.request('/')
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({
      ok: false,
      code: 'git-identity-email-missing',
      message: 'configure an account email before creating a task',
      details: { field: 'email' },
    })
  })

  test('an unknown kind or an impostor name is still an internal error', async () => {
    const forged = Object.assign(new Error('x'), {
      name: 'UserAccessError',
      kind: 'odd',
      code: 'c',
    })
    const plain = Object.assign(new Error('y'), { name: 'UserAccessError' })
    for (const error of [forged, plain]) {
      const res = await buildApp(() => {
        throw error
      }).request('/')
      expect(res.status).toBe(500)
    }
  })
})
