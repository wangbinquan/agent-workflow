// RFC-349 —— 两个 provider 共用同一份「提交体怎么解」判据。
//
// 这一段曾经在 SQLite / PostgreSQL 两个 adapter 里各写了一遍，并且**已经漂了**：
// SQLite 侧走 `parseJsonDocument`，畸形 JSON 直接抛，HTTP 边界把它映成
// `internal-error` **500**；PostgreSQL 侧 `JSON.parse` 失败回落成 `{}`，随后被
// `XxxSchema.safeParse` 判成 `workgroup-*-invalid` **400**。
//
// 也就是说同一份畸形请求体在两种部署上得到两种结果，而两侧的 action 其实都做了
// `safeParse`——SQLite 那次抛是**先于**校验发生的，把本该 400 的东西变成了 500。
// 对齐到 PostgreSQL 的形状：解不出来就交给各自的 schema 去判，用户拿到的是说明白
// 哪个字段不对的校验错误，而不是一句 internal server error。
//
// 判据只留这一份。RFC-352 在 memory 侧撞到过同形状的漂移（`canManage` 在两个 provider
// 上一个是「只有 owner」、一个是 `write|own`），凡是「两个 provider 各抄一遍业务判据」
// 的地方都有同样的风险。
import type { WorkgroupTaskJsonSubmission } from '../public/types'

export function workgroupTaskSubmissionBody(submission: WorkgroupTaskJsonSubmission): unknown {
  try {
    return JSON.parse(submission.body)
  } catch {
    return {}
  }
}
