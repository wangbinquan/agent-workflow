// RFC-450 — integration 给模块外的类型合同。RFC-577 起代码平台连接的路由在本模块的 inbound 里，这里只剩模块外仍在用的连接探测结果
// 与它引用的凭据形状。
export type {
  CodeHostConnectionCredential,
  CodeHostConnectionProbe,
} from '../application/ports/codeHostConnections'
