# RFC-370 readonly live evidence 的 CI 后继

9d74a1e1db0c3cfb795aab4f71f064525dda39f5 的 Windows run 37311325395 正式 failure。job 111767182039 在 RFC-254 platform suites 得到287 pass／3 skip／1 fail，唯一失败是 subagent-live-capture-source.test.ts 仍断言 `alreadyInsertedPartIds?: Map<string, Set<string>>`。生产中同一输入已在上一笔投影为 `ReadonlyMap<string, ReadonlySet<string>>`，原 live owner 的 Map／Set 更新和 post-run get／size／has 去重没有改变。新增实际 handle／Map identity 和 owner 后续更新回归在该 run 通过；这不替代新确切 SHA 整体 CI。

本后继只映射该一项源码类型断言，五个原用例、其余全部断言及预算保持。源码、整个原 capture 算法、native writer 和 workflow 不改；并行新工厂及观测 WIP 不纳入提交。

同一正常后继退役9d74匹配源码已消费的三条许可：imports6402、public1156、owners26833。129原有序库存、所有 baseline／why／其余字段保持；只有这三个 allowGrowth 删除，并使用原 provenance helper 更新摘要。不重新 census 或源码门。第一笔33路径发布在 commit 前两次停止的回执分别保留：首次默认 Git rename 展示折叠 old/new 路径，后继二次 add 已暂存删除路径失败。最终使用完整 no-renames pathset 和每项 staged 字节核验，普通共享 index 提交成功；无 unstage／路径移除／历史重写。

本片只做精确格式／lint和纯JSON／字节证明，独立有限功能门与新确切 SHA hosted CI分别留证；不运行本机AW tests／typecheck／build／service。完整 selected factory／三入口／全部真根、脚本／执行权恢复及A-G继续，CS adapters与M0～M4未完成，AW尚未部署CS，RFC仍开放。
