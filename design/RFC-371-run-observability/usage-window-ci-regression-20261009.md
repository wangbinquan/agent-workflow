# 实际窗口的原质量索引回归

2026-10-09：源码 `afcba9503020fc3a1f57f04945ee71170eb6e8f5` 和正常后继 `70cddb821d717c1919bea796b84fcc46f50bbb7a` 已上库。视觉 CI 37865874739 成功；Windows 37865874753 的原功能结果为 1065 pass、3 skip、1 fail，完整失败日志保留。

新增双 provider 回归在来源 pending 已清除后，要求从不存在的 `source-projection-pending` 质量索引取得空任务页。原 `assertCompleteQualityTaskIndex` 要求实际原因行和封存索引存在，否则返回 `not-ready`，这正是本次原错误；不把不存在的原因伪造成已封存的零人口。

夹具保留“补齐后缺口消失”的原意，改为从原 `quality` 集合核对该原因不存在，再断言无索引的明细请求返回原 `not-ready` 和原错误正文。所有其他数字、四桶、冻结 CNY、pending/未受理尝试、唯一归属/共享记录、分页、原输入、断言及 120 秒预算保持。没有修改生产页面或统计计算，没有本机运行 AW tests/typecheck/build/services。有限独立功能复核和新确切 SHA托管 CI分别登记；两个 RFC尚未关闭。

主 CI `37865874736` 另定位三个前台失败：ready 夹具被联合类型注解导致回调内 `metrics.records` 无法收窄；原报告请求已创建但 React 尚处于加载阶段时同步查询窗口内按钮；新的时间未分配共用 Dialog 未登记到原双向 AST 清单。只修测试：将已知 ready 夹具显式注解为 ready 分支、等待实际 radio 渲染再保留 `aria-checked=true` 断言，并新增该单一实际 Dialog 的既有 family 登记及原渲染用例出处。原四桶、金额、键盘切换、时间语义、下钻/返回过滤、人口、预算、原双向清单断言保持。主 CI 原失败继续保留，新 SHA 主 CI 和 Windows 另验。

验收排期 `01M4F1S2FMEDZ6W6RZFCDA9V18` 已在 2026-10-09 08:44 实际自动启动任务 `01M4F1WGD19A31A5SZ02NDJ23K` 并完成，首次触发后停用。原报告 ready 为 33,589 Token（输入 14,015 / 缓存读取 19,072 / 缓存写入 0 / 输出 502）、人民币验收估值 ¥0.041582；原 SDK 独立 EOF 和冻结费率对账继续。GitLab 的原 API 实际 500，Redis 原日志证明 Docker 虚拟机磁盘满导致 RDB 写入失败；尚未修复或计作 Git 覆盖。
