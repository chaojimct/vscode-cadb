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
        this._updateStatusBar();
      })
    );

    // 监听 Notebook 内 cell 选择变化，切换焦点时展示当前 cell 的连接/库
    this._disposables.push(
      vscode.window.onDidChangeNotebookEditorSelection((e) => {
        if (e.notebookEditor.notebook.notebookType === 'cadb.sqlNotebook') {
          this._updateStatusBar();
        }
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

    if (isSqlNotebook || isSqlFile) {
      this._statusBarItem.show();
    } else {
      this._statusBarItem.hide();
    }
  }

  /**
   * 获取当前聚焦的 cell（Notebook 中）
   */
  private _getFocusedCell(): vscode.NotebookCell | undefined {
    const editor = vscode.window.activeNotebookEditor;
    if (!editor || editor.notebook.notebookType !== 'cadb.sqlNotebook') return undefined;
    const sel = (editor as any).selection;
    const start = sel && typeof sel.start === 'number' ? sel.start : 0;
    try {
      return editor.notebook.cellAt(start);
    } catch {
      return undefined;
    }
  }

  /**
   * 更新状态栏显示内容
   * 在 SQL Notebook 中优先展示当前聚焦 cell 的 cell.metadata.cadb，否则展示全局选择
   */
  private _updateStatusBar(): void {
    const editor = vscode.window.activeNotebookEditor;
    const isSqlNotebook = editor?.notebook?.notebookType === 'cadb.sqlNotebook';
    let connectionLabel = '';
    let databaseLabel = '';
    let useCellSetting = false;

    if (isSqlNotebook) {
      const cell = this._getFocusedCell();
      const cadb = cell?.metadata?.cadb as { datasource?: string; database?: string } | undefined;
      if (cadb?.datasource && cadb?.database) {
        connectionLabel = cadb.datasource;
        databaseLabel = cadb.database;
        useCellSetting = true;
        this._statusBarItem.command = 'cadb.notebook.setCellDatabase';
      }
    }

    if (!useCellSetting) {
      const currentConnection = this._databaseManager.getCurrentConnection();
      const currentDatabase = this._databaseManager.getCurrentDatabase();
      connectionLabel = currentConnection?.label?.toString() || '';
      databaseLabel = currentDatabase?.label?.toString() || '';
      this._statusBarItem.command = 'cadb.selectDatabase';
    }

    if (connectionLabel && databaseLabel) {
      this._statusBarItem.text = `$(database) ${connectionLabel} / ${databaseLabel}`;
      this._statusBarItem.tooltip = useCellSetting
        ? `当前 Cell: ${connectionLabel} - ${databaseLabel} (点击更换)`
        : `当前连接: ${connectionLabel} - ${databaseLabel}`;
      this._statusBarItem.backgroundColor = undefined;
    } else if (connectionLabel) {
      this._statusBarItem.text = `$(database) ${connectionLabel} (未选择数据库)`;
      this._statusBarItem.tooltip = useCellSetting
        ? `当前 Cell 未设置数据库 (点击设置)`
        : `当前连接: ${connectionLabel} (未选择数据库)`;
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