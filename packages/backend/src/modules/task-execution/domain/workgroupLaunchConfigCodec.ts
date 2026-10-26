import {
  canonicalJson,
  WorkgroupLaunchConfigSchema,
  type WorkgroupLaunchConfig,
} from '@agent-workflow/shared'

export const WORKGROUP_LAUNCH_KEYS = [
  'workgroupId',
  'workgroupName',
  'mode',
  'goal',
  'leaderMemberId',
] as const

/** Select original values, including empty strings, without tolerant display coercion. */
export function encodeWorkgroupLaunchConfig(raw: Readonly<Record<string, unknown>>): string {
  return canonicalJson(
    Object.fromEntries(
      WORKGROUP_LAUNCH_KEYS.filter((key) => Object.hasOwn(raw, key)).map((key) => [key, raw[key]]),
    ),
  )
}

export function decodeWorkgroupLaunchConfigJson(json: string): WorkgroupLaunchConfig {
  return WorkgroupLaunchConfigSchema.parse(JSON.parse(json) as unknown)
}
