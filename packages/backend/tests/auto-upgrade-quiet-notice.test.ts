// Regression guard for the automatic database upgrade that `start` runs in a child (RFC-398 §2.2):
// the log must not go silent while the upgrade works.
//
// 2026-11-26, a real v0.19.2 installation (1.07 GB of live data, 827,743 run files) upgraded with
// the then-current build: the child reports from inside its work loops, but printed nothing for
// 47 s, 176 s, 115 s and 120 s at a stretch — each a single statement that cannot report from
// inside (content digest of the whole source, snapshot copy, integrity check), and each growing
// with the database. `docs/release-upgrade-rollback.md` promises that the log keeps reporting
// during the conversion, and an operator of a large installation has no other way to tell a
// working upgrade from a hung one: there is no HTTP listener yet. The parent only waits for the
// child, so it announces the upgrade and says that the child is alive while the child is quiet.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createQuietUpgradeNotice } from '@/bootstrap/autoUpgradeChild'

function fixture(options: { quietMs?: number; repeatMs?: number } = {}) {
  let clock = 1_000_000
  const lines: string[] = []
  const notice = createQuietUpgradeNotice({
    now: () => clock,
    write: (line) => lines.push(line),
    ...options,
  })
  return {
    lines,
    notice,
    /** Let the time pass the way the parent sees it: a tick every five seconds. */
    pass(seconds: number) {
      for (let elapsed = 0; elapsed < seconds; elapsed += 5) {
        clock += 5_000
        notice.tick()
      }
    },
    advance(ms: number) {
      clock += ms
    },
  }
}

test('a child that keeps reporting gets no notice', () => {
  const f = fixture()
  for (let i = 0; i < 30; i++) {
    f.pass(10)
    f.notice.relayed(
      `[db migration] conversion: staging current/tasks ${i}/30 rows (${i}.0s elapsed)`,
    )
  }
  expect(f.lines).toEqual([])
})

test('after 15 s of silence one notice says what was last reported and for how long; then one every 30 s', () => {
  const f = fixture()
  f.pass(10)
  f.notice.relayed('[db migration] offline-upgrade: prepare or reuse offline copy (53.4s elapsed)')
  f.pass(10)
  expect(f.lines).toEqual([])
  f.pass(5)
  // The child's own clock is dropped: the notice carries the parent's two.
  expect(f.lines).toEqual([
    '[db migration] still working (last reported: offline-upgrade: prepare or reuse offline copy): no new output for 15s, 25s since the upgrade started',
  ])
  f.pass(25)
  expect(f.lines).toHaveLength(1)
  f.pass(5)
  expect(f.lines[1]).toBe(
    '[db migration] still working (last reported: offline-upgrade: prepare or reuse offline copy): no new output for 45s, 55s since the upgrade started',
  )
  f.pass(120)
  // A silence of nearly three minutes, as measured, is six lines rather than none.
  expect(f.lines).toHaveLength(6)
  expect(f.lines[5]).toContain('no new output for 2m45s, 2m55s since the upgrade started')
})

test('a new line from the child ends the silence: the next notice waits 15 s again and names the new step', () => {
  const f = fixture()
  f.notice.relayed('[db migration] freeze: live source snapshot (7.2s elapsed)')
  f.pass(45)
  expect(f.lines).toHaveLength(2)
  f.notice.relayed('[db migration] content-capture: inventory 47784 files (419.2s elapsed)')
  f.pass(10)
  expect(f.lines).toHaveLength(2)
  f.pass(5)
  expect(f.lines[2]).toBe(
    '[db migration] still working (last reported: content-capture: inventory 47784 files): no new output for 15s, 1m00s since the upgrade started',
  )
})

test('only progress lines name a step; a warning or the completion summary leaves the last step in place', () => {
  const f = fixture()
  f.notice.relayed('[db migration] validation: verify target (900.0s elapsed)')
  f.advance(4_000)
  f.notice.relayed('WARN restriction: {"code":"example"}')
  f.pass(15)
  // The warning still counts as output: the silence is measured from it.
  expect(f.lines).toEqual([
    '[db migration] still working (last reported: validation: verify target): no new output for 15s, 19s since the upgrade started',
  ])
})

test('before the child has reported anything the notice names no step', () => {
  const f = fixture()
  f.pass(15)
  expect(f.lines).toEqual([
    '[db migration] still working: no new output for 15s, 15s since the upgrade started',
  ])
})

test('long durations stay readable: minutes with seconds, hours with minutes', () => {
  const f = fixture({ quietMs: 15_000, repeatMs: 3_600_000 })
  f.advance(3 * 60_000 + 5_000)
  f.notice.tick()
  expect(f.lines[0]).toContain('no new output for 3m05s, 3m05s since the upgrade started')
  const g = fixture({ quietMs: 15_000, repeatMs: 3_600_000 })
  g.advance(62 * 60_000 + 59_000)
  g.notice.tick()
  expect(g.lines[0]).toContain('no new output for 1h02m, 1h02m since the upgrade started')
})

test('the parent of the upgrade child announces the upgrade, relays through the notice and stops its timer', () => {
  // `runAutoUpgradeChild` spawns this binary's own CLI and cannot run inside a unit test; the
  // release-upgrade matrix runs it for real. This pins the wiring the cases above depend on.
  const text = readFileSync(join(import.meta.dir, '../src/bootstrap/autoUpgradeChild.ts'), 'utf8')
  expect(text).toContain("'[db migration] automatic database upgrade started: ")
  expect(text).toContain('const quiet = createQuietUpgradeNotice({ now: Date.now, write: line })')
  expect(text).toContain('tick: () => quiet.tick(),')
  expect(text).toContain('quiet.relayed(value)')
  expect(text).toContain('quietTimer.stop()')
  // The platform's fixed-rate timer, not a raw one: raw timer sites are a closed ledger
  // (tests/architecture/rfc376-structural-guards.test.ts, `direct-setinterval-sites`).
  expect(text).toContain("import { startInterval } from '@/platform/background/intervalTimer'")
  expect(text).not.toContain('setInterval(')
  // One spawn, as before: the notice is the parent's own timer, not another process.
  expect(text.split('Bun.spawn(').length - 1).toBe(1)
})
