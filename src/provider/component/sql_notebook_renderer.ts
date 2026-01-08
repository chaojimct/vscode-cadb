import * as vscode from 'vscode';

/**
 * SQL Notebook 输出渲染器
 * 负责渲染 SQL 查询结果和错误信息
 * 
 * 注意：Notebook renderer 通过 package.json 中的 notebookRenderer 配置自动注册
 * 这个类主要用于类型定义和未来可能的扩展
 */
export class SqlNotebookRenderer {
  constructor(context: vscode.ExtensionContext) {
    // Notebook renderer 通过 package.json 中的 notebookRenderer 配置自动注册
    // 这里只需要确保资源文件存在即可
  }

  dispose(): void {
    // 清理资源（如果需要）
  }
}
