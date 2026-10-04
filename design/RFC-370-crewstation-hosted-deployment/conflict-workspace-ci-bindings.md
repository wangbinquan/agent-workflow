# RFC-370 冲突切面的 CI 接线补正

2026-10-05。精确 SHA `148436c8c02d26958199bf74051028adcc8b958e` 的主 CI `37212411283` 最终 cancelled，50 jobs 中 34 success、13 failure、3 cancelled；Windows `37213640174` cancelled，Typecheck 已 success。后继 `bba36c8960d81718987b26c100d25ff767fa3f14` 的 Windows `37213907338` completed/success，不改记旧 run。

## 实际失败与修复

原 CI 在双 provider 的冲突根装配和真实 Mission 中发现工作目录泄漏：工作区 factory 生成的不透明引用被交给 file evidence staging。证据与工作区是独立能力，选择后者不能改变前者的解释规则。DA composition 的 native evidence 默认根与 staging 继续以安装 appHome 的本地路径选定；已显式选择的 evidence reader/writer 保持优先。原 local factory 的 resolve 也是同一 join，native 分支路径和初始化时机不变。

不透明 Mission 的完整测试证据 adapter 同时提供已有 EvidenceDocumentCommands；文档写入仍经原 file writer 在该 fixture 自己的临时根执行实际字节导入，应用不解释 workspace 引用。增加双 provider 的真实 HTTP 装配回归，验证选择冲突 owner 时 native evidence 仍在安装根创建 blobs、bundles、staging，没有工作区分配或内容 acquire。旧泄漏检测保持。

新增 DE Case 测试的 issue typeId 改为实际合同 `development.issue-handling`，其他真实 Git、持久 checkpoint、重组装、same-scene 及等待断言保留。两项旧根接线 oracle 明确检查 `selectDevelopmentWorkspaceEffectBinding` 的原参数及所选结果；仍逐个检查全部九处调用、唯一属性、原词法 owner 和 CLI 初始／替换会话转交，不放宽为任选 receiver。

## 有限验证与发布边界

仅目标 format/lint、纯源码／字节逆恢复和有限功能检视；不运行本机 AW tests/typecheck/build/service。五份 TS 与本记录独立冻结，保留旧 CI 原日志和所有失败回执。候选发布 SOURCE24 的 66 个描述符保持；两项有限检视通过后，以明确组合快照生成一次原 canonical，分别提交源码与匹配清单。

修复仍待新 exact-SHA hosted CI。完整 A-G、各层 CS adapters、M0 实际部署和 M1～M4 仍开放；尚无 AW-in-CS 部署，不关闭 RFC。
