# RFC-370 Event Center 精确 composition 入口 CI 修复

2026-10-07，有限入口修复设计。`ecf503d0641b5750546b022efde5dcea5539514b` 的正式功能作业 `112354062724` 和 `112354062859` 报告 RFC-310 原外部依赖清单多出六条实际地址：SQLite HTTP、SQLite CLI 和 PostgreSQL CLI 三个根各直接导入 `composition/customObserverProgram` 的工厂类型、`composition/localCustomObserverProgram` 的选择函数。现有守卫只允许这些 bootstrap 根使用精确 `composition`，其全仓扫描、清单逐条相等和 public／adapter 边界判据保持。

`event-center/composition.ts` 已经导入并使用完全相同的 `selectLocalCustomObserverProgramFactory` 和 `CustomObserverProgramFactory`。在此直接导出这两个已有绑定；不新增包装函数、不重新创建工厂、不增加模块加载或选择分支。三个根删除两条内部 import，把同一 value 与 type 加到原有 `@/modules/event-center/composition` 的 named import 中。根的可选完整工厂参数、实际选择表达式、forward、调用时点、getter／receiver 和原函数全文保持。

这一调整不扩展旧架构清单，也不放宽扫描或允许新地址。完整根／composition 文件去除仅上述 export 和导入迁址后，纯 AST 必须恢复当前前像；所有原函数／调用／类型和其余代码保持。已有真实工厂、双 provider 和完整根回归继续验收，旧 RFC-310 外部依赖守卫本身作为此次修复的失败回归。补充纯源码证明每个根只有一条精确入口 named import、两个 binding 的名称与 type-only 标记保持、没有新增内部导入、composition 直接导出的两个 binding 与既有 import 一致。

本片与 Doctor／boot 和观察器 CI 修复同批精确发布；保留三个独立有限设计结论和全部原失败。一次 matching census 使用最终冻结的源码人口，不提前运行或重复原生成。仅 owned format／lint、纯 AST／字节／JSON，不运行本机 AW tests／typecheck／build／service。新 exact-SHA hosted CI 负责实际结论；完整 H7／purpose callers／A-T7／A-G、CS adapters 和 M0～M4 尚未完成，RFC 不记 Done。
