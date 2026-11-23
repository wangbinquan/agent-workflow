# RFC-542 技术设计

## 1. 现状（HEAD `896fc990a`，源码实读）

- **行规则错误翻译**（`platform/persistence/schema/rowRules.ts`）：`createSchemaRowRuleErrorTranslator(codes)` 是纯函数；`bindSchemaRowRuleErrors(handle,
codes)` 取 `handle.session`，模块级 `boundSessions: WeakSet` 里有就返回，否则记进去，再把会话的 `prepareQuery` 产出的查询与会话自己的
  `run / all / get / values / execute / exec` 套一层翻译，并把 `transaction` 套成“进入事务时对事务句柄再调一次自己”。调用方：SQLite 客户端
  （`db/client.ts` 两处）、PostgreSQL 客户端（`postgresqlDatabaseClient.ts` 的 `bind`）与测试助手 `tests/helpers/nativeQueryFixture.ts`。
- **单行写入**（`platform/persistence/singleInsert.ts`）：模块级 `inserts: WeakMap<object, SingleInsert>`；`bindSingleInsert(db, insert)` 写表，
  `insertOne(db, table, value)` 按 `db` 对象取，取不到走 `queryWrite(db.insert(table).values(value))`。唯一的登记方是 PostgreSQL 客户端给根库
  （`db`）登记带代际围栏的 INSERT；事务句柄是别的对象，取不到，走普通写入。

## 2. 机制与落位

落在 platform/persistence（两个文件）；不新增跨上下文依赖，调用方不变。

### D1 行规则标记记在会话上

- 删去 `boundSessions`；“已套过”改为会话对象上一个不可枚举、不可写的符号属性（`Object.defineProperty`），有它就返回。其余逐字不变。

### D2 单行写入记在根库上

- 删去 `inserts`；`bindSingleInsert(db, insert)` 把 `insert` 记在 `db` 对象自己的一个不可枚举、不可写的符号属性上；`insertOne` 读这个对象自己的
  属性（不经原型链之外的任何登记处），取不到走普通写入。派生句柄是别的对象，照旧取不到。

### D3 用例与锁

- 新增 `tests/rfc542-persistence-handle-side-tables-boundary.test.ts`，登记 guard-manifest：① 两个文件顶层没有 `let` 与集合、架构报告的模块级可变
  单例判据为空；生产代码不再引用删去的名字（语料下限 3,000）；② 行为：两个库各记各的单行写入，派生对象取不到根库的、走普通写入；同一会话
  只套一次翻译（重复绑定不再包一层）、事务进入时套上；③ 带负对照。

## 3. 清单（退出门）

| 名字                                | 之后                         |
| ----------------------------------- | ---------------------------- |
| `boundSessions`（行规则的会话标记） | 删去；会话对象自己的符号属性 |
| `inserts`（单行写入登记表）         | 删去；根库对象自己的符号属性 |

## 4. 用例

- ① ～ ③ 见 D3；既有用例覆盖行规则翻译（`rfc395-r1-target-behavior` 等）与 PostgreSQL 的代际围栏写入。

## 5. 失败模式

- **同一会话套了两次**：翻译层层叠加，错误照旧翻译但多一层调用。RFC-542 用例钉重复绑定不再包一层。
- **派生句柄取到了根库的围栏写入**：事务里的单行写入会绕过事务连接。RFC-542 用例钉派生对象取不到。

## 6. 取舍（可推翻）

1. **记在对象上而不是挂进句柄上下文**：两份记录都只认那一个对象（会话标记认会话、单行写入只认根库），挂进按客户端共用的句柄上下文反而要再加
   一道“是不是根库”的判断；与 RFC-535 把按对象挂的侧表归各自实例同一做法。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：provider 构造时把两份记录交给各自的对象。**C11**：各模块 public 不变。**C12**：RFC-542 用例覆盖。**C13**：计数不升，模块级可变单例
  50 → 48。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 4 项第十步（两张按句柄的侧表，2 条）。
- **留下**：其余 48 条（可迁移的登记与绑定 12 条；凭据 / 访问 / 完整性相邻的 9 条；进程级缓存与计数器 27 条须经用户确认是否保留并修订
  §14 口径）。
