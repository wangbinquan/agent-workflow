# RFC-370：原生观察脚本 Windows 失败诊断

状态：有限 CI 诊断，尚未获得实际拒绝原因；不是功能修复完成或完整 H7／A-G／部署验收。

提交 `0fd9973f06967c3628205ea0bcaec5501428b7b6` 的 Windows run `37502737291`、job `112403599101` 正式 completed／failure。685 用例中 681 pass、3 skip、1 fail，16774 expect；唯一失败为原 RFC310 的全局自定义观察脚本用例，在实际 `validate(created.id)` 的 resolves 断言收到 rejected promise，耗时 11619.51ms。原日志仅显示拒绝状态，没有打印原始 Error；当前不能将原因确定为脚本超时、解释器、输出或其它失败。

该测试保留四次原生执行、每次原 10s 与整个测试的 50s 预算及全部原断言。本片只在已确定的第一处真实 native validate promise 添加诊断 catch：打印原 error，然后重新抛出同一对象，原 resolves／observationCount 断言仍决定通过或失败。不转换异常，不吞掉拒绝，不增加重试，不修改生产代码或任一执行预算。

纯整文件／AST inverse 验证去掉这一个诊断 catch 和对应注释后与原文件相同，全部 expect、测试名称与 timeout 保持。只运行自有 format／lint 与纯源文验证，无本机 AW tests／typecheck／build／service。独立有限功能复核及新 exact-SHA Windows CI 分别留证；依据新 CI 的实际原因继续修复，不能用诊断提交冒称已解决原生失败。

主 run `37502737473` 的完整功能结论仍待终态；既有失败不改记成功。此前分层、类型入口及观察器 fixture 的有限 PASS 保留，H7／purpose callers／A-T7／A-G、CS adapter 和 M0～M4 继续，尚无 aw-in-CS 实际部署。
