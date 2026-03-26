/**
 * 单元格内容预览插件：元数据与启用状态（与数据库驱动管理页并列配置）
 */

export type PreviewPluginRegistration = {
  id: string;
  /** 设置页与预览侧栏展示用：数据格式名称 */
  dataFormatLabel: string;
  description?: string;
  /** 非空时与驱动管理页一致解析 node_modules 版本；空则展示扩展内置渲染 */
  npmDependencyNames?: string[];
};
