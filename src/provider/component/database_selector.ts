import * as vscode from "vscode";
import { CaEditor } from "./editor";

/**
 * 数据库选择器 - 在状态栏显示和管理当前数据库选择
 */
export class DatabaseSelector {
  private statusBarItem: vscode.StatusBarItem;
  private editor: CaEditor;

  constructor(editor: CaEditor) {
    this.editor = editor;

    // 创建状态栏项（位于右侧，优先级 100）
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );

    // 设置命令
    this.statusBarItem.command = "cadb.sql.selectDatabase";
    this.statusBarItem.tooltip = "点击选择数据库连接和数据库";

    // 初始化显示
    this.updateStatusBar();

    // 监听活动编辑器变化
    vscode.window.onDidChangeActiveTextEditor(() => {
      this.updateStatusBar();
    });
    
    // 监听活动 Notebook 变化
    vscode.window.onDidChangeActiveNotebookEditor(() => {
      this.updateStatusBar();
    });
  }

  /**
   * 更新状态栏显示
   */
  public updateStatusBar(): void {
    const currentConnection = this.editor.getCurrentConnection();
    const currentDatabase = this.editor.getCurrentDatabase();

    // 安全地获取 label 字符串
    const connectionLabel = currentConnection?.label?.toString() || '';
    const databaseLabel = currentDatabase?.label?.toString() || '';

    console.log('[DatabaseSelector] 更新状态栏:', {
      connection: connectionLabel,
      database: databaseLabel,
      hasConnection: !!currentConnection,
      hasDatabase: !!currentDatabase
    });

    // 根据当前选择状态设置图标和文本
    if (currentConnection && currentDatabase) {
      // 已选择连接和数据库
      this.statusBarItem.text = `$(database) ${connectionLabel} / ${databaseLabel}`;
      this.statusBarItem.backgroundColor = undefined; // 正常状态
      this.statusBarItem.tooltip = "点击选择数据库连接和数据库";
    } else if (currentConnection) {
      // 只选择了连接，未选择数据库
      this.statusBarItem.text = `$(database) ${connectionLabel} $(warning)`;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
      this.statusBarItem.tooltip = "已连接，但未选择数据库。点击选择数据库";
    } else {
      // 未选择连接
      this.statusBarItem.text = `$(database) 选择数据库`;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground"
      );
      this.statusBarItem.tooltip = "未连接数据库。点击选择连接和数据库";
    }

    // 在 SQL 文件或 SQL Notebook 中显示状态栏项
    // 如果已选择数据库，即使不在 SQL 文件中也显示（方便用户看到当前选择）
    const activeEditor = vscode.window.activeTextEditor;
    const activeNotebookEditor = vscode.window.activeNotebookEditor;
    
    const isSqlFile = activeEditor && activeEditor.document.languageId === "sql";
    const isSqlNotebook = activeNotebookEditor && 
      activeNotebookEditor.notebook.notebookType === "cadb.sqlNotebook";
    const hasDatabaseSelected = currentConnection && currentDatabase;
    
    // 如果已选择数据库，或者当前在 SQL 文件/Notebook 中，则显示状态栏
    if (isSqlFile || isSqlNotebook || hasDatabaseSelected) {
      this.statusBarItem.show();
    } else {
      this.statusBarItem.hide();
    }
  }

  /**
   * 显示状态栏项
   */
  public show(): void {
    this.statusBarItem.show();
  }

  /**
   * 隐藏状态栏项
   */
  public hide(): void {
    this.statusBarItem.hide();
  }

  /**
   * 清理资源
   */
  public dispose(): void {
    this.statusBarItem.dispose();
  }
}
