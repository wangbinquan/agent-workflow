import type { MiddlewareHandler } from 'hono'
import type { HttpAuthenticationParticipant } from '../../public/participants'

/** The transport only installs the admitted projection and continues routing. */
export function createHttpAuthenticationMiddleware(
  authentication: HttpAuthenticationParticipant,
): MiddlewareHandler {
  return async (context, next) => {
    const admission = await authentication.authenticate({
      method: context.req.method,
      path: context.req.path,
      header: (name) => context.req.header(name) ?? null,
    })
    if (admission.kind === 'authenticated') context.set('actor', admission.identity.actor)
    await next()
  }
}
