import type { ResolvedMemoryDistillRuntime } from '../ports/distillWorkStore'

/**
 * RFC-487: the distiller keeps exactly the runtime fields its port declares. Bootstrap binds runtime-management's
 * internal-agent resolution, which returns a superset (name, config dir and the remaining profile parameters); the
 * distiller's selection has carried only these fields (RFC-359 W4-D4), so projecting here keeps distill runs unchanged.
 */
export function distillRuntimeProfile(
  resolved: ResolvedMemoryDistillRuntime,
): ResolvedMemoryDistillRuntime {
  return {
    protocol: resolved.protocol,
    binaryPath: resolved.binaryPath,
    model: resolved.model,
    isSandbox: resolved.isSandbox,
    ...(resolved.observationIdentity === undefined
      ? {}
      : { observationIdentity: resolved.observationIdentity }),
  }
}
