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
  // 4xx 的数字态：请求本身有问题，重试一万次也一样。**唯独排除 429**——那是
  // 服务端在说「你太快了，等会儿再来」，属于该退避重试的一类，放它落到网络组。
  //
  // 这条必须在 permanent 组（先判）里，否则会被网络组的 `/rpc failed/i` 抢先：
  // git 报体积过大时的原话是 `error: RPC failed; HTTP 413 …`，两个特征词同时命中，
  // 谁先判谁赢。原先它被判成可重试，于是一个永远不会成功的 push 要白耗满窗口。
  // （T14 实现门实测。）
  /returned error: 4(?!29)\d\d\b/i,
  // ⚠️ `http` 与状态码之间要容得下**版本号**：curl / git 的真实原话多半是
  // `Received HTTP/1.1 407 …` / `returned error: HTTP/2 429`，而不是干净的
  // `HTTP 429`。原来写死一个空格，于是带版本的那一大类全落进 unknown
  // ——429 该退避的不退避、4xx 该立刻失败的走 unknown（行为恰好也是不重试，
  // 但归因是错的）。（三轮门 Codex 契约面实测。）
  /\bhttp(?:\/[\d.]+)? (?:code )?4(?!29)\d\d\b/i,
  // 代理要鉴权是**部署配置**问题，重试一万次也一样。
  /\b407 proxy authentication required/i,
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
  // git-over-HTTPS 最常见的瞬时态其实是**纯数字**形态——curl 只回
  // `The requested URL returned error: 503`，并不带 reason phrase。原先只认
  // 「503 Service Unavailable」这种带短语的写法，于是真实世界里最高频的那一类
  // 反而落进 unknown ⇒ 不重试，G6 对它形同虚设。（T14 实现门实测：503/500/429
  // 三种数字态全部漏判。）
  //
  // 只收 5xx 与 429：4xx 是「请求本身有问题」，重试无益——唯独 429 是服务端在说
  // 「你太快了，等会儿再来」，正是应当退避的那一类。
  /returned error: 5\d\d\b/i,
  /returned error: 429\b/i,
  /\bhttp(?:\/[\d.]+)? (?:code )?5\d\d\b/i,
  /\bhttp(?:\/[\d.]+)? (?:code )?429\b/i,
  // 连接建立后对端一言不发就断——典型的负载均衡器/代理抽风，重试通常就好。
  /empty reply from server/i,
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
