# RFC-546 技术设计（待用户确认后实施）

## 1. 现状（HEAD `d204218c2`，架构报告实读）

- 架构报告的模块级可变单例判据（`tests/architecture/architectureReport.ts` 的 `mutableSingletons`）认两种：顶层 `let`，与名字以
  `set / bind / reset / register / configure / install` 开头、写模块级绑定的导出函数。RFC-545 之后共 46 条，分类与理由见 proposal §1、§3。
- 没有任何守卫钉住这 46 条：新增一条不会红，删掉一条也不会提醒更新口径。

## 2. 机制（确认后实施）

### D1 例外清单

- 新增 `architecture/module-singleton-exceptions.json`：每条 `{ file, symbol, kind, category, reason }`，`category` 取 proposal §3 的七类之一；初版
  就是 §3 的 28 条（用户否决的条目不进清单）。

### D2 守卫

- 新增 `tests/architecture/rfc546-module-singleton-exceptions.test.ts`，登记 guard-manifest：
  ① 架构报告的模块级可变单例 = 清单里的条目 ∪ “待迁移”与“待定”两份过渡清单（可迁移的 9 条与凭据 / 访问 / 完整性相邻的 9 条），三份互不重叠；
  ② 过渡清单只减不增——后继 RFC 拆掉一条就从过渡清单删一条，删到空为止；③ 清单里的条目在源码里必须还在（防止过期）；④ 带负对照。
- S12 第 4 项的退出门随之可机检：过渡清单为空即达成。

### D3 design §14

- RFC-294 design §14 该行改为“模块级可变单例（生产态，bootstrap 外，不计登记的进程级例外）0”，并指向清单文件。

## 3. 失败模式

- **新单例混进清单而无人审**：清单改动只随 RFC 提交，理由必填；守卫只认清单，不认注释。
- **清单过期**：条目对应的符号消失时守卫即红，提示把它从清单删掉。

## 4. 对 RFC-294 刷新后规则的对账

- **C13**：本 RFC 给 §14 的这一行一个可机检的口径；计数（模块级可变单例）此后由守卫钉住。

## 5. 本步留下的债

- 可迁移的 9 条（schema 历史运行时的登记、守护进程级服务状态）与凭据 / 访问 / 完整性相邻的 9 条，各由后继 RFC 处理。
