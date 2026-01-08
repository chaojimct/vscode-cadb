import * as vscode from 'vscode';
import { DatabaseManager } from './database_manager';

export class DatabaseStatusBar {
  private _statusBarItem: vscode.StatusBarItem;
  private _databaseManager: DatabaseManager;
  private _disposables: vscode.Disposable[] = [];

  constructor(databaseManager: DatabaseManager) {
    this._databaseManager = databaseManager;
    
    // 创建状态栏项
    this._statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    
    this._statusBarItem.command = 'cadb.selectDatabase';
    this._updateStatusBar();
    
    // 监听数据库选择变化
    this._disposables.push(
      this._databaseManager.onDidChangeDatabase(() => {
        this._updateStatusBar();
      })
    );
    
    // 监听编辑器变化，确保在SQL文件中正确显示
    this._disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this._updateStatusBarVisibility(editor);
      })
    );
    
    // 监听Notebook编辑器变化
    this._disposables.push(
      vscode.window.onDidChangeActiveNotebookEditor(() => {
        this._updateStatusBarVisibility();
      })
    );
    
    // 初始化状态栏
    this._updateStatusBarVisibility();
  }

  /**
   * 更新状态栏可见性
   */
  private _updateStatusBarVisibility(editor?: vscode.TextEditor): void {
    const activeNotebookEditor = vscode.window.activeNotebookEditor;
    const isSqlNotebook = activeNotebookEditor && 
      activeNotebookEditor.notebook.notebookType === "cadb.sqlNotebook";

    const targetEditor = editor || vscode.window.activeTextEditor;
    // 显示在SQL Notebook或SQL文本文件中
    const isSqlFile = targetEditor?.document.languageId === 'sql';
    
    console.log('[DatabaseStatusBar] _updateStatusBarVisibility', { isSqlNotebook, isSqlFile, editorLanguage: targetEditor?.document.languageId });

    if (isSqlNotebook || isSqlFile) {
      this._statusBarItem.show();
    } else {
      this._statusBarItem.hide();
    }
  }

  /**
   * 更新状态栏显示内容
   */
  private _updateStatusBar(): void {
    const currentConnection = this._databaseManager.getCurrentConnection();
    const currentDatabase = this._databaseManager.getCurrentDatabase();

    const connectionLabel = currentConnection?.label?.toString() || '';
    const databaseLabel = currentDatabase?.label?.toString() || '';
    
    if (currentConnection && currentDatabase) {
      this._statusBarItem.text = `$(database) ${connectionLabel} / ${databaseLabel}`;
      this._statusBarItem.tooltip = `当前连接: ${connectionLabel} - ${databaseLabel}`;
      this._statusBarItem.backgroundColor = undefined;
    } else if (currentConnection) {
      this._statusBarItem.text = `$(database) ${connectionLabel} (未选择数据库)`;
      this._statusBarItem.tooltip = `当前连接: ${connectionLabel} (未选择数据库)`;
      this._statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
    } else {
      this._statusBarItem.text = '$(database) 未连接';
      this._statusBarItem.tooltip = '点击选择数据库连接';
      this._statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground"
      );
    }
  }

  /**
   * 显示状态栏
   */
  public show(): void {
    this._statusBarItem.show();
  }

  /**
   * 隐藏状态栏
   */
  public hide(): void {
    this._statusBarItem.hide();
  }

  /**
   * 销毁资源
   */
  public dispose(): void {
    this._statusBarItem.dispose();
    this._disposables.forEach(disposable => disposable.dispose());
  }
}