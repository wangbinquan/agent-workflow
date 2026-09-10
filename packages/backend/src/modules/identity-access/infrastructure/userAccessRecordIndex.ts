// RFC-359 W8 —— 用户记录的三张索引表怎么维护：**一份实现，两处事务读集共用**。
//
// 合一前 `oidcIdentityCrossContext.ts` 与 `userAccessPersistence.ts` 里两个事务读集类各揣一份
// **逐字相同**的私有方法 `storeUser`。它维护的是同一个不变量：`users` / `usernames` / `emails`
// 三张表必须一起改，且**换名 / 换邮箱时要先把旧键摘掉**——漏摘一侧就会留下指向旧身份的悬挂键，
// 而两处各自的用例都还绿着。
//
// 传三张表而不是传 `this`：两个类的字段都是 `private readonly`，私有成员不参与结构化匹配，
// `this` 满足不了 `{ users; usernames; emails }` 这种结构类型。
import type { UserAccessRecord } from '../application/ports/userAccessRepository'

/** 写入（或覆盖）一条用户记录，并把旧的 username / email 索引键一并摘掉。 */
export function storeUserAccessRecord(
  users: Map<string, UserAccessRecord>,
  usernames: Map<string, string>,
  emails: Map<string, string>,
  user: UserAccessRecord,
): void {
  const previous = users.get(user.id)
  if (previous !== undefined) {
    usernames.delete(previous.username)
    if (previous.email !== null) emails.delete(previous.email)
  }
  users.set(user.id, user)
  usernames.set(user.username, user.id)
  if (user.email !== null) emails.set(user.email, user.id)
}
