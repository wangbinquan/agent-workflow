// RFC-310 PR-0 T6 —— C1 内存判据的子进程探针（curl 落盘方案）。
//
// 两个实测背景（2026-08-18）：
// ① RSS 是进程级指标：在跑了几百个文件的分片进程里做绝对阈值断言会被堆基
//   态污染（单跑绿、全量红）⇒ 测量放进这个干净子进程。
// ② Bun 的 fetch / node:http 客户端对「快生产者」响应不背压：裸读丢 128MB
//   的 RSS 峰值 680MB/580MB ⇒ 大下载唯一可行姿势是子进程下载器（curl，三
//   平台自带）直接落盘，daemon 内只登记 + 流式 hash。本探针验证的就是这条
//   生产路径的内存性质。
//
// 用法：bun rfc310-stream-probe.ts <logUrl> <stagedRoot> <expectedBytes>
// 输出：单行 JSON { bytes, sha256, peakDelta }

import { StagedFileRegistrar } from '../helpers/rfc310EvidenceSink'

const [logUrl, stagedRoot, expectedBytesRaw] = process.argv.slice(2)
if (!logUrl || !stagedRoot || !expectedBytesRaw) {
  console.error('usage: rfc310-stream-probe.ts <logUrl> <stagedRoot> <expectedBytes>')
  process.exit(2)
}
const expectedBytes = Number(expectedBytesRaw)

Bun.gc(true)
const baseline = process.memoryUsage().rss
let peak = baseline
const sample = (): void => {
  const rss = process.memoryUsage().rss
  if (rss > peak) peak = rss
}

const registrar = new StagedFileRegistrar(stagedRoot, {
  maxFiles: 4,
  maxFileBytes: expectedBytes * 2,
  maxTotalBytes: expectedBytes * 2,
})

const relPath = 'logs/compile/big.log'
const target = registrar.stagedPathFor(relPath)
const curl = Bun.spawn({
  cmd: ['curl', '-sS', '--fail', '-o', target, logUrl],
  stdout: 'ignore',
  stderr: 'pipe',
})
const sampler = setInterval(sample, 25)
const exitCode = await curl.exited
clearInterval(sampler)
if (exitCode !== 0) {
  console.error(`curl failed (${exitCode}): ${await new Response(curl.stderr).text()}`)
  process.exit(3)
}
sample()
const entry = await registrar.register(relPath)
sample()
console.log(
  JSON.stringify({ bytes: entry.bytes, sha256: entry.sha256, peakDelta: peak - baseline }),
)
