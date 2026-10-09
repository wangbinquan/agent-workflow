# 实际窗口的原质量索引回归

2026-10-09：源码 `afcba9503020fc3a1f57f04945ee71170eb6e8f5` 和正常后继 `70cddb821d717c1919bea796b84fcc46f50bbb7a` 已上库。视觉 CI 37865874739 成功；Windows 37865874753 的原功能结果为 1065 pass、3 skip、1 fail，完整失败日志保留。

新增双 provider 回归在来源 pending 已清除后，要求从不存在的 `source-projection-pending` 质量索引取得空任务页。原 `assertCompleteQualityTaskIndex` 要求实际原因行和封存索引存在，否则返回 `not-ready`，这正是本次原错误；不把不存在的原因伪造成已封存的零人口。

夹具保留“补齐后缺口消失”的原意，改为从原 `quality` 集合核对该原因不存在，再断言无索引的明细请求返回原 `not-ready` 和原错误正文。所有其他数字、四桶、冻结 CNY、pending/未受理尝试、唯一归属/共享记录、分页、原输入、断言及 120 秒预算保持。没有修改生产页面或统计计算，没有本机运行 AW tests/typecheck/build/services。有限独立功能复核和新确切 SHA托管 CI分别登记；两个 RFC尚未关闭。

主 CI `37865874736` 另定位三个前台失败：ready 夹具被联合类型注解导致回调内 `metrics.records` 无法收窄；原报告请求已创建但 React 尚处于加载阶段时同步查询窗口内按钮；新的时间未分配共用 Dialog 未登记到原双向 AST 清单。只修测试：将已知 ready 夹具显式注解为 ready 分支、等待实际 radio 渲染再保留 `aria-checked=true` 断言，并新增该单一实际 Dialog 的既有 family 登记及原渲染用例出处。原四桶、金额、键盘切换、时间语义、下钻/返回过滤、人口、预算、原双向清单断言保持。主 CI 原失败继续保留，新 SHA 主 CI 和 Windows 另验。

验收排期 `01M4F1S2FMEDZ6W6RZFCDA9V18` 已在 2026-10-09 08:44 实际自动启动任务 `01M4F1WGD19A31A5SZ02NDJ23K` 并完成，首次触发后停用。原报告 ready 为 33,589 Token（输入 14,015 / 缓存读取 19,072 / 缓存写入 0 / 输出 502）、人民币验收估值 ¥0.041582；原 SDK 独立 EOF 和冻结费率对账继续。GitLab 的原 API 实际 500，Redis 原日志证明 Docker 虚拟机磁盘满导致 RDB 写入失败；尚未修复或计作 Git 覆盖。

2026-10-09 后继 `c73756628b9ee2705918889067ac991e48861274` 的 Windows 37868217983 与视觉检查 37868217997 成功。主 CI 37868217985 的 Ubuntu/Mac/Windows 前台分片 2 又定位同一新增用例的返回分支：返回保持原任务追踪页签，而时间口径 radio 仅在总览渲染；第 386 行在错误页签查询该控件后按 ArrowLeft 失败。独立有限首轮 VALID/FAIL 的唯一 P2 确认仅改等待仍会超时，原失败回执保留。后继先点击原“总览”页签，再用 `await findByRole` 等待原窗口内 radio 并发送原 ArrowLeft；所有原断言、过滤恢复、单报告数量、全程详情、四桶/CNY、1001/10001/20001 人口及预算保持。生产组件与原架构产物不变，不运行本机 AW tests/typecheck/build/services。原失败保留，有限独立检视和新确切 SHA 主/Windows CI分别验收。

真实自动排期已完成独立原 SDK 与冻结费率核对：4 个唯一原步骤、13 类原集合和 5 个维度全部 EOF，28 个实际传输页、17 个指标行一致，33,589 四桶 Token 与 ¥0.041582 均精确相同。Docker 已按人类批准的 11 个旧自有镜像、13 个闲置缓存清单清理，后者报告回收约 1.804 GB；GitLab 原 API 恢复 200、演示缓存原入口 fetchOk=true。8 个 legacy 原准备重试均成功，但随后原默认 `zhipuai/glm-5.2` 返回真实 401，模型退出失败；不将其计为成功模型覆盖。3 个 current 案例仍在原入口执行，Git/全 current care 和 CS 部署继续。
