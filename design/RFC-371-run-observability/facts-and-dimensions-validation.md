# RFC-371 完整执行事实、缺口 Task 和维度明细验证

本批对应用户所见“完整统计尚未就绪”后整页消失，以及维度数字缺少实际原 Task 下钻。原 EOF 报告独立核对 Task/attempt 人口后保留执行事实；用量缺口不成为零值，不将部分 Token 或金额升级为完整总量。质量列表由同 snapshot 的原 Task fold 产生，不设总体数量上限。

批准设计：`usage-gaps-and-tasks.md`，DESIGN1 指纹 `2b79b0744b345d4fda4cc50471c58c97240b703e95e16fe39976aa92058cd0f8`、独立 PASS `d6cf39c393b6dcade261d5a2bbcbd02e9b912b0a8ab0021ac8bb5e52292d7d61`。SOURCE16 原三 P2/FAIL 保存于私有回执，不覆盖；SOURCE18 v2 指纹 `1b0da7765f458c585651d97f0a913a72333f7eb8d9329e5d441d7e2f2920fc08`，独立 PASS `7de1d84282f8263f978090fc692bb750903dfe6cf70d33c04c2c86103d3b7dde`，18候选、7直接控制、6引用与清单首尾稳定。

原质量索引有格式标记、原 reason/Task 父人口封存核对和同 report/snapshot 分页；旧无索引、页人口变化、未知 parent 均明确拒绝。显示真实缺口原因的对应 Task 列表，使用共享 Card/Dialog/Pager；关闭或 Task 返回仍在原父维度/质量页面和焦点。Task 名称维持任务列表样式。实际 Task 总量不与维度贡献混算。模型、注册配置、受理名称、协议和人民币资格来自原冻结数据。

新增 backend 回归使用真实 SQLite/PostgreSQL harness：202 Task 中201缺口任务，按37条传输逐页到 EOF，核对全体原 ID、父计数与未知值；随后删除旧报告的质量索引标记并验证直接 API 拒绝。旧 facts UI 回归全部保持，新 zh/en 单页/最后页质量 Task 下钻、真正鼠标触发焦点及新维度 Dialog 回归交 hosted CI。没有运行 AW 本机测试、类型检查、构建或服务；本机 scoped ESLint/Prettier 均退出0。

原官方静态 census 一次，固定已发布 b6195a0 加18个候选，不把外部 WIP 当生成输入。13产物、production2958、原129库存和原 canonical validator通过。仅 owner/root 净增8（26449→26457）；原可枚举规则、40 required SPI、69 target edges、302条原债务及公开面/mutation规则不变；唯一一次增长许可需在匹配提交后正常退役。原 SOURCE10 native owner 页/持久 ACK 基础仍单列待装配，不在本批发布或完成宣称内。

当前 live AW 原报告425 Task/2869 attempt/14 accepted invocation，缺口 reason 数334/1/1相互可能重叠。该诊断只证明旧 live API 人口与未就绪原因；不能用本批 fixture 或静态 PASS 声称已恢复真实 Token。必须继续 native producer/原历史上限清除与正式任务四桶/CNY核对，100K Task/10M usage、所有普通/Windows/定时 exact-SHA CI 和正式浏览器也未完成。

## 2f7 新确切 CI 的测试 API 与完整弹窗登记修正

2f7c3b672dd8007849348bffe05a95fef7703457 已发布34路径；主CI37172781557尚在运行，但静态job111349000064和frontend Ubuntu/Mac/Windows第三分片111349000141/177/225已明确失败，完整原日志保留。不把未终态workflow、有限SOURCE/META PASS或其它已完成job升格为全绿。

三处实际失败只涉及本批测试：ByRoleOptions不支持exact字段（字符串name原默认精确匹配保持）；本仓未装配toBeDisabled Chai扩展（改核原HTMLButtonElement.disabled===true，分页/前页/首页原断言和预算保持）；RFC-198原双向严格AST清单漏列新增dimension及迁出的quality Dialog，同时旧root Dialog已迁出。只将旧CompleteRunObservability一项移到真实Quality并登记真实Dimension，原95调用文件变96，其它原登记与3个scanner函数字节保持。

原scanner/相同完整frontend/src语料的纯AST对拍与实际96登记完全相等，两测试完整原文逆向核对只包含上述精确编辑；没有导入/执行任何Vitest或Bun用例，没有本机AW test/typecheck/build/service。目标format/lint已通过，production18源码及原13canonical未因这些测试修正重开或重跑census。新精确SHA hosted验证仍待，旧四job失败和原所有FAIL/cancelled保留。真实浏览器、E2E旧运输合同迁移、native实际owner/ACK/历史caps、Token/CNY真实任务、CS部署和规模验收继续，两RFC In Progress。
