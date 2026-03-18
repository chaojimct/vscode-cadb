import * as vscode from 'vscode';
import { DataSourceProvider } from '../database_provider';
import { Datasource } from '../entity/datasource';
import type { DatabaseManager } from './database_manager';

interface ConnectionCache {
  datasourceName: string;
  databaseName: string;
  connection: any;
  lastUsed: number;
}

export class SqlNotebookController {
  private readonly _controller: vscode.NotebookController;
  private readonly _provider: DataSourceProvider;
  private readonly _context: vscode.ExtensionContext;
  private readonly _databaseManager: DatabaseManager;
  private readonly _connectionCache = new Map<string, ConnectionCache>();
  private readonly _connectionTimeout = 5 * 60 * 1000; // 5 分钟超时

  constructor(
    id: string,
    notebookType: string,
    label: string,
    provider: DataSourceProvider,
    context: vscode.ExtensionContext,
    databaseManager: DatabaseManager
  ) {
    this._provider = provider;
    this._context = context;
    this._databaseManager = databaseManager;

    this._controller = vscode.notebooks.createNotebookController(
      id,
      notebookType,
      label
    );

    this._controller.supportedLanguages = ['sql'];
    this._controller.supportsExecutionOrder = true;
    this._controller.executeHandler = this._execute.bind(this);
    
    // 初始化描述
    this._updateDescription();
    
    // 监听数据库选择变化
    this._databaseManager.onDidChangeDatabase(() => {
      this._updateDescription();
    });
    
    // 定期清理过期的连接
    setInterval(() => {
      this._cleanupConnections();
    }, 60000); // 每分钟检查一次
    
    // 监听 Active Notebook 变化，自动恢复连接状态
    vscode.window.onDidChangeActiveNotebookEditor((editor) => {
      if (editor && editor.notebook.notebookType === notebookType) {
        this._restoreConnectionFromMetadata(editor.notebook);
      }
    });

    // 初始化时如果已有激活的 SQL Notebook，尝试恢复
    if (vscode.window.activeNotebookEditor && vscode.window.activeNotebookEditor.notebook.notebookType === notebookType) {
      this._restoreConnectionFromMetadata(vscode.window.activeNotebookEditor.notebook);
    }
  }

  /**
   * 尝试从 Notebook 元数据中恢复连接信息
   */
  private async _restoreConnectionFromMetadata(notebook: vscode.NotebookDocument): Promise<boolean> {
    const metadata = notebook.metadata;
    if (metadata && metadata.datasource && metadata.database) {
      const currentConn = this._databaseManager.getCurrentConnection();
      const currentDb = this._databaseManager.getCurrentDatabase();
      
      // 如果当前已经选中了相同的，直接返回成功
      if (currentConn?.label === metadata.datasource && currentDb?.label === metadata.database) {
        return true;
      }
      
      // 尝试恢复
      const success = await this._databaseManager.setActiveDatabase(metadata.datasource, metadata.database);
      if (success) {
        // 如果成功恢复，更新控制器描述
        this._updateDescription();
      }
      return success;
    }
    return false;
  }

  /**
   * 更新控制器描述，显示当前选择的数据源和数据库
   */
  private _updateDescription(): void {
    const currentConnection = this._databaseManager.getCurrentConnection();
    const currentDatabase = this._databaseManager.getCurrentDatabase();

    const connectionLabel = currentConnection?.label?.toString() || '';
    const databaseLabel = currentDatabase?.label?.toString() || '';

    // 在 VSCode Notebook API 中，description 和 detail 应该是可更新的
    // 但如果 UI 没有更新，可能需要重新创建控制器或使用其他方式
    // 尝试直接更新属性
    try {
      if (currentConnection && currentDatabase) {
        this._controller.description = `${connectionLabel} / ${databaseLabel}`;
        this._controller.detail = `点击工具栏按钮选择数据库连接`;
      } else if (currentConnection) {
        this._controller.description = connectionLabel;
        this._controller.detail = '未选择数据库，点击工具栏按钮选择';
      } else {
        this._controller.description = '未选择数据库';
        this._controller.detail = '点击工具栏按钮选择数据库连接';
      }
    } catch (error) {
      console.error('[SqlNotebookController] 更新描述失败:', error);
    }
  }

  /**
   * 公开方法：手动更新控制器描述（供外部调用，但实际上已通过回调自动更新）
   */
  public updateDescription(_notebook?: vscode.NotebookDocument): void {
    this._updateDescription();
  }

  private async _execute(
    cells: vscode.NotebookCell[],
    _notebook: vscode.NotebookDocument,
    _controller: vscode.NotebookController
  ): Promise<void> {
    // 按照官方文档示例，逐个执行单元格
    // 支持执行顺序和取消操作
    for (const cell of cells) {
      // 检查是否被取消
      if (_controller.interruptHandler) {
        // 如果支持中断，可以在这里检查
      }
      await this._doExecuteCell(cell);
    }
  }

  private async _doExecuteCell(cell: vscode.NotebookCell): Promise<void> {
    // 执行前尝试从 Metadata 恢复连接
    await this._restoreConnectionFromMetadata(cell.notebook);

    const currentConnection = this._databaseManager.getCurrentConnection();
    const currentDatabase = this._databaseManager.getCurrentDatabase();

    if (!currentConnection || !currentDatabase) {
      // 如果没有选择数据库，提示用户选择
      const choice = await vscode.window.showWarningMessage(
        '没有选择数据库连接，请先选择数据库连接',
        { modal: true },
        '选择数据库', '取消'
      );

      if (choice === '选择数据库') {
        await this._databaseManager.selectDatabase();
        
        // 再次检查是否选择了数据库
        const newConnection = this._databaseManager.getCurrentConnection();
        const newDatabase = this._databaseManager.getCurrentDatabase();
        
        if (!newConnection || !newDatabase) {
          vscode.window.showErrorMessage('未选择数据库连接，无法执行SQL');
          return;
        }
      } else {
        return; // 用户取消执行
      }
    }

    const execution = this._controller.createNotebookCellExecution(cell);
    const startTime = Date.now();
    try {
      execution.start(startTime);

      const finalConnection = this._databaseManager.getCurrentConnection();
      const finalDatabase = this._databaseManager.getCurrentDatabase();
      
      if (!finalConnection || !finalDatabase) {
        return;
      }

      const datasourceName = finalConnection.label?.toString() || '';
      const databaseName = finalDatabase.label?.toString() || '';

      const connection = await this._getConnection(datasourceName, databaseName);
      const sql = cell.document.getText().trim();

      if (!sql) {
        return;
      }

      const result = await new Promise<any>((resolve, reject) => {
        connection.query(sql, (err: any, results: any) => {
          if (err) {
            reject(err);
          } else {
            resolve(results);
          }
        });
      });
      const executionTime = Date.now() - startTime;

      // 保存数据库连接信息到 Notebook 元数据
      await this._saveNotebookMetadata(cell.notebook, datasourceName, databaseName);

      // 读取已有历史结果并追加本次结果
      const executionTimeSec = (Date.now() - startTime) / 1000;
      const previousResults = this._getPreviousResults(cell);
      const newResult = this._buildResultItem(result, executionTimeSec);
      const allResults = [...previousResults, newResult].slice(-20); // 最多保留 20 次

      const sqlResults = { type: 'query-results' as const, results: allResults };
      const output = new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.json(sqlResults, 'application/x.sql-results'),
      ]);
      await execution.replaceOutput([output]);
    } catch (error: any) {
      const previousResults = this._getPreviousResults(cell);
      const errorResult = { type: 'query-error' as const, error: error?.message ?? String(error) };
      const allResults = [...previousResults, errorResult].slice(-20);

      const sqlResults = { type: 'query-results' as const, results: allResults };
      const output = new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.json(sqlResults, 'application/x.sql-results'),
      ]);
      await execution.replaceOutput([output]);
    } finally {
      execution.end(true, Date.now());
    }
  }

  /**
   * 从 cell 输出中读取此前的结果列表（用于历史 Tab）
   */
  private _getPreviousResults(cell: vscode.NotebookCell): any[] {
    for (const out of cell.outputs) {
      for (const item of out.items) {
        if (item.mime === 'application/x.sql-results') {
          try {
            const text = new TextDecoder().decode(item.data);
            const parsed = JSON.parse(text);
            return Array.isArray(parsed.results) ? parsed.results : [];
          } catch {
            return [];
          }
        }
        if (item.mime === 'application/x.sql-result') {
          try {
            const text = new TextDecoder().decode(item.data);
            const parsed = JSON.parse(text);
            return [parsed];
          } catch {
            return [];
          }
        }
      }
    }
    return [];
  }

  /**
   * 将本次查询结果构建为统一格式的条目
   */
  private _buildResultItem(result: any, executionTimeSec: number): any {
    if (Array.isArray(result) && result.length > 0) {
      const columns = Object.keys(result[0]).map((name) => ({ name }));
      return {
        type: 'query-result' as const,
        columns,
        data: result,
        rowCount: result.length,
        executionTime: executionTimeSec,
      };
    }
    if (Array.isArray(result) && result.length === 0) {
      return {
        type: 'query-result' as const,
        columns: [] as { name: string }[],
        data: [] as any[],
        rowCount: 0,
        executionTime: executionTimeSec,
        message: '查询成功，无数据',
      };
    }
    const affectedRows = (result as any)?.affectedRows ?? 0;
    return {
      type: 'query-result' as const,
      columns: [] as { name: string }[],
      data: [] as any[],
      rowCount: affectedRows,
      executionTime: executionTimeSec,
      message: `执行成功，影响 ${affectedRows} 行`,
    };
  }

  /**
   * 销毁控制器
   */
  public dispose(): void {
    this._controller.dispose();
    this._connectionCache.forEach((cache) => {
      if (cache.connection && typeof cache.connection.end === 'function') {
        try {
          cache.connection.end();
        } catch (error) {
          console.error('关闭连接失败:', error);
        }
      }
    });
    this._connectionCache.clear();
  }

  /**
   * 获取或创建数据库连接（带缓存）
   */
  private async _getConnection(
    datasourceName: string,
    databaseName: string
  ): Promise<any> {
    const cacheKey = `${datasourceName}/${databaseName}`;
    
    // 检查缓存
    const cached = this._connectionCache.get(cacheKey);
    if (cached) {
      const now = Date.now();
      if (now - cached.lastUsed < this._connectionTimeout) {
        // 缓存有效，更新最后使用时间
        cached.lastUsed = now;
        return cached.connection;
      } else {
        // 缓存过期，清除
        this._connectionCache.delete(cacheKey);
      }
    }

    // 创建新连接
    const datasourceData = this._provider.getConnections().find(
      (ds) => ds.name === datasourceName
    );

    if (!datasourceData) {
      throw new Error(`找不到数据源: ${datasourceName}`);
    }

    const dsInstance = new Datasource(datasourceData);
    await dsInstance.connect();

    if (!dsInstance.dataloader) {
      throw new Error(`数据源 ${datasourceName} 没有数据加载器`);
    }

    // 切换到指定数据库
    const connection = dsInstance.dataloader.getConnection();
    await new Promise<void>((resolve, reject) => {
      connection.changeUser({ database: databaseName }, (err: any) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    // 缓存连接
    this._connectionCache.set(cacheKey, {
      datasourceName,
      databaseName,
      connection,
      lastUsed: Date.now(),
    });

    return connection;
  }

  /**
   * 保存数据库连接信息到 Notebook 元数据
   */
  private async _saveNotebookMetadata(
    notebook: vscode.NotebookDocument,
    datasource: string,
    database: string
  ): Promise<void> {
    try {
      // 使用 WorkspaceEdit 来更新 Notebook 元数据
      const edit = new vscode.WorkspaceEdit();
      const metadata = {
        ...notebook.metadata,
        datasource,
        database,
      };
      
      // 创建新的 NotebookData，保留原有的 cells
      const notebookData = new vscode.NotebookData(
        notebook.getCells().map(cell => {
          const cellData = new vscode.NotebookCellData(
            cell.kind,
            cell.document.getText(),
            cell.document.languageId
          );
          cellData.outputs = [...cell.outputs];
          cellData.metadata = cell.metadata;
          return cellData;
        })
      );
      notebookData.metadata = metadata;
      
      edit.set(notebook.uri, [
        vscode.NotebookEdit.updateNotebookMetadata(metadata)
      ]);
      
      await vscode.workspace.applyEdit(edit);
      
      console.log(`[Notebook] 已保存连接信息: ${datasource} / ${database}`);
    } catch (error) {
      console.error('[Notebook] 保存元数据失败:', error);
    }
  }

  /**
   * 清理过期的连接
   */
  private _cleanupConnections(): void {
    const now = Date.now();
    for (const [key, cache] of this._connectionCache.entries()) {
      if (now - cache.lastUsed > this._connectionTimeout) {
        // 关闭连接
        if (cache.connection && typeof cache.connection.end === 'function') {
          try {
            cache.connection.end();
          } catch (error) {
            console.error(`关闭连接失败 ${key}:`, error);
          }
        }
        this._connectionCache.delete(key);
      }
    }
  }
}
