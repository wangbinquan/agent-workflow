# RFC-372 Task companion 存储发布

本增量在已发布的协作五表及 SQLite 0246 / PostgreSQL 0022 之后追加 Task 自有五表：宿主运行身份、逻辑通道、进入周期、不可变消费者材料版本和原业务消费记录。entry 的计划头可以前进，材料行及最终设计快照独立保留；原输出/merge 成功事务记录消费，Finish 和调用接受不等于消费。

SQLite 0247 与 PostgreSQL 0023 是正式迁移，不使用 fixture DDL。Drizzle metadata 保留已发布的 0246 快照身份 `83c17389-93b0-4fb9-807b-8a713d573d11`；新增 0247 快照为 `e4767424-acc9-4dd3-8c37-0b6d299f4215`，以它为 predecessor。原 0245/0246 SQL 及 PostgreSQL 0021/0022 均保持。完整 contract 为 254 source / 248 active / 6 archive-only；此前八表断言全部保留。

共享 schema、roster、journal、contract 与相关回归提交完整当前内容，包含并行会话已添加的八表 roster 断言；不包含未 export 的其他 RFC 新表或未完成脑图产品代码。此前正式双 provider 开图、消费与 native runner 已在这组表上执行，证据见实施记录；新 schema 专用回归随源码提交，按用户要求留到整体开发后的集中验证。该存储发布不代表 RFC、完整 TaskEngine、正式浏览器或部署验收完成。
