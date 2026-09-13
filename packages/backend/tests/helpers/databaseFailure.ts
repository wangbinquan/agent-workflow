// 跨引擎断言「数据库这一层失败的原因」。
//
// 为什么不能直接 `rejects.toThrow('…')`：两个 provider 把底层错误包到了不同深度。
// SQLite 上 bun:sqlite 的错误就是最外层那个，message 即原文；PostgreSQL 上 drizzle 抛的是
// `DrizzleQueryError`，最外层 message 被换成 `Failed query: <SQL>\nparams: …`，真正的
// `RAISE EXCEPTION` / 约束名只在 `cause` 里（实测 `cause` 是 postgres.js 的 `PostgresError`）。
// 只看最外层的判据在 PostgreSQL 上必然红，而且红出来的还是一段与故障无关的 SQL 文本。

/** 把错误连同整条 `cause` 链拼成一段可断言的文本。 */
export function databaseFailureText(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; current !== undefined && current !== null && depth < 8; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message)
      current = (current as { cause?: unknown }).cause
      continue
    }
    parts.push(String(current))
    break
  }
  return parts.join('\n')
}

/** 跑一段必失败的数据库操作，断言失败原因里出现了 `expected`（沿 cause 链找）。 */
export async function expectDatabaseFailure(
  run: () => Promise<unknown>,
  expected: string,
): Promise<void> {
  let thrown: unknown
  let settled = false
  try {
    await run()
    settled = true
  } catch (error) {
    thrown = error
  }
  if (settled) {
    throw new Error(`期望数据库操作失败并带上 '${expected}'，但它成功返回了`)
  }
  const text = databaseFailureText(thrown)
  if (!text.includes(expected)) {
    throw new Error(`数据库失败原因里没有 '${expected}'；实际错误链：\n${text}`)
  }
}
