# RFC-371 保留输出声明的统一操作与 CI 兼容

1820be8c2e59daedaeb076eda76f44403e673eff 的确切 hosted CI 37417648524 已给出功能失败。新增 PostgreSQL 阻塞回归把 PromiseLike 声明为 Promise；几个当前 schema 数量预期仍为旧的 221/215/240；旧受控 schema fixture 尚不识别已登记的 function/trigger；现有同文件 provider 孪生守卫识别到本批两份导出的方言声明。本补充先完成有限设计功能门，再落地。原失败日志保留，不重跑掩盖失败。

## 唯一声明操作

本批平台原语改为唯一 `retainedOutputRevisionStatements(contract)`，输出明确的 `{sqlite, postgresql}` 声明集合。闭合 nativeProjection descriptor 的资格验证只在这个共同入口完成。没有该 descriptor 的历史合同返回两套空集合；错误 descriptor 仍失败。当前合同生成原十二条 SQLite 行触发器，以及原三函数、十二条 PostgreSQL transition-table 语句。内部两个方言渲染仅承担引擎原语，不独立导出或公开业务算法；不新开 provider API、可选 fallback、数值账本或迁移。

SQLite migration 的既有十二条 SQL、PostgreSQL 每条 SQL/kind/logicalId、历史合同、已发布的 0241/0017 迁移和 V2 whole-KEEP helper 全部原样保持。PostgreSQL schema planner 消费统一操作的 postgresql 字段；SQLite 源文回归消费同一个操作的 sqlite 字段。当前 PG baseline、历史 journal/manifest、完整 report 发布与热读路径不改。

这次收敛遵循原同文件孪生高水位，不修改扫描器、规则、台账成员或原断言。公共入口是一个共同的合同投影操作，方言片段只能在平台原语内部落位；双方继续使用同一 descriptor、source 表集合、event 顺序及共同验证。

## 现有回归的兼容

当前源表 222、活跃投影 216、历史归档 6、SQLite journal 241 是已发布声明的实际人口。只更新相应 HEAD 精确预期和观测表名名单；历史冻结点和老合同不动。新 PromiseLike 类型对应真实 SQL 连接返回值，测试仍以原 await 和阻塞断言完成，无包装重试或预算变化。

受控 PG migration fixture 只接受当前 history 中 sql 完整匹配的 function/trigger，分别记录其执行并核对完整顺序；新增同事务故障回滚回归，不放宽未知 SQL 的拒绝。schema 对账从实际 schema planner 的 trigger 声明读取等价项，不把已有 PG 实现误登记为 SQLite 专属，也不修改原差异台账。node_run 血缘回归继续精确证明 node_runs 上没有补齐触发器，将 PG 查询限定到同一个原 node_runs 表。

旧 quality-index 兼容夹具在 building 期构造其历史形状，再进入 ready，保持原无 index 时的明确拒绝和原列表内容断言；另验 ready 后的原行改动必须触发已批准的完整 seal 拒绝。已合格 Task 行在 ready 后被破坏时同样明确断言 seal 拒绝；原领域的 metrics 未合格拒绝断言保持。这不是忽略 revision、删除 mark 或修改生产资格。

所有原测试人口、5000ms/60000ms/120000ms 等既有预算、统计 EOF、四桶与人民币对账不改。新增统一声明对历史空投影、非法 descriptor 和原 SQL 的覆盖。仅本次精确 format/lint 和纯 schema/AST 对拍在本机执行，AW tests/typecheck/build/压测继续交确切 SHA 的 hosted CI。上一提交三个已消费 matching 增长许可由普通后继退役；新生产内容再做一次原 scoped census，保持原 classifier、counter、validator、全部真实债与清单。

完整规模仍未通过；本补充也不代表默认 producer、CS v2 数字消费者、CLI/算力自测、before-final、seal、CS 托管联动或两个 RFC 已完成。
