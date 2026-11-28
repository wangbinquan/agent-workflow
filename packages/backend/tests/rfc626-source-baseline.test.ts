// RFC-626 §4.1: a database's content identity is measured once and then adopted for as long as
// its cheap evidence (for PostgreSQL: the row count of every table and the value of every
// sequence) stays the one it was confirmed at.
//
// Why this test exists: the PostgreSQL reader used to answer "has the source changed?" by
// restarting its snapshot and digesting the whole database again — 60 to 90 seconds, about 63
// times per upgrade. The decision rule below is what replaced it; it must only ever change how
// long the answer takes: equal evidence adopts the remembered identity without measuring, any
// other evidence measures, and the measured identity (not the evidence) decides.
import { describe, expect, test } from 'bun:test'
import { createSourceWatch } from '@/platform/persistence/migration/freeze/sourceWatch'
import {
  baselineContent,
  settleContentIdentity,
} from '@/platform/persistence/migration/sourceBaseline'

describe('RFC-626 §4.1 content identity settled against the cheap evidence', () => {
  test('without a baseline the identity is measured once and remembered', async () => {
    const watch = createSourceWatch()
    try {
      let measured = 0
      const settled = await settleContentIdentity({
        watch,
        key: 'postgresql:db@local:5432',
        evidence: 'counts-1',
        measure: async () => {
          measured += 1
          return 'sha256:content-1'
        },
      })
      expect(settled).toEqual({ content: 'sha256:content-1', measured: true })
      expect(measured).toBe(1)
      expect(watch.baseline('postgresql:db@local:5432')).toEqual({
        identity: { content: 'sha256:content-1' },
        evidence: 'counts-1',
      })
    } finally {
      watch.close()
    }
  })

  test('the same evidence adopts the remembered identity without measuring', async () => {
    const watch = createSourceWatch()
    try {
      watch.remember('k', { identity: { content: 'sha256:known' }, evidence: 'counts-1' })
      for (let index = 0; index < 3; index += 1)
        expect(
          await settleContentIdentity({
            watch,
            key: 'k',
            evidence: 'counts-1',
            measure: () => Promise.reject(new Error('must not measure')),
          }),
        ).toEqual({ content: 'sha256:known', measured: false })
    } finally {
      watch.close()
    }
  })

  test('moved evidence measures again; the identity decides, and becomes the new baseline', async () => {
    const watch = createSourceWatch()
    try {
      watch.remember('k', { identity: { content: 'sha256:known' }, evidence: 'counts-1' })
      // Unchanged content behind moved evidence: the reader continues on the new baseline.
      const same = await settleContentIdentity({
        watch,
        key: 'k',
        evidence: 'counts-2',
        measure: async () => 'sha256:known',
      })
      expect(same).toEqual({ content: 'sha256:known', measured: true })
      expect(watch.baseline('k')).toEqual({
        identity: { content: 'sha256:known' },
        evidence: 'counts-2',
      })
      // Changed content: reported as a different identity (the reader then refuses).
      const changed = await settleContentIdentity({
        watch,
        key: 'k',
        evidence: 'counts-3',
        measure: async () => 'sha256:other',
      })
      expect(changed).toEqual({ content: 'sha256:other', measured: true })
      expect(baselineContent(watch.baseline('k'), 'counts-3')).toBe('sha256:other')
      expect(baselineContent(watch.baseline('k'), 'counts-2')).toBeNull()
    } finally {
      watch.close()
    }
  })

  test('baselines of other keys and malformed identities are never adopted', async () => {
    const watch = createSourceWatch()
    try {
      watch.remember('other', { identity: { content: 'sha256:other' }, evidence: 'counts-1' })
      for (const identity of [null, 'sha256:bare', ['sha256:array'], { content: 7 }, {}])
        expect(
          baselineContent({ identity: identity as never, evidence: 'counts-1' }, 'counts-1'),
        ).toBeNull()
      expect(baselineContent(undefined, 'counts-1')).toBeNull()
      let measured = 0
      const settled = await settleContentIdentity({
        watch,
        key: 'mine',
        evidence: 'counts-1',
        measure: async () => {
          measured += 1
          return 'sha256:mine'
        },
      })
      expect(settled.content).toBe('sha256:mine')
      expect(measured).toBe(1)
      expect(baselineContent(watch.baseline('other'), 'counts-1')).toBe('sha256:other')
    } finally {
      watch.close()
    }
  })

  test('a failed measurement leaves no baseline behind', async () => {
    const watch = createSourceWatch()
    try {
      await expect(
        settleContentIdentity({
          watch,
          key: 'k',
          evidence: 'counts-1',
          measure: () => Promise.reject(new Error('connection lost')),
        }),
      ).rejects.toThrow('connection lost')
      expect(watch.baseline('k')).toBeUndefined()
    } finally {
      watch.close()
    }
  })
})
