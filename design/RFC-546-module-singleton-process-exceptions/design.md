# RFC-546 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`。数字取 HEAD `a3def727e`。生产代码不改。

## 0. 架构落位与裁定（RFC-294 第 8 条）

- **落位**：
  - 清单是机器账本，放 `architecture/module-singleton-exceptions.json`，与 `counts.json`、`guard-manifest.json` 同目录，登记进
    `T/architecture/rfc294Gates.ts` 的 `ARCHITECTURE_FILES`。
  - 守卫放 `T/architecture/`，用架构报告自己的判据（`mutableSingletons`），不另写一份。
- **裁定**：见 proposal §5。
  - 进程级的 28 条是例外。
  - 凭据 / 访问 / 完整性相邻的 9 条是待迁的服务状态，随延后的 `ws/` 与 legacy 一族处理。
- **偏离项**：无。

## 1. 现状

- 架构报告的模块级可变单例判据（`T/architecture/architectureReport.ts` 的 `mutableSingletons`）认两种：
  - 顶层 `let`；
  - 名字以 `set / bind / reset / register / configure / install` 开头、写模块级绑定的导出函数。
- RFC-545 之后共 46 条；落档后 RFC-547、RFC-548、RFC-549 拆掉可迁移的 9 条，HEAD 上余 37 条（proposal §1、§3）。
- 没有任何守卫钉住这 37 条。

## 2. 机制

### D1 清单

`architecture/module-singleton-exceptions.json` 有两份清单，按文件、符号、种类排序：

- `exceptions`：每条 `{ file, symbol, kind, category, reason }`。`category` 取 proposal §3 的八类之一：`host-probe`、
  `runtime-initialisation`、`immutable-memo`、`unique-counter`、`warn-once`、`process-output`、`identity-keyed`、`dynamic-scope-cache`。
- `pending`：每条 `{ file, symbol, kind, family, reason }`，`family` 取 `websocket-registry`、`legacy-test-database`、`skill-boot-reverify` 之一。

落档时的 design 设想过“待迁移”“待定”两份过渡清单；可迁移的一类已经拆完，只剩 `pending` 一份。

### D2 守卫

新增 `T/architecture/rfc546-module-singleton-exceptions.test.ts`，登记 guard-manifest：

1. **相等**：判据在真实语料上的结果等于两份清单之和，两份互不重叠。
   - 按“文件、符号、种类”比对。清单外出现的单例报 `unlisted singleton`；清单里在源码中已不存在的报 `stale entry`。
   - 语料下限 3,000 个生产文件。
2. **字段**：每条的种类是判据认的两种之一，例外有八类之一的类别，待迁有三族之一，理由非空。
3. **只减不增**：两份的条数不高于落地时的值（28、9）。后继拆掉一条就从 `pending` 删一条，并把上限降下来；提高上限要随 RFC 改。
4. **口径**：RFC-294 design §14 该行写着“不计登记的进程级例外”并指向清单文件。
5. **负对照**：
   - 伪造源码里的顶层 `let` 与写它的 `reset…` 导出函数，被判据认出。
   - 对照空清单报两条 `unlisted singleton`；多一条已不存在的条目报 `stale entry`。
   - 同一条列两次、缺理由、未知类别与未知一族都报出来。
   - 负对照不碰真实语料。

### D3 design §14

RFC-294 design §14 该行改为“模块级可变单例（生产态，bootstrap 外，不计登记的进程级例外：`architecture/module-singleton-exceptions.json`）0”。

## 3. 失败模式

- **新单例混进来而无人审**：它不在任何一份清单里，守卫红。要进例外清单，改动随 RFC 提交、理由必填；守卫只认清单，不认注释。
- **清单过期**：条目对应的符号消失时守卫红，提示把它删掉。
- **待迁的条目改挂例外**：两份的上限都钉着落地值；例外多一条就超过 28。

## 4. 对 RFC-294 刷新后规则的对账

- **C12**：守卫在全部生产文件上跑判据，带语料下限与负对照。
- **C13**：§14 这一行有了可机检的口径；计数由守卫钉住，只减不增。

## 5. 留下的

- `pending` 的 9 条随延后的 `ws/` 与 legacy 一族处理，清空时 S12 第 4 项的退出门达成。
