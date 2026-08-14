// RFC-287 G6 —— git 失败分类的判据表。
//
// 这张表决定「抖一下就好」与「你写错了」的分界：判错前者代价是白等一个 60s 窗口
// 再报同一个错，判错后者代价是把可恢复的抖动变成硬失败。所以两类都要有正例，
// 且**顺序**（先判 permanent）必须单独锁——真实 stderr 常同时含两类词。

import { describe, expect, test } from 'bun:test'
import { classifyGitFailure, isRetryableGitFailure } from '../src/gitFailureClass'

describe('RFC-287 G6 — git 失败分类', () => {
  test('网络/瞬时类判可重试', () => {
    for (const s of [
      'fatal: unable to access: Failed to connect to example.com port 443: Connection timed out',
      'ssh: connect to host git.example.com port 22: Connection refused',
      'fatal: unable to access: Could not resolve host: git.example.com',
      'error: RPC failed; curl 56 Recv failure: Connection reset by peer',
      'fatal: the remote end hung up unexpectedly',
      'error: 503 Service Unavailable',
      'git timed out after 30000ms (killed)',
    ]) {
      expect(classifyGitFailure(s), s.slice(0, 40)).toBe('retryable-network')
      expect(isRetryableGitFailure(s)).toBe(true)
    }
  })

  test('鉴权/不存在/无权限判永久——立刻失败、不占窗口', () => {
    for (const s of [
      'remote: Invalid username or password.\nfatal: Authentication failed for https://…',
      'ERROR: Repository not found.',
      'remote: Permission denied to user',
      'fatal: could not read Username for https://…: terminal prompts disabled',
      "fatal: couldn't find remote ref refs/heads/nope",
      'remote: HTTP Basic: Access denied\nfatal: 403 Forbidden',
      'Host key verification failed.',
    ]) {
      expect(classifyGitFailure(s), s.slice(0, 40)).toBe('permanent')
      expect(isRetryableGitFailure(s)).toBe(false)
    }
  })

  test('两类词同时出现时**先判 permanent**（顺序不可换）', () => {
    // 真实形态：认证失败时 git 常先报一句连接诊断，再报 Authentication failed。
    // 若先判网络，这类失败会被白白重试满一个窗口才报同一个错。
    const mixed =
      'fatal: unable to access https://git.example.com/x.git/: Failed to connect to proxy\n' +
      'remote: Invalid username or password.\nfatal: Authentication failed'
    expect(classifyGitFailure(mixed)).toBe('permanent')
  })

  test('认不出来的按不可重试处理（宁可早报错，不白等窗口）', () => {
    expect(classifyGitFailure('fatal: something entirely new')).toBe('unknown')
    expect(isRetryableGitFailure('fatal: something entirely new')).toBe(false)
    expect(classifyGitFailure('')).toBe('unknown')
  })
})
