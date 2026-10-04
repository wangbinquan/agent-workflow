# 已收到用量与泳道修复的正式 CI 后继

`38572c666365e0d5542af421a6b849117f874eca` 的 Windows `37206764230` 正式失败。四处错误分别为：新增趋势测试只传 tab 却声明完整 ObservationSearch；span 拒绝回归的闭包未保留 facts 窄化；quality 回归误将 Task 身份放在不接受该字段的 overview query；独立指标 Map 读取仍可能 undefined。原日志保留，不改记为通过。

有限修复分别传原 fixture 默认的完整时间范围；先保存同一已验证 facts 的 gaps；沿实际 service.request 第四个 taskId 参数取得真正独立的原 Task 生命周期报告；在对拍前明确拒绝缺独立指标。202 Task、201 缺 invocation 人口、37 续页至 EOF、全部原因和四桶拒绝、旧索引拒绝、双 provider 及原60000ms预算均保持，不能用全范围报告代替独立 Task。

同 SHA 视觉 `37206563345` 正式失败在 daemon ready 之前。原 stderr 为 `Failed to start server. Is port 39309 in use?`，现有 harness 只识别 EADDRINUSE / address already in use，因此已有三次新端口重试未发生。后继只识别这一准确的 Bun 端口占用诊断，继续先结束原失败 child 再申请新 OS 端口。原三次上限、ready 等待、home 归属清理、实际浏览器断言与其时间预算全部保持；其他启动错误继续立即失败。新增正常第三次启动、三次碰撞终态及非碰撞一次拒绝的真实 fake-child 生命周期回归。

本片不改变生产用量协议、报表人口、采集完整资格、人民币或泳道页面行为。只做有限实现门、精确 format/lint 和静态内容核对；用例及全仓结论继续使用新确切 SHA hosted CI。原失败与取消历史、并行开发和 native owner／规模未完成项保持；两个 RFC 仍进行中。

首 SOURCE6 留存唯一 P2／FAIL：quality 测试 build 仍只给 Task facts 工厂传 executor，独立请求的真实 Task 身份没有进入原 population 的闭包 seed。窄后继只补 `createCompleteTaskObservationFacts(snapshot.executor, report.request.taskId)`，使全窗请求仍有202任务，单 Task 原生命周期请求恰为1任务；原 population、递归子任务、分页及所有断言／预算不变。其余四项已核增量保持字节相同，有限后继门单独留证，不改写原失败。

同385 SHA 的全量实际日志还揭示四处有限回归：Agent 页签复用了 Task 详情的“Agent 贡献”标题，原真实钻取用例找不到“跨任务 Agent 汇总”；旧报表的未知原因用例只等同步 Card 标题，就立即读取异步质量页；缺一条原记录的双 provider 用例仍期望缺口 metrics 只有两字段，未核对批准保留的4条已收到费用原记录；原数字人口拒绝回归在改变 numericRecords 时先触发已有费用覆盖资格，预期错误却仍只允许用量资格。后继分别复用既有中英文 crossTaskAgents 文案、等待实际原因行、精确断言4／4及CNY0.0005并保留完整Token／费用总量未知、按原被破坏人口匹配实际资格拒绝。所有人口、全部分页、错误输入、完整总量拒绝及原用例／等待预算保持，不修改生产报表协议或投影。

`a457563d42eca56b26f3c93ccb1073331bec66a7` 的视觉 CI `37209908908` 已正式成功；普通 CI 与其后继 exact-SHA 各自留证。该标题改动只替换现有渲染字符串，没有新增、删除或改名符号；新 canonical 必须使用原 committed source、完整库存及原规则，保留并行生成在制品，不能把本文或局部通过当作 RFC 关闭依据。

实际本机页面沿原 Agent 汇总、贡献、真实并行 Task、返回原弹窗和 Escape 恢复原维度焦点完成验收。原执行列表也有同名 Agent 按钮，因此真实 E2E 的开头全页名称定位现以已有 `data-observation-dimension` 身份限定汇总触发器，仍使用原 button role／名称和真实点击；保留后续原弹窗、Task、时间、泳道、间距及焦点断言，不能用任意 first 匹配掩盖歧义。其新增冻结后继单独检视，前一 SOURCE5 不代签新增 E2E 字节。

`bba36c8960d81718987b26c100d25ff767fa3f14` 的视觉与 Windows 正式通过；full nightly `37213909952` 的原 shard4 失败仍留存。该原 trace 的 Agent 弹窗已经实际显示 Task usage 表和原任务行，但两处标题当前英文均为 Contributions by task，用例却等待不存在的 Task contributions。后继按原 Task usage region 所属的唯一 Card 定位，继续核当前真实标题、原任务钻取／返回／Escape及全部几何／数据断言，避免拿另一个同标题的汇总 Card 冒充原贡献列表。原失败没有改记为通过。

同 trace 的设置卡片间距用例第一次得到负间距、原重试通过：两次独立 boundingBox 之间原运行时／费率卡片完成异步加载，读到两个不同时刻的高度。后继在同一 DOM evaluate 同时读两个真实矩形与原 --space-4；保持1280／390两个宽度、可见性与非空、同一标准间距和原所有超时预算，不通过增加等待或放宽精度掩盖实际布局错误。此片只有原 E2E 与本文，两 RFC 的 native／规模剩余工作保持。

960ff33566298ec9fa20df9413b05e886b1c4ab6 的 visual37218905824与Windows37218909187正式成功，主CI37218451883 cancelled；full37218912081与webkit37218914986在同一原断言正式失败，定位Usage by actual model。实际生产Card一贯使用runObservability.actualModel，其英文是Actual model／中文实际模型；runObservability.models的旧文案不是该Card标题。后继仅按实际Card标题补正这一可见性断言，保留模型卡片存在性、所有原钻取／返回／Escape、四桶／CNY、1280／390、标准间距、15秒等待与全部原预算；原失败和取消不改记通过，继续新确切SHA的正式与定时CI。
