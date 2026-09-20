import { KeyedSerialQueue } from '@/util/keyedSerialQueue'

// Config writes and probe receipts retain the same process-wide queue across all bindings.
const runtimeProbeConfigFenceQueue = new KeyedSerialQueue<string>()

export function withRuntimeProbeConfigFence<T>(
  configPath: string,
  task: () => Promise<T> | T,
): Promise<T> {
  return runtimeProbeConfigFenceQueue.run(configPath, task)
}
