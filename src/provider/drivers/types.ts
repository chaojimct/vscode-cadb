/**
 * 数据库驱动可插拔：能力声明与 Webview 展示用元数据
 */

/** 驱动能力（后续可扩展：表结构编辑、导出等） */
export interface DriverCapabilities {
  /** 树节点「数据库」下支持创建库向导（如 MySQL） */
  createDatabase?: boolean;
  /** 可作为 SQL 执行 / 状态栏选库等 SQL 通道的目标 */
  sqlExecutionTarget?: boolean;
  /** 支持在资源树中删除库/表等（当前实现依赖 MySQL 连接） */
  supportsTreeDelete?: boolean;
  /** SQL 悬浮/元数据解析等（当前实现绑定 MySQL 协议） */
  supportsSchemaHover?: boolean;
}

/** Webview 下拉用 */
export interface DriverSelectOption {
  id: string;
  label: string;
  description?: string;
}
