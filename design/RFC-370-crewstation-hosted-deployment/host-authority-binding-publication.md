# RFC-370 H7 完整执行权 binding 与 Task 停止派发发布候选

本批补齐 SO 的完整 provider/generation binding、公开中立合同和 Task authority-loss 停止派发面。SOURCE7-R2 独立有限功能门通过；实际 bootstrap 消费、提前恢复、十九个 runtime handles、Task 原业务事务、各 named admission 与 UI 仍待接线，不能关闭 H7、A-T7、A-G、RFC 或 CS 部署。

## 源码与原行为

完整 selection 配对 authority factory、recovery 和 runtime；selected 缺项不补 native，native 借用原 startup lease，原 PID release 责任不变。两 provider 使用平台同一 DATABASE_PROVIDERS 和 DatabaseProvider 定义。resource-only 不 claim、不恢复、不启动 runtime。当前实际 bootstrap 尚未选择该 binding。

Task 的 authority-loss 切面先同步关闭新 claim/loop dispatch，再等待原已受理工作与配置/恢复的真实 ACK；迟到 startup 或排队旧 resume 不重开旧执行。原 task、owner、intent 全行保持，运行中任务不会被此切面批量取消；正常 pause/stop/shutdown 保留原 abort 和 drain 责任。真正远程运行的收据与其他 owner 工作仍由后续完整接线承担。

## 唯一原静态生成

原四条规则逐字保持。在 6bbe50dbf4f26b9aa41c9dcdd0fb5ca04d1f8381 加四个冻结生产文件与两个冻结测试文件执行一次原 scoped census，输出仅写私有文件；并行 RFC-371 未追踪测试排除，其他源码读该提交的完整 blob。生产摘要为 sha256:25e5c4d9a7a1285763db0bd1a223b301e66bfca51bd6c26a980b3f968043d220，没有因移动 HEAD 重跑。

原全部 import/exception 行保持，仅新增独立 SO composer 的 DATABASE_PROVIDERS value 与 DatabaseProvider type 两个实际引用及原精确例外：6791→6793、5962→5964。原 1219 public 行和所有 consumer 保持，新加 SO participants 的十五个中立类型出口至 1234；方法与递归字段沿用原形状生成。原 27390 owner 行保持，仅新增独立 composer 的九个符号至 27399。

background 总数仍为 366，仅原 Task restartable-loop 的 setTimeout 标记由行 115 移到 118，完整其余字段保持。mutation 总数仍为 1953，原生成器对同一个 restartable-loop 输出一个变化的完整 opaque row，前后原数据均保留，不另解释其政策字段。全体原 SCC、target、facade、effects、commons、SPI、guard 与其他 payload 保持；经典完整 inbound/outbound 数组仍 0/0。

十三个 matching 输出使用原生成结果和原 status 渲染全文。129 项 ledger 的 id/file/symbol/why/顺序及其余字段不变，只对四个实际测量增长加本次消费声明，按原纯 JSON 规则更新 payload digest；普通后继将退役这四项，不再生成 census。完整旧 STATE 和 plan 前缀保持，追加事实登记。

## Windows 覆盖与 CI 修复

独立 WF1-R1 为 push/PR 过滤和原 RFC-254 平台命令各新增四个 host-authority 回归文件；原整个 YAML 逆变换逐字一致，原命令、预算、环境、步骤和全部旧用例保留。新增 YAML 必须与未上库的 H7 两个测试文件一起发布。

前批 698feafd 的 Windows 实际为 719 pass、3 skip、1 fail，唯一失败为 W29 PostgreSQL 原完整启动体对照。独立两路径候选让 boot/verification 旧逆变换识别同文件的新解析对象；新回归经过真实 Task 严格逆变换，旧 176 条语句、全部原 case/assert/budget 和完整旧摘要保持。纯 AST 对照复现实际旧失败并恢复原摘要，不等于 hosted CI 通过。

本机只做本批格式/lint、原生成与纯 AST/字节/JSON 检查，没有 AW tests/typecheck/build/service/E2E。配套有限功能门、精确提交/远端和新精确 SHA 双 OS CI 分别留证。完成本批后继续实际 H7 与 A-G，再写各层独立 CS adapter；先完成 M0 首次部署，再逐步接入 M1–M4。
