# RFC-540 技术设计

## 1. 现状（HEAD `bf1ed4716`，源码实读）

- **Worker 入口**（`platform/persistence/sqliteLogicalSourceWorker.ts`）：模块级 `let source: SqliteLogicalSource | null`、`let contract`、
  `let initializing`；`self.onmessage` 解析请求（`SqliteLogicalSourceWorkerRequestSchema`），按类型处理：
  - `init`：已打开或正在初始化即抛 `SQLite logical-source Worker was initialized twice`；校验契约摘要与 daemon 交来的一致；有历史时登记 schema
    历史运行时；记下契约、`openSqliteLogicalSource({ path, contract })`；回 `ready`。
  - `metadata` / `preflight` / `assert-unchanged` / `read-chunk`：经 `requireSource()`（未初始化即抛 `… is not initialized`）读，回对应事件；
    `read-chunk` 先按契约找表，找不到抛 `unknown logical table …`。
  - `close`：关源、清空两份状态、回 `closed`，再关闭 Worker。
  - 任何异常回 `failure`（错误码与消息按长度截断）。
- **监工**（`sqliteLogicalSourceWorkerSupervisor.ts`）起 Worker、按请求号收事件；迁移协调器只经它读源（`rfc349-database-migration-worker` 钉着）。
- **锁**：`rfc349-database-migration-worker` 钉入口文件含 `openSqliteLogicalSource({`、`await requireSource().preflight()`、
  `await requireSource().readChunk(`；`tests/architecture/rfc294Gates.ts` 与 `scripts/build-binary.ts` 把入口列为单二进制的入口。

## 2. 机制与落位

落在 platform/persistence（Worker 的处理器与入口）；不新增跨上下文依赖。

### D1 处理器

- 新增 `platform/persistence/sqliteLogicalSourceWorkerHandler.ts`：`createSqliteLogicalSourceWorkerHandler(io)`，`io` 是
  `{ emit(event), close() }`；返回 `{ handle(data: unknown): Promise<void> }`。三份状态放在闭包里，六种请求的处理、`requireSource()` 与
  `failure()` 从入口逐字搬来，`postMessage` 换成 `io.emit`，关闭 Worker 换成 `io.close()`。

### D2 入口

- `sqliteLogicalSourceWorker.ts` 只建一个处理器（`emit` 交 `postMessage`、`close` 交 Worker 的 `close()`），`self.onmessage` 把消息体交给
  `handler.handle(…)`。单二进制的入口清单不变。

### D3 用例与锁

- 新增 `tests/rfc540-sqlite-logical-source-worker-state-boundary.test.ts`，登记 guard-manifest：① 入口与处理器文件顶层没有 `let` 与集合、架构报告的
  模块级可变单例判据为空；入口只调一次 `createSqliteLogicalSourceWorkerHandler(`，`onmessage` 交给它（语料下限 3,000）；② 行为：两个处理器
  在进程内各自初始化、互不相通（一个初始化后另一个仍拒绝读取），重复初始化与未知表照旧回 `failure`，关闭后回 `closed`、调 `io.close()` 且
  再读被拒；③ 带负对照。
- `rfc349-database-migration-worker` 改钉处理器文件里的三段原文，并钉入口经处理器处理消息。

## 3. 清单（退出门）

| 名字                                             | 之后                                                      |
| ------------------------------------------------ | --------------------------------------------------------- |
| `source` / `contract` / `initializing`（模块级） | 删去；`createSqliteLogicalSourceWorkerHandler(io)` 的闭包 |

## 4. 用例

- ① ～ ③ 见 D3；既有用例（`rfc349-sqlite-logical-source` 经监工起真 Worker）覆盖协议的往返。

## 5. 失败模式

- **入口建了不止一个处理器**：两个处理器各管一份状态，`init` 与读取可能落在不同的处理器上。RFC-540 用例钉入口只建一个。
- **搬迁漏了分支**：六种请求的处理逐字搬来；既有的真 Worker 用例与 RFC-540 的行为用例兜底。

## 6. 取舍（可推翻）

1. **处理器单独成文件而不是在入口文件里导出**：入口模块一加载就挂 `self.onmessage`，用例在主线程导入它会改全局；处理器文件没有副作用，用例
   可以直接建两个。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合（入口）只建一个处理器。**C11**：各模块 public 不变。**C12**：RFC-540 用例覆盖。**C13**：计数不升，模块级可变单例 54 → 51。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 4 项第八步（SQLite 逻辑源 Worker 的状态，3 条）。
- **留下**：其余 51 条（可迁移的登记与绑定 15 条；凭据 / 访问 / 完整性相邻的 9 条；进程级缓存与计数器 27 条须经用户确认是否保留并修订
  §14 口径）。
