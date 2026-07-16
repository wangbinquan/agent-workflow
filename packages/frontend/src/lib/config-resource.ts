// RFC-201 PR-A — one browser-tab owner for the shared /api/config resource.
//
// Every config reader and writer must pass through this module. The receipt
// coordinator supplies issue-order fences and a single-writer FIFO, while the
// auth identity fence prevents an old daemon/token response from entering the
// next authenticated generation.

import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { ConfigSchema, type Config, type ConfigPatch } from '@agent-workflow/shared'
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { api, ApiError } from '@/api/client'
import { getBaseUrl, getToken, subscribeAuth } from '@/stores/auth'
import {
  ConfigAmbiguousWriteError,
  ConfigReceiptCoordinator,
  type ConfigReadReceipt,
  type ConfigWriteReceipt,
} from './config-receipts'

type TransportIdentity = readonly [baseUrl: string, token: string | null]

function readTransportIdentity(): TransportIdentity {
  return [getBaseUrl(), getToken()]
}

let transportIdentity = readTransportIdentity()
let resourceKeyGeneration = 1
let credentialKeyGeneration = 1

export const configReceiptCoordinator = new ConfigReceiptCoordinator(
  {
    read: async (signal) =>
      ConfigSchema.parse(await api.get<unknown>('/api/config', undefined, signal)),
    write: async (patch, signal) =>
      ConfigSchema.parse(await api.put<unknown>('/api/config', patch, signal)),
  },
  {
    initialResourceKey: transportIdentity[0],
    // A 4xx response proves the endpoint rejected this request.  A transport
    // loss, malformed 200 body, or 5xx can occur after the config was committed
    // and therefore remains outcome-unknown.
    isDefinitiveWriteError: (error) =>
      error instanceof ApiError && error.status >= 400 && error.status < 500,
  },
)

/**
 * Fence the singleton whenever its transport identity changes. The explicit
 * call at every public entry point also covers storage changes made outside
 * this module's auth-store setters (for example another same-origin tab).
 */
export function ensureConfigReceiptGeneration(): number {
  const nextIdentity = readTransportIdentity()
  if (transportIdentity[0] !== nextIdentity[0] || transportIdentity[1] !== nextIdentity[1]) {
    const resourceChanged = transportIdentity[0] !== nextIdentity[0]
    transportIdentity = nextIdentity
    credentialKeyGeneration += 1
    if (resourceChanged) resourceKeyGeneration += 1
    configReceiptCoordinator.resetGeneration({
      resourceChanged,
      ...(resourceChanged ? { resourceKey: nextIdentity[0] } : {}),
    })
  }
  return configReceiptCoordinator.currentGeneration
}

/** Query identity follows the daemon resource, never a credential-only rotation. */
export function getConfigQueryKey(): readonly ['config', number] {
  ensureConfigReceiptGeneration()
  return ['config', resourceKeyGeneration]
}

/** Stable identity for the daemon resource currently owning Config drafts. */
export function getConfigResourceIdentity(): string {
  ensureConfigReceiptGeneration()
  return transportIdentity[0]
}

/** React adapter that re-keys observers as soon as the daemon/base URL changes. */
export function useConfigQueryKey(): readonly ['config', number] {
  const queryClient = useQueryClient()
  const resourceGeneration = useSyncExternalStore(
    subscribeAuth,
    () => {
      ensureConfigReceiptGeneration()
      return resourceKeyGeneration
    },
    () => resourceKeyGeneration,
  )
  const credentialGeneration = useSyncExternalStore(
    subscribeAuth,
    () => {
      ensureConfigReceiptGeneration()
      return credentialKeyGeneration
    },
    () => credentialKeyGeneration,
  )
  const queryKey = useMemo(() => ['config', resourceGeneration] as const, [resourceGeneration])
  const previousCredentialGenerationRef = useRef(credentialGeneration)
  useEffect(() => {
    if (previousCredentialGenerationRef.current === credentialGeneration) return
    previousCredentialGenerationRef.current = credentialGeneration
    // Credential-only changes retain the same daemon cache identity but must
    // refetch with the new token after the preserved same-resource write tail.
    void queryClient.invalidateQueries({ queryKey, exact: true })
  }, [credentialGeneration, queryClient, queryKey])
  return queryKey
}

subscribeAuth(() => {
  ensureConfigReceiptGeneration()
})

/** Raw issued-read receipt for draft owners that need causal reconciliation. */
export function readConfigReceipt(signal?: AbortSignal): Promise<ConfigReadReceipt> {
  ensureConfigReceiptGeneration()
  return configReceiptCoordinator.read(signal)
}

/** TanStack-query adapter: a late fenced GET can never roll the Config cache back. */
export function queryConfig(signal?: AbortSignal): Promise<Config> {
  ensureConfigReceiptGeneration()
  return configReceiptCoordinator.readConfig(signal)
}

/** Queue one minimal patch; this function never merges a cached Config into it. */
export function writeConfigPatch(
  patch: ConfigPatch,
  signal?: AbortSignal,
): Promise<ConfigWriteReceipt> {
  ensureConfigReceiptGeneration()
  return configReceiptCoordinator.write({ ...patch }, signal)
}

/**
 * Refresh the visible resource after a response-loss write. This can tell the
 * user what the daemon currently returns, but deliberately does not unblock
 * the writer FIFO: without an idempotency receipt it cannot prove the lost PUT
 * will not commit later.
 */
export async function reconcileAmbiguousConfigWrite(
  error: unknown,
  client: QueryClient,
): Promise<ConfigReadReceipt> {
  if (!(error instanceof ConfigAmbiguousWriteError)) throw error
  const receipt = await readConfigReceipt()
  if (configReceiptCoordinator.getSnapshot() === receipt) {
    client.setQueryData<Config>(getConfigQueryKey(), receipt.config)
  }
  return receipt
}

/**
 * Publish an exact successful PUT response to TanStack's Config cache, then
 * replace it with the automatic post-settle GET only while that read remains
 * the coordinator's current accepted snapshot. A later write therefore wins
 * even when an earlier write's refetch completes last.
 */
export function cacheConfigWriteReceipt(client: QueryClient, receipt: ConfigWriteReceipt): void {
  ensureConfigReceiptGeneration()
  const currentSnapshot = configReceiptCoordinator.getSnapshot()
  if (currentSnapshot === undefined || currentSnapshot.generation !== receipt.generation) return

  // Normally this is the exact write receipt. If its automatic GET already
  // completed (or a later local write overtook this callback), cache the newer
  // accepted snapshot instead of briefly rolling the resource back.
  const queryKey = getConfigQueryKey()
  client.setQueryData<Config>(queryKey, currentSnapshot.config)
  void receipt.postSettleRefetch.then(
    (readReceipt) => {
      ensureConfigReceiptGeneration()
      if (configReceiptCoordinator.getSnapshot() === readReceipt) {
        client.setQueryData<Config>(queryKey, readReceipt.config)
      }
    },
    () => {
      // The exact PUT receipt remains authoritative until a later explicit read.
    },
  )
}
