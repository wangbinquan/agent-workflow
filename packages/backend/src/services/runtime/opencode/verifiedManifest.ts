// RFC-224 — one-shot parent→verified-launcher manifest. The file is private,
// read without following links, unlinked before the server starts, and parsed
// with a closed schema so it cannot become a second configuration surface.

import { constants } from 'node:fs'
import { lstat, open, unlink } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { JsonValueSchema, OPENCODE_DIRECT_PROTOCOL_CODEC } from './directApiSchemas'
import { verifiedSelfCommand } from './sealedSubprocess'
import { executionIdentityFailure } from './failure'
import { OPENCODE_FFF_CAPABILITY_CODEC } from './hermetic'
import { FffCapabilityProbeSchema } from './fffCapability'
import { VerifiedInventoryPlanSchema } from './verifiedInventory'
import { RuntimeChildProviderPlanSchema, RuntimeContainmentReceiptSchema } from './containment'
import {
  CONTAINMENT_REQUIREMENT_PROFILES,
  containmentRequirementDigest,
  type ContainmentRequirementProfileId,
} from '@/services/sandbox'

export const VERIFIED_LAUNCH_MANIFEST_CODEC = 4 as const
export const MAX_VERIFIED_MANIFEST_BYTES = 4 * 1024 * 1024

const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value) && resolve(value) === value && !value.includes('\0'))
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const NonceSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/)
const EnvSchema = z.record(z.string().refine((value) => !value.includes('\0')))
const ContainmentCapabilityStrengthSchema = z.enum(['strong', 'best-effort', 'absent'])
const ContainmentReasonCodeSchema = z.enum([
  'platform-unsupported',
  'provider-not-found',
  'provider-path-not-canonical',
  'provider-owner-unsafe',
  'provider-mode-unsafe',
  'provider-parent-unsafe',
  'provider-trial-rejected',
  'provider-trial-timeout',
  'provider-lifecycle-unproven',
  'provider-contract-invalid',
  'provider-internal-error',
  'required-capability-missing',
])
const ContainmentAdmissionReceiptSchema = z
  .object({
    coordinatorBootId: z.string().min(1).max(128),
    admissionGeneration: z.number().int().positive(),
    policyGeneration: z.number().int().positive(),
    probeGeneration: z.number().int().positive().nullable(),
    probeCheckedAt: z.number().int().nonnegative().nullable(),
    providerId: z.string().min(1).max(128).nullable(),
    // RFC-242 T5: derived from the closed registry, never re-listed. A new
    // requirement profile must not be silently unrepresentable here.
    profileId: z.enum(
      Object.keys(CONTAINMENT_REQUIREMENT_PROFILES) as [
        ContainmentRequirementProfileId,
        ...ContainmentRequirementProfileId[],
      ],
    ),
    requirementDigest: Sha256Schema,
    mode: z.enum(['enforce', 'warn', 'off']),
    decision: z.enum(['contained', 'degraded', 'off']),
    requiredCapabilities: z.array(z.string().min(1).max(128)).max(64),
    capabilities: z.record(z.string().min(1).max(128), ContainmentCapabilityStrengthSchema),
    reasonCodes: z.array(ContainmentReasonCodeSchema).max(32),
    admittedAt: z.number().int().nonnegative(),
  })
  .strict()

const VerifiedLaunchManifestCommonSchema = z.object({
  codec: z.literal(VERIFIED_LAUNCH_MANIFEST_CODEC),
  protocolCodec: z.literal(OPENCODE_DIRECT_PROTOCOL_CODEC),
  binaryPath: AbsolutePathSchema,
  binaryDigest: Sha256Schema,
  containmentAdmission: ContainmentAdmissionReceiptSchema,
  containmentTopology: z.enum([
    'none',
    'runner-outer',
    'provider-child-only',
    'runner-outer-and-child',
  ]),
  containment: RuntimeContainmentReceiptSchema,
  childProvider: RuntimeChildProviderPlanSchema,
  worktreePath: AbsolutePathSchema,
  runRoot: AbsolutePathSchema,
  sessionDbPath: AbsolutePathSchema,
  sessionStoreKey: z.string().min(1).max(256),
  storeKind: z.enum(['business', 'mcp-test', 'system-ephemeral']),
  serverEnv: EnvSchema,
  expectedConfig: JsonValueSchema,
  selectedAgent: z.string().min(1).max(256),
  selectedModel: z
    .object({
      providerID: z.string().min(1).max(256),
      modelID: z.string().min(1).max(512),
      variant: z.string().min(1).max(256).optional(),
    })
    .strict(),
  prompt: z.string().max(1024 * 1024),
  sourceFingerprintDigest: Sha256Schema,
  sessionTitle: z.string().min(1).max(512),
  sessionContractDigest: Sha256Schema,
  identityDigest: Sha256Schema,
  fffCapabilityCodec: z.literal(OPENCODE_FFF_CAPABILITY_CODEC).optional(),
  fffProbe: FffCapabilityProbeSchema.optional(),
  bootstrapTimeoutMs: z.number().int().positive().max(300_000),
  runTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60 * 1000),
})

const VerifiedBusinessLaunchManifestSchema = VerifiedLaunchManifestCommonSchema.extend({
  storeKind: z.literal('business'),
  mode: z.enum(['new', 'resume']),
  expectedSessionId: z.string().optional(),
  createdNodeRunId: z.string().min(1).max(256),
  nodeRunId: z.string().min(1).max(256),
  taskId: z.string().min(1).max(256),
  nodeId: z.string().min(1).max(256),
  expectedProjectId: z.string().min(1).max(256).optional(),
  controlAckPath: AbsolutePathSchema,
  leaseNonce: NonceSchema,
  leaseNonceDigest: Sha256Schema,
  inventory: VerifiedInventoryPlanSchema,
}).strict()

const VerifiedSystemLaunchManifestSchema = VerifiedLaunchManifestCommonSchema.extend({
  storeKind: z.literal('system-ephemeral'),
  mode: z.literal('new'),
  invocationId: z.string().min(1).max(256),
}).strict()

const VerifiedMcpTestLaunchManifestSchema = VerifiedLaunchManifestCommonSchema.extend({
  storeKind: z.literal('mcp-test'),
  mode: z.enum(['new', 'resume']),
  testSessionId: z.string().min(1).max(256),
  createdTurnId: z.string().min(1).max(256),
  turnId: z.string().min(1).max(256),
  expectedSessionId: z.string().optional(),
  expectedProjectId: z.string().min(1).max(256).optional(),
  controlAckPath: AbsolutePathSchema,
  leaseNonce: NonceSchema,
  leaseNonceDigest: Sha256Schema,
  mcpExecutionDigest: Sha256Schema,
}).strict()

export const VerifiedLaunchManifestSchema = z
  .union([
    VerifiedBusinessLaunchManifestSchema,
    VerifiedMcpTestLaunchManifestSchema,
    VerifiedSystemLaunchManifestSchema,
  ])
  .superRefine((value, ctx) => {
    const admission = value.containmentAdmission
    if (admission.requirementDigest !== containmentRequirementDigest(admission.profileId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['containmentAdmission', 'requirementDigest'],
        message: 'containment requirement digest does not match the frozen profile',
      })
    }
    if (
      admission.mode !== value.containment.mode ||
      admission.providerId !== value.containment.providerId ||
      (admission.decision === 'contained') !== value.containment.available
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['containment'],
        message: 'runtime containment projection must match the admission receipt',
      })
    }
    const capabilityKeys = new Set([
      ...Object.keys(admission.capabilities),
      ...Object.keys(value.containment.capabilities),
    ])
    if (
      [...capabilityKeys].some(
        (capability) =>
          admission.capabilities[capability] !== value.containment.capabilities[capability],
      ) ||
      admission.reasonCodes.length !== value.containment.degradedReasons.length ||
      admission.reasonCodes.some(
        (reason, index) => reason !== value.containment.degradedReasons[index],
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['containment'],
        message: 'runtime containment evidence must match the admission receipt',
      })
    }
    if (
      (admission.probeGeneration === null) !== (admission.probeCheckedAt === null) ||
      (admission.decision === 'off' && admission.providerId !== null) ||
      (admission.decision !== 'off' && admission.probeGeneration === null)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['containmentAdmission', 'probeGeneration'],
        message: 'probe evidence must match the admission decision',
      })
    }
    if (
      (admission.decision === 'off' &&
        (admission.mode !== 'off' || value.containmentTopology !== 'none')) ||
      (admission.decision === 'degraded' &&
        (admission.mode !== 'warn' || value.containmentTopology !== 'none')) ||
      (admission.decision === 'contained' && value.containmentTopology === 'none')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['containmentTopology'],
        message: 'containment topology must match the admission decision',
      })
    }
    const childTopology =
      value.containmentTopology === 'provider-child-only' ||
      value.containmentTopology === 'runner-outer-and-child'
    if (childTopology !== (value.childProvider.providerId !== 'none')) {
      ctx.addIssue({
        code: 'custom',
        path: ['childProvider'],
        message: 'child provider must match the admitted atomic topology',
      })
    }
    // RFC-242 T5: the demand comes from the registry's childBoundary, not from
    // a profile-id literal. Profile ids are identities, never capability
    // criteria (RFC-227), and a third profile must not skip this check by
    // matching neither literal.
    const demandsChildBoundary =
      CONTAINMENT_REQUIREMENT_PROFILES[admission.profileId].childBoundary === 'model-controlled'
    if (
      (!demandsChildBoundary && childTopology) ||
      (demandsChildBoundary && admission.decision === 'contained' && !childTopology)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['containmentAdmission', 'profileId'],
        message: 'profile demand and child topology disagree',
      })
    }
    if (
      (value.containment.mode === 'off' || !value.containment.available) &&
      value.childProvider.providerId !== 'none'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['childProvider'],
        message: 'off/degraded containment requires the none child provider',
      })
    }
    if (
      value.childProvider.providerId !== 'none' &&
      (value.containment.providerId !== value.childProvider.providerId ||
        !value.containment.available)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['childProvider', 'providerId'],
        message: 'child provider must match the qualified containment receipt',
      })
    }
    if (value.childProvider.providerId === 'linux-bwrap') {
      if (value.fffCapabilityCodec === undefined || value.fffProbe === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['fffProbe'],
          message: 'linux-bwrap requires the filesystem-fallback proof',
        })
      }
    } else if (value.fffCapabilityCodec !== undefined || value.fffProbe !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['fffProbe'],
        message: 'only linux-bwrap admits a filesystem-fallback proof',
      })
    }
    if (value.fffProbe !== undefined) {
      const probeRelative = relative(value.runRoot, value.fffProbe.root)
      if (
        probeRelative === '' ||
        probeRelative === '..' ||
        probeRelative.startsWith(`..${sep}`) ||
        isAbsolute(probeRelative)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['fffProbe', 'root'],
          message: 'probe root must be a strict run-root child',
        })
      }
    }
    if (value.storeKind === 'system-ephemeral') return
    if (value.mode === 'resume') {
      if (value.expectedSessionId === undefined) {
        ctx.addIssue({ code: 'custom', path: ['expectedSessionId'], message: 'required' })
      }
      if (value.expectedProjectId === undefined) {
        ctx.addIssue({ code: 'custom', path: ['expectedProjectId'], message: 'required' })
      }
    } else if (value.expectedSessionId !== undefined || value.expectedProjectId !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['mode'], message: 'new forbids resume identity' })
    }
  })

export type VerifiedLaunchManifest = z.infer<typeof VerifiedLaunchManifestSchema>

function noFollow(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
}

export async function writeVerifiedLaunchManifest(
  path: string,
  value: VerifiedLaunchManifest,
): Promise<void> {
  const parsed = VerifiedLaunchManifestSchema.parse(value)
  const bytes = Buffer.from(JSON.stringify(parsed), 'utf8')
  if (bytes.byteLength > MAX_VERIFIED_MANIFEST_BYTES) {
    return executionIdentityFailure('execution-identity-store-unsafe')
  }
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(),
    0o600,
  )
  try {
    await handle.writeFile(bytes)
    await handle.sync()
    const metadata = await handle.stat()
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
  } finally {
    await handle.close()
  }
}

export async function readAndUnlinkVerifiedLaunchManifest(
  path: string,
): Promise<VerifiedLaunchManifest> {
  let handle
  try {
    const before = await lstat(path)
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      (before.mode & 0o777) !== 0o600 ||
      before.size > MAX_VERIFIED_MANIFEST_BYTES
    ) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
    handle = await open(path, constants.O_RDONLY | noFollow())
    const opened = await handle.stat()
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
    const bytes = await handle.readFile()
    if (bytes.byteLength > MAX_VERIFIED_MANIFEST_BYTES) {
      return executionIdentityFailure('execution-identity-store-unsafe')
    }
    return VerifiedLaunchManifestSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    )
  } catch {
    return executionIdentityFailure('execution-identity-store-unsafe')
  } finally {
    await handle?.close().catch(() => {})
    await unlink(path).catch(() => {})
  }
}

export function verifiedLauncherCommand(manifestPath: string): string[] {
  return verifiedSelfCommand('__opencode-verified-run', ['--manifest', manifestPath])
}
