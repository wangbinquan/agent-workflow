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
