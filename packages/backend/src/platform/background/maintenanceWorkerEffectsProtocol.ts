import { z } from 'zod'
import { MaintenanceWorkerInitSchema } from './maintenanceProtocol'
import type { MaintenanceWorkerEffectsDescriptor } from './maintenanceWorkerEffects'
import type { MaintenanceWorkerInitRequest } from './maintenanceWorkerMessageRouter'

const MaintenanceWorkerEffectsDescriptorSchema = z
  .object({
    moduleSpecifier: z.string().min(1),
    exportName: z.string().min(1),
    configurationJson: z.string(),
    capabilities: z
      .array(
        z.enum([
          'taskArchive',
          'resourcePackageRecovery',
          'pluginGenerationGc',
          'resourcePackageRecoveryContent',
        ]),
      )
      .min(1)
      .refine((values) => new Set(values).size === values.length, 'duplicate effect selection'),
  })
  .strict()

/** The original strict v1 frames and event schema remain unchanged. */
const MaintenanceWorkerEffectsInitSchema = z
  .object({
    type: z.literal('init-effects'),
    version: z.literal(2),
    init: MaintenanceWorkerInitSchema,
    effects: MaintenanceWorkerEffectsDescriptorSchema,
  })
  .strict()

export function createMaintenanceWorkerEffectsInit(
  init: MaintenanceWorkerInitRequest,
  effects: MaintenanceWorkerEffectsDescriptor,
): z.infer<typeof MaintenanceWorkerEffectsInitSchema> {
  return MaintenanceWorkerEffectsInitSchema.parse({
    type: 'init-effects',
    version: 2,
    init,
    effects,
  })
}

/** Normalize only the new envelope; the original phase router validates every v1 frame. */
export function readMaintenanceWorkerEffectsFrame(raw: unknown): {
  readonly request: unknown
  readonly effects?: MaintenanceWorkerEffectsDescriptor
} {
  if (
    raw !== null &&
    typeof raw === 'object' &&
    (raw as { readonly type?: unknown }).type === 'init-effects'
  ) {
    const parsed = MaintenanceWorkerEffectsInitSchema.parse(raw)
    return Object.freeze({ request: parsed.init, effects: parsed.effects })
  }
  return Object.freeze({ request: raw })
}
