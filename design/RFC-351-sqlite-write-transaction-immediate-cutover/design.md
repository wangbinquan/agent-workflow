# RFC-351 技术设计 — SQLite 写事务一律预占 writer

## 1. 落位（RFC-294 对齐）

本 RFC 只动三个 bounded context 的 **infrastructure 层**：

| context                  | 文件                                                                                                              | 站点数 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- | -----: |
| `digital-employee`       | `infrastructure/sqliteRuntimeStore.ts` / `sqliteAuthoringStore.ts` / `writerCutoverPersistence.ts`                |     22 |
| `development-automation` | `infrastructure/sqliteMissionStore.ts` / `sqliteUploadSessionStore.ts` / `employeePlatformWorkItemPersistence.ts` |     10 |
| `event-center`           | `infrastructure/sqliteEventStore.ts` / `sqliteCustomEventSourceStore.ts`                                          |      5 |

**向目标架构的演进**：`dbTxSync` 是 `platform` 层已有的事务原语，本 RFC 把三个 context 的
infrastructure 从「各自直调 drizzle」收敛到「统一经平台原语」，减少一处横切的平台合同逃逸。
不新增 facade、不新增跨 context 内部 import、不动 `public/` 合同、不碰 application/domain 层。

**偏离项**：无。本 RFC 不需要绕过 kernel，也不新增临时 facade。

## 2. 接口契约

唯一使用的原语（既有、不改）：

```ts
export function dbTxSync<T>(db: DbClient, fn: (tx: DbTxSync) => NotPromise<T>): T
```

与被替换的 `db.transaction(fn)` **同形**：同一回调签名、同一返回值、同步执行面。差异只有两点，
都是本 RFC 想要的：

1. drizzle 收到 `{ behavior: 'immediate' }` ⇒ `BEGIN IMMEDIATE`，在事务边界预占 writer；
2. 回调若返回 thenable，类型层塌成 `never`、运行期抛错并回滚（S-10 的既有保护顺带覆盖过来）。

## 3. 转换规则（按形态，逐处判定）

| 形态             | 处数 | 处置                                          | 理由                                  |
| ---------------- | ---: | --------------------------------------------- | ------------------------------------- |
| 读 → 写          |   26 | **改 `dbTxSync`**                             | 正是 BUSY_SNAPSHOT 暴露面             |
| 写 → 读          |    4 | **改 `dbTxSync`**                             | 首语句即取 writer，行为等价；统一原语 |
| 只写             |    4 | **改 `dbTxSync`**                             | 同上                                  |
| 其它（转发包装） |    2 | 逐个判：包装体最终执行写 ⇒ 改；否则保留并登记 | `sqliteMissionStore.ts:693/705`       |
| 只读             |    1 | **保留裸调用**并在账本写明                    | 改成 immediate 会无谓占写锁           |

规则写死一句话：**除纯读事务外，一律经 `dbTxSync`**。

## 4. 数据流与耦合点

事务边界、内部语句顺序、返回值、抛错类型**逐字不变**——本 RFC 只改「事务用什么 BEGIN 开」。
调用方（application 层）无感知，`public/` 合同不变。

**新增的 import 边**：这些文件此前不 import `@/db/txSync`，改造后会新增该 import。
按今天 RFC-345 的实测教训，这会让 `cross-context-imports` / `architecture-exceptions` 账本上涨，
必须在 `ledger-baselines.json` 对应条目显式声明 `allowGrowth` 并点名本 RFC；且该 permit 是**一次性**的，
必须在紧随其后的那一笔里出账（RFC-317 T17），否则主干红。这条写进 plan 的收尾清单。

## 5. 失败模式

| 失败模式                                                         | 判断                                                  | 处置                                                                                                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 嵌套事务（`tx.transaction`）被改成 immediate ⇒ SQLite 不支持嵌套 | 实测**零处**：37 处接收者全是 `db`                    | 无需处置；守卫继续拒绝新增嵌套                                                                                                |
| BEGIN IMMEDIATE 提前占写锁 ⇒ 写锁持有时间变长、别的写手等待变久  | 这些回调体是纯 drizzle 同步语句、无 I/O、无跨进程等待 | 接受：代价是「别的写手在 BEGIN 处按自己的 busy_timeout 等」，收益是「不再有 0ms 直接失败」。RFC-338 AC-2 已就同一权衡做过裁决 |
| 回调返回 promise ⇒ 编译红                                        | 现存 37 处经 S-10 零容忍断言证明均为同步体            | 若真有，编译期就暴露，属改进                                                                                                  |
| 改造遗漏某处 ⇒ 静默留一个逃逸口                                  | `RAW_TRANSACTION_SITES` 与磁盘逐条相等的既有守卫会红  | 该守卫本身就是完成度判据                                                                                                      |
| 竞争窗口太窄，改造后无法证明修好了                               | 用可控的双连接夹具构造窗口（RFC-338 已有同形夹具）    | 见 §6                                                                                                                         |

## 6. 测试策略

1. **红→绿事故锁**（AC-4）：新建 `rfc351-sqlite-write-transaction-immediate.test.ts`。
   夹具形态照抄 `rfc338-maintenance-slices.test.ts:513`：主连接开事务读取 → 另一连接完成一次
   `BEGIN IMMEDIATE` 短提交 → 主连接升级为写。断言 DE 工具发布所走的 store 写入**不抛**
   `SQLITE_BUSY_SNAPSHOT`。改造前该断言红（已用 scratchpad 脚本实证 0ms 失败），改造后绿。
   文件顶端注明「本测试锁的是 2026-09-02 CI run `33638907352` 的 DE-07 500」。
2. **账本守卫**（AC-2/AC-3）：沿用 `scheduler-audit-s10-async-transaction-decorative.test.ts` 的
   逐条相等断言；把 `RAW_TRANSACTION_SITES` 的值从 `number` 升为 `{ count, why }`，并断言每条
   `why` 同时提到两类危害（关键词级断言，防止只答 async 那一半）。
3. **行为回归**：三个 context 的既有测试全跑（digital-employee / development-automation /
   event-center 的 store 与 application 层），证明事务语义未变。
4. **CI**：published exact-SHA 的 Main CI 与项目要求的定时 workflows 全绿（AC-7）。

## 7. 不做什么（与 §4 非目标呼应）

- 不给 `dbTxSync` 加重试：`retrySqliteWrite` 是另一条既有路径（只 3 个 task-execution 文件在用），
  是否推广属另一个决策，本 RFC 不动；
- 不改维护 Worker 的节奏或 busy timeout；
- 不改 PostgreSQL 侧任何事务；
- 不借机重排 store 内部语句或抽取仓储接口。
