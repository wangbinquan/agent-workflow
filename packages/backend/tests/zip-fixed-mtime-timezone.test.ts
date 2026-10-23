// 锁住 `util/zip.ts` 的固定 mtime：任意时区都能导出，且导出字节与时区无关。
//
// 为什么这条测试存在：`FIXED_MTIME` 曾是 `new Date(Date.UTC(1980, 0, 1))`。fflate 按**本地时间**的
// 年月日时分秒写 DOS 时间字段，于是在 UTC 以西（例如 America/Los_Angeles）它变成 1979-12-31，fflate
// 抛「date not in range 1980-2099」，所有资源包导出都返回 500；在 UTC 以东，DOS 时间随时区偏移，
// 同一份闭包导出的字节因机器时区而异（RFC-271 的「两次导出字节相同」只在 UTC 机器上成立）。
// CI 跑在 UTC，`bun test` 也默认按 UTC 运行，进程内复现不出来，所以每个时区各起一个子进程。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const ZIP_MODULE = resolve(import.meta.dir, '../src/util/zip.ts')

const SCRIPT = `
const { encodeZip } = await import(${JSON.stringify(ZIP_MODULE)})
const zip = encodeZip([
  { path: 'manifest.yaml', bytes: new TextEncoder().encode('formatVersion: 1\\n') },
  { path: 'skills/a/SKILL.md', bytes: new TextEncoder().encode('# a\\n') },
])
const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
console.log(JSON.stringify({
  hash: new Bun.CryptoHasher('sha256').update(zip).digest('hex'),
  dosTime: view.getUint16(10, true),
  dosDate: view.getUint16(12, true),
}))
`

interface Encoded {
  readonly hash: string
  readonly dosTime: number
  readonly dosDate: number
}

function encodeIn(timeZone: string): Encoded {
  const run = Bun.spawnSync({
    cmd: [process.execPath, '-e', SCRIPT],
    env: { ...process.env, TZ: timeZone },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(run.exitCode, `${timeZone}: ${run.stderr.toString()}`).toBe(0)
  return JSON.parse(run.stdout.toString().trim()) as Encoded
}

// DOS 日期：((年 - 1980) << 9) | (月 << 5) | 日；1980-01-01 00:00:00 ⇒ 时间 0、日期 0x21。
const EPOCH_DOS_DATE = (0 << 9) | (1 << 5) | 1

describe('encodeZip 的固定 mtime 与时区无关', () => {
  test('UTC 以西、以东与 UTC 都能导出，逐字节相同，DOS 时间恒为 1980-01-01 00:00', () => {
    const zones = [
      'UTC',
      'America/Los_Angeles',
      'Pacific/Pago_Pago',
      'Asia/Shanghai',
      'Pacific/Kiritimati',
    ]
    const results = zones.map((zone) => ({ zone, ...encodeIn(zone) }))
    for (const result of results) {
      expect({ zone: result.zone, dosTime: result.dosTime, dosDate: result.dosDate }).toEqual({
        zone: result.zone,
        dosTime: 0,
        dosDate: EPOCH_DOS_DATE,
      })
      expect(result.hash, result.zone).toBe(results[0]!.hash)
    }
  }, 60_000)
})
