import { describe, expect, test } from 'vitest'
import {
  hrefForRepoResourceTab,
  repoResourceTabFromUrl,
  validateReposSearch,
  withRepoResourceTab,
} from '@/routes/repos'

describe('/repos strict tab URL contract', () => {
  test('无参数默认远端仓，合法 deep link 可恢复仓库组', () => {
    expect(repoResourceTabFromUrl('http://localhost/repos')).toEqual({
      tab: 'repos',
      invalid: false,
    })
    expect(repoResourceTabFromUrl('http://localhost/repos?tab=groups')).toEqual({
      tab: 'groups',
      invalid: false,
    })
  })

  test('非法或大小写错误的值 fail closed 到 repos，并要求 replace 规范化', () => {
    for (const href of [
      'http://localhost/repos?tab=GROUPS',
      'http://localhost/repos?tab=other',
      'http://localhost/repos?tab=',
    ]) {
      expect(repoResourceTabFromUrl(href)).toEqual({ tab: 'repos', invalid: true })
    }
    expect(validateReposSearch({ tab: 'GROUPS', q: 'sdk' })).toEqual({ q: 'sdk' })
  })

  test('切换只改 tab，保留其它 search 与 hash', () => {
    expect(hrefForRepoResourceTab('/repos?q=sdk&tab=repos#cached', 'groups')).toBe(
      '/repos?q=sdk&tab=groups#cached',
    )
    expect(hrefForRepoResourceTab('/repos?q=sdk#cached', 'repos')).toBe(
      '/repos?q=sdk&tab=repos#cached',
    )
    expect(withRepoResourceTab({ q: 'sdk', focus: 'row-1' }, 'groups')).toEqual({
      q: 'sdk',
      focus: 'row-1',
      tab: 'groups',
    })
  })
})
