// RFC-311 T28 — 输入去抖的公共原语(服务端搜索下推后,每击键一发请求不可
// 接受)。值稳定 delayMs 后才对外可见;卸载时清定时器。

import { useEffect, useState } from 'react'

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}
