// RFC-325 — 平台下拉框搜索的单一匹配实现。
//
// 本模块出现之前，仓内有四份各写各的「归一化 + 匹配」：
//   · components/Select.tsx        —— toLowerCase，匹配 label + value
//   · components/MultiSelect.tsx   —— toLowerCase，匹配 label + value + description
//   · lib/user-permissions.ts      —— NFKC + locale 小写
//   · components/runtime-parameters/catalog.ts —— NFKC + 小写 + 去 {{}} + 空白折叠
// 于是「全角能不能搜到半角」「描述算不算可搜」这类问题，在同一个平台里有四个答案。
// 这里收敛成一份纯函数（零 React、零依赖，可直接单测）。
//
// runtime-parameters 的面包屑搜索**故意**要跨字段命中（"trigger webhook repo_path"），
// 它保留自己的拼接实现，只共用下面的 normalizeSearchText。

/**
 * 搜索文本归一化。搜索词与被搜文本必须走同一个函数，否则两侧的折叠规则会漂移。
 *
 *   NFKC        —— 全角 ＡＢＣ ≡ 半角 abc、兼容汉字 / 罗马数字等价形
 *   locale 小写 —— 大小写不敏感；locale 参与是为了土耳其语 I/ı 这类折叠规则
 *                  （本仓当前 locale 为 zh-CN / en-US，传 undefined 时退化为运行时默认）
 *   空白折叠    —— 连续空格 / 换行 / 制表符归一为单空格，再 trim
 */
export function normalizeSearchText(value: string, locale?: string): string {
  return value.normalize('NFKC').toLocaleLowerCase(locale).replace(/\s+/g, ' ').trim()
}

/**
 * 逐字段匹配：任一字段（归一化后）包含归一化后的查询词即命中。
 * 空 / 全空白查询恒真；undefined / null / 空串字段安全跳过。
 *
 * 刻意「逐字段」而不是「拼成一个 haystack」——拼接会让 "alpha beta" 意外跨字段命中
 * （label 结尾 + description 开头），用户看着那一行完全看不出它为什么被搜出来。
 */
export function matchesSearchQuery(
  fields: ReadonlyArray<string | undefined | null>,
  query: string,
  locale?: string,
): boolean {
  const needle = normalizeSearchText(query, locale)
  if (needle === '') return true
  for (const field of fields) {
    if (field === undefined || field === null || field === '') continue
    if (normalizeSearchText(field, locale).includes(needle)) return true
  }
  return false
}
