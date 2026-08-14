// RFC-287 G6 —— git 失败的**可重试性**分类。
//
// 为什么要它：启动路径今天见 `fetchOk === false` 即硬失败（task.ts 的
// `repo-fetch-failed` 502「refusing to launch from a stale cache」）。这条硬失败
// 本身是对的——绝不能拿陈旧镜像开跑——但它把「网线抖了一下」和「你没有这个仓的
// 权限」判成了同一件事：前者重试一下就好，后者重试一万次也一样。
//
// 于是 G6 的交付是**让抖动不再直接打挂启动**：网络类失败在一个总容忍窗口内退避
// 重试；鉴权 / 仓库不存在 / 无权限 / 分支不存在**立刻失败、不占窗口**——让用户
// 在 1 秒内看到「你写错地址了」，而不是等满 60 秒再告诉他同一件事。
//
// 判据只看 git 的 stderr 原文：它是唯一稳定可得的信号（exit code 对这些情形几乎
// 都是 128）。措辞随 git 版本会变，所以用**特征词**而非整句匹配，且**先判不可
// 重试**——把「Repository not found」误判成网络抖动的代价（白等一个窗口）远大于
// 反向误判。

/** 失败的可重试性。 */
export type GitFailureClass =
  /** 网络/服务端瞬时问题：连接超时、拒绝、重置、DNS 抖动、502/503。 */
  | 'retryable-network'
  /** 凭据、权限、仓库/分支不存在——重试无意义，立刻失败。 */
  | 'permanent'
  /** 认不出来。保守起见按 permanent 处理：宁可让用户早点看到错，也不白等窗口。 */
  | 'unknown'

/** 明确不可重试的特征词（先判，优先级最高）。 */
const PERMANENT_PATTERNS: readonly RegExp[] = [
  /authentication failed/i,
  /could not read (username|password)/i,
  /permission denied/i,
  /access denied/i,
  /repository not found/i,
  /not found: /i,
  /remote: not found/i,
  /invalid username or password/i,
  /terminal prompts disabled/i,
  /host key verification failed/i,
  /couldn't find remote ref/i,
  /pathspec .* did not match/i,
  /does not appear to be a git repository/i,
  /403 forbidden/i,
  /401 unauthorized/i,
]

/** 网络/瞬时特征词。 */
const NETWORK_PATTERNS: readonly RegExp[] = [
  /connection timed out/i,
  /connection refused/i,
  /connection reset/i,
  /could not resolve host/i,
  /temporary failure in name resolution/i,
  /network is unreachable/i,
  /operation timed out/i,
  /timed out after \d+ms/i, // 本仓 runGit/spawnGit 的超时文案
  /failed to connect/i,
  /unexpected disconnect/i,
  /early eof/i,
  /rpc failed/i,
  /the remote end hung up/i,
  /502 bad gateway/i,
  /503 service unavailable/i,
  /504 gateway time-?out/i,
  /ssl.*(handshake|connect).*fail/i,
]

/**
 * 按 git 的 stderr 原文判定可重试性。
 *
 * **顺序不可换**：先判 permanent。真实 stderr 常同时含两类词——例如认证失败时
 * git 会先报一句连接相关的诊断再报 `Authentication failed`；若先判网络，这类
 * 失败会被白白重试满一个窗口。
 */
export function classifyGitFailure(stderr: string): GitFailureClass {
  if (typeof stderr !== 'string' || stderr.trim().length === 0) return 'unknown'
  for (const re of PERMANENT_PATTERNS) if (re.test(stderr)) return 'permanent'
  for (const re of NETWORK_PATTERNS) if (re.test(stderr)) return 'retryable-network'
  return 'unknown'
}

/** 只有网络类进重试窗口——`unknown` 保守按不可重试处理。 */
export function isRetryableGitFailure(stderr: string): boolean {
  return classifyGitFailure(stderr) === 'retryable-network'
}
