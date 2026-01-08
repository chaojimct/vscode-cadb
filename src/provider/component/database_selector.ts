import * as vscode from "vscode";
import { DatabaseManager } from "./database_manager";

/**
 * 数据库选择器 - 在状态栏显示和管理当前数据库选择
 */
export class DatabaseSelector {
  private statusBarItem: vscode.StatusBarItem;
  private databaseManager: DatabaseManager;

  constructor(databaseManager: DatabaseManager) {
    this.databaseManager = databaseManager;

    // 不再创建状态栏项，功能已移至 Notebook 工具栏
    // 保留 statusBarItem 引用以避免错误，但不显示
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.hide();
  }

  /**
   * 更新状态栏显示（已禁用，功能移至 Notebook 工具栏）
   */
  public updateStatusBar(): void {
    // 不再更新状态栏，功能已移至 Notebook 工具栏
      this.statusBarItem.hide();
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
