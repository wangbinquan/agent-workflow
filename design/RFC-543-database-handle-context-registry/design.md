# RFC-543 技术设计

## 1. 现状（HEAD `4db5b0f3a`，源码实读）

- `platform/persistence/sessionTables.ts`：`bindDatabaseHandle(handle, tables, engine)` 建一份冻结的上下文（`identity`、`tables`、`engine`、
  `afterCommit` 槽、`fileSnapshots` 计数），写进模块级 `contexts: WeakMap`，句柄可扩展时再记在句柄的符号属性 `contextKey` 上；句柄有
  `session.client` 时对客户端做同样两件事（原生 Drizzle 事务在同一个客户端外面另建会话）。`inheritDatabaseHandle(handle, parent)` 把父句柄的上下文
  照此记到新句柄上。`boundContext(handle)` 依次查 `contexts.get(handle)`、`handle[contextKey]`、客户端的表项与属性。
- 交给它的对象（源码实读加 Bun 实测）：SQLite 的 drizzle 库、会话、事务与 `bun:sqlite` 的 `Database`，PostgreSQL 的 drizzle 库、会话、事务与
  `clientFor` 造的原生客户端对象字面量，`databaseTransaction.ts` / `db/txSync.ts` 继承上下文的事务，测试里的 `{}` 与代理——全部可扩展。仓内没有
  `Object.freeze` / `preventExtensions` / `Object.seal` 过的句柄。表项与属性对每个可扩展对象记的是同一份上下文，所以模块表只多覆盖“不可扩展的
  句柄”一种情形。

## 2. 机制与落位

落在 platform/persistence（`sessionTables.ts` 一个文件）；不新增跨上下文依赖，调用方与各访问函数不变。

### D1 只记在句柄上

- 删去 `contexts`。新增内部函数 `attachContext(target, context)`：对象不可扩展时抛 `persistence-handle-not-extensible`，否则把上下文定义在
  `contextKey` 上（可重定义，与现状相同）。`bindDatabaseHandle` 给句柄与它的原生客户端各调一次，`inheritDatabaseHandle` 给新句柄调一次。
- `boundContext(handle)` 只读 `handle[contextKey]`，取不到再读 `handle.session?.client?.[contextKey]`。属性读本来就是现状的第二、第四步：经原型链
  派生的对象与包着句柄的代理照旧取到被派生、被包的句柄的上下文——这里要的正是“共享”，不是 RFC-542 单行写入那样的“只认本身”。

### D2 用例与锁

- 新增 `tests/rfc543-database-handle-context-registry-boundary.test.ts`，登记 guard-manifest：① 文件顶层没有 `let` 与集合，架构报告的模块级可变
  单例判据为空，删去的名字不在（语料下限 3,000）；② 行为：构造的库带上下文、同一原生客户端外的另一会话取到同一份、继承句柄共享父句柄的
  上下文（同一个提交后泵槽与快照计数）、派生对象与透明代理取到被派生 / 被包的句柄的上下文、两个分别构造的库各有各的、没构造过的对象取不到，
  不可扩展的句柄在构造与继承时都明确报错；③ 带负对照。

## 3. 清单（退出门）

| 名字                           | 之后                                     |
| ------------------------------ | ---------------------------------------- |
| `contexts`（句柄上下文登记表） | 删去；只记在句柄与原生客户端自己的属性上 |

## 4. 用例

- ① ～ ③ 见 D2；既有用例覆盖各访问函数（`rfc395-r1-target-contract`、`rfc537-database-after-commit-pump-boundary`、
  `rfc539-database-file-snapshots-boundary` 等）与 provider 构造。

## 5. 失败模式

- **某种句柄丢了上下文**：访问函数抛 “no session table set”。RFC-543 用例逐种钉住根库、会话、继承句柄、派生对象与代理。
- **以后出现不可扩展的句柄**：构造时就报 `persistence-handle-not-extensible`，而不是到第一次访问才报找不到上下文。

## 6. 取舍（可推翻）

1. **不可扩展的句柄改为明确报错**：保留它只能留着模块表；仓内没有这样的句柄，provider 构造的对象都是可扩展的普通对象，构造时报错比静默只记
   进进程级表更早暴露问题。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：provider 构造时把上下文交给句柄本身。**C11**：各模块 public 不变。**C12**：RFC-543 用例覆盖。**C13**：计数不升，模块级可变单例
  48 → 47。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 4 项第十一步（句柄上下文登记表，1 条）。
- **留下**：其余 47 条（可迁移的登记与绑定 11 条：live schema 的登记、schema 历史运行时、规范 JSON 片段缓存、迁移历史的运行时绑定与日志器
  配置；凭据 / 访问 / 完整性相邻的 9 条；进程级缓存与计数器 27 条须经用户确认是否保留并修订 §14 口径）。

## 9. 结论：撤回（2026-11-23）

集中验证查出 §1 的前提不成立：仓内有不可扩展的句柄，而且是有意支持的。

- `tests/rfc395-session-table-binding.test.ts`（RFC-395 T18 X1：“frozen provider clients and inherited transaction handles retain their bindings”）先把
  句柄、原生客户端、事务与继承句柄冻结，再绑定上下文、按句柄与客户端取表，另钉“冻结的客户端重新绑定后按新上下文取表、属性不变”。
- RFC-395 的 PostgreSQL 测试夹具交给 provider 的连接池是冻结的：`createPostgresqlDatabaseClient` 用 `nativeDatabase(pool)` 直接在连接池外建 drizzle
  库，绑定时要把上下文记到连接池上（`rfc395-target-test-database` 的 PostgreSQL 支 7 条在构造时就报 `persistence-handle-not-extensible`）。生产的
  连接池是可扩展的 Bun.SQL 实例。
- 冻结的对象上记不了属性；`tablesOf(handle)` 一类访问函数只拿到句柄本身，能让冻结对象带上上下文、又不经模块级表的做法不存在（包一层会换掉
  句柄身份）。所以 `contexts` 是为不可扩展对象保留的身份表，不是可删的重复登记。

处置：实现改动撤回、未提交（工作树恢复为 HEAD）；`sessionTables.ts` 的这 1 条从“可迁移的登记与绑定”改列为须保留的身份表，与进程级缓存一起
须经用户确认是否作为例外保留并修订 RFC-294 design §14 的口径。§1 关于“仓内没有不可扩展的句柄”的判断只按调用处是否内联 `Object.freeze(...)`
查过，漏了先冻结变量再绑定的用例与测试夹具（教训记在 `docs/dev-gotchas.md`）。
