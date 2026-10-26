import { decodeWrapperProgress, encodeWrapperProgress } from '../domain/wrapperProgress'

export function clearReuseDisabledProgress(value: string | null): string | null {
  const progress = decodeWrapperProgress(value, () => {})
  if (progress === null || progress.reuseDisabled !== true) return null
  const { reuseDisabled: _cleared, ...rest } = progress
  return encodeWrapperProgress(rest)
}
