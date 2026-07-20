// The app's single TanStack Query client, extracted out of `main.tsx` so the
// production defaults are an assertable surface (main.tsx renders into #root on
// import and can't be loaded from a test).

import { QueryClient } from '@tanstack/react-query'

/**
 * Never gate requests on the browser's online/offline signal.
 *
 * TanStack Query's default `networkMode: 'online'` asks `onlineManager` — which
 * never reads `navigator.onLine`, it just tracks the window `online`/`offline`
 * events — for permission before running anything. That signal reports internet
 * reachability, and our daemon is on 127.0.0.1, so it is pure noise here: macOS
 * fires `offline` on Wi-Fi drops, VPN toggles and sleep/wake even though the API
 * never moved.
 *
 * Under 'online' the consequence is not a failure but a *stall*: a mutation is
 * parked at `status: 'pending'` with no request sent and no error, so the UI
 * spins forever (创建代理 wedged at 「创建中…」 behind a disabled fieldset — user
 * report 2026-07-20), and queries sit in `fetchStatus: 'paused'`. Resuming also
 * needs `focusManager.isFocused()`, so a background tab stays stuck after the
 * network returns; only a reload clears it.
 *
 * With 'always' the request actually goes out. If the daemon really is down the
 * fetch rejects and `fetchOrNetworkError` turns it into
 * ApiError(0, 'network-unreachable'), which already has localized copy + hint —
 * a real error the user can act on instead of an endless spinner.
 */
const NETWORK_MODE = 'always' as const

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        retry: 1,
        refetchOnWindowFocus: false,
        networkMode: NETWORK_MODE,
      },
      mutations: {
        networkMode: NETWORK_MODE,
      },
    },
  })
}
