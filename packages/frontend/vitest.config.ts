import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // RFC-310 PR-8: code-policy-pages.test.tsx imports backend
      // development-automation domain modules (pure zod) to cross-check the
      // frontend's static policy catalog. One of them (canonicalJson) uses the
      // backend's `@/util/hash` alias; map that exact specifier to the backend
      // file. Must precede the frontend '@' entry — alias entries match in
      // insertion order and '@' would otherwise capture it.
      '@/util/hash': path.resolve(here, '../backend/src/util/hash.ts'),
      '@': path.resolve(here, 'src'),
    },
  },
  test: {
    environment: 'happy-dom',
    environmentOptions: {
      happyDOM: { url: 'http://localhost/' },
    },
    setupFiles: ['./tests/setup.ts'],
    css: false,
    globals: false,
    // RFC-254: the windows-latest frontend job runs the SAME OS-agnostic
    // happy-dom tests on a runner that is ~2-4x slower than ubuntu/macos. A
    // correct render that finishes in ~1.5s on Linux can cross vitest's 5000ms
    // default there and time out (session-attempts-picker did exactly that).
    // These are ceilings, not expected durations — a correct test resolves in
    // <100ms and never approaches them on any runner, while a genuinely hung
    // test still fails, only a few seconds later. So the headroom is applied
    // uniformly on every platform rather than branching on process.platform.
    //
    // 20000 → 30000（2026-08-19，5e3bbcd3 实测）：windows shard 3/3 上
    // `gallery-page` 的一条**极轻**用例（单 item 渲染 + 几条同步断言，无网络、
    // 无计时器）撞了 20s 顶。该轮 runner 病态慢——整个 shard 的 setup 就花了
    // 223s、全套 238s（平常 30~60s），即慢约 10x 而非上面写的 2~4x。同一轮
    // 2327/2328 用例通过，被判死的那条没有任何时序反模式可修：天花板本身太低。
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
