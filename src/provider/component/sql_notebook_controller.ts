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

      console.log('[SqlNotebookController] 更新后的值:', {
        description: this._controller.description,
        detail: this._controller.detail,
        label: this._controller.label
      });
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

      const datasourceName = currentConnection!.label?.toString() || '';
      const databaseName = currentDatabase!.label?.toString() || '';

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

      // 处理结果
      if (Array.isArray(result)) {
        // SELECT 查询结果
        const outputItems: vscode.NotebookCellOutputItem[] = [
          vscode.NotebookCellOutputItem.json(result, 'application/json')
        ];
        const output = new vscode.NotebookCellOutput(outputItems);
        await execution.replaceOutput([output]);
      } else {
        // 其他操作结果
        const affectedRows = (result as any)?.affectedRows || 0;
        const message = `执行成功，影响 ${affectedRows} 行 (${executionTime}ms)`;
        const outputItems: vscode.NotebookCellOutputItem[] = [
          vscode.NotebookCellOutputItem.text(message)
        ];
        const output = new vscode.NotebookCellOutput(outputItems);
        await execution.replaceOutput([output]);
      }
    } catch (error: any) {
      const outputItems: vscode.NotebookCellOutputItem[] = [
        vscode.NotebookCellOutputItem.error(error)
      ];
      const output = new vscode.NotebookCellOutput(outputItems);
      await execution.replaceOutput([output]);
    } finally {
      execution.end(true, Date.now());
    }
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
