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
    this._databaseManager.setOnDatabaseChangedCallback(() => {
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

    if (currentConnection && currentDatabase) {
      this._controller.description = `${currentConnection.label} / ${currentDatabase.label}`;
      this._controller.detail = `使用状态栏选择的数据库连接`;
    } else if (currentConnection) {
      this._controller.description = `${currentConnection.label}`;
      this._controller.detail = '未选择数据库，请在状态栏选择';
    } else {
      this._controller.description = '未选择数据库';
      this._controller.detail = '请在状态栏选择数据库连接';
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
    const datasourceData = this._provider.model.find(
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
    const expiredKeys: string[] = [];

    for (const [key, cached] of this._connectionCache.entries()) {
      if (now - cached.lastUsed >= this._connectionTimeout) {
        expiredKeys.push(key);
        // 尝试关闭连接
        try {
          if (cached.connection && typeof cached.connection.end === 'function') {
            cached.connection.end();
          }
        } catch (error) {
          console.error(`[Notebook Controller] 关闭连接失败:`, error);
        }
      }
    }

    // 从缓存中删除过期项
    expiredKeys.forEach((key) => this._connectionCache.delete(key));

    if (expiredKeys.length > 0) {
      console.log(`[Notebook Controller] 清理了 ${expiredKeys.length} 个过期连接`);
    }
  }

  private async _doExecuteCell(cell: vscode.NotebookCell): Promise<void> {
    const execution = this._controller.createNotebookCellExecution(cell);
    execution.start(Date.now());

    try {
      const sql = cell.document.getText().trim();
      // 空 cell 直接成功返回
      if (!sql) {
        execution.end(true, Date.now());
        return;
      }

      // 从 databaseManager 获取当前选择的连接和数据库
      const currentConnection = this._databaseManager.getCurrentConnection();
      const currentDatabase = this._databaseManager.getCurrentDatabase();

      if (!currentConnection || !currentDatabase) {
        execution.replaceOutput([
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json(
              {
                type: 'query-error',
                error: '请先在状态栏选择数据库连接',
              },
              'application/x.sql-error'
            ),
            // 添加 text/plain 格式作为后备
            vscode.NotebookCellOutputItem.text(
              `错误: 请先在状态栏选择数据库连接`,
              'text/plain'
            ),
          ]),
        ]);
        execution.end(false, Date.now());
        return;
      }

      const datasourceName = currentConnection.label?.toString() || '';
      const databaseName = currentDatabase.label?.toString() || '';

      console.log('[Notebook Controller] 执行 SQL:', { datasourceName, databaseName, sql });

      // 获取或创建连接（使用缓存）
      const connection = await this._getConnection(datasourceName, databaseName);

      // 执行 SQL
      const startTime = Date.now();
      const result = await new Promise<any>((resolve, reject) => {
        connection.query(sql, (err: any, results: any, fields: any) => {
          if (err) {
            reject(err);
          } else {
            resolve({ results, fields });
          }
        });
      });

      const executionTime = (Date.now() - startTime) / 1000;

      // 处理结果
      const { results, fields } = result;

      // 判断是查询结果还是非查询语句
      if (Array.isArray(results)) {
        // SELECT 查询语句
        const columns = (fields || []).map((field: any) => ({
          name: field.name,
          type: field.type,
        }));

        const data = results.map((row: any) => {
          const rowData: any = {};
          for (const field of fields || []) {
            rowData[field.name] = row[field.name];
          }
          return rowData;
        });

        // 同时提供 JSON 和文本格式，确保兼容性
        execution.replaceOutput([
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json(
              {
                type: 'query-result',
                columns,
                data,
                rowCount: results.length,
                executionTime,
              },
              'application/x.sql-result'
            ),
            // 添加 text/plain 格式作为后备
            vscode.NotebookCellOutputItem.text(
              JSON.stringify({
                type: 'query-result',
                columns,
                data,
                rowCount: results.length,
                executionTime,
              }, null, 2),
              'text/plain'
            ),
          ]),
        ]);
      } else if (results && typeof results === 'object') {
        // 非查询语句（INSERT, UPDATE, DELETE 等）
        const affectedRows = (results as any)?.affectedRows || 0;
        const insertId = (results as any)?.insertId;
        
        execution.replaceOutput([
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json(
              {
                type: 'query-result',
                columns: [],
                data: [],
                rowCount: affectedRows,
                executionTime,
                message: affectedRows > 0 
                  ? `执行成功，影响 ${affectedRows} 行${insertId ? `，插入 ID: ${insertId}` : ''}`
                  : '执行成功',
              },
              'application/x.sql-result'
            ),
            // 添加 text/plain 格式作为后备
            vscode.NotebookCellOutputItem.text(
              affectedRows > 0 
                ? `执行成功，影响 ${affectedRows} 行${insertId ? `，插入 ID: ${insertId}` : ''} (${executionTime.toFixed(3)}s)`
                : `执行成功 (${executionTime.toFixed(3)}s)`,
              'text/plain'
            ),
          ]),
        ]);
      } else {
        // 其他类型的结果
        execution.replaceOutput([
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json(
              {
                type: 'query-result',
                columns: [],
                data: [],
                rowCount: 0,
                executionTime,
                message: '执行成功',
              },
              'application/x.sql-result'
            ),
            // 添加 text/plain 格式作为后备
            vscode.NotebookCellOutputItem.text(
              `执行成功 (${executionTime.toFixed(3)}s)`,
              'text/plain'
            ),
          ]),
        ]);
      }

      execution.end(true, Date.now());
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[Notebook Controller] 执行出错:', errorMessage);

      execution.replaceOutput([
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.json(
            {
              type: 'query-error',
              error: errorMessage,
            },
            'application/x.sql-error'
          ),
          // 添加 text/plain 格式作为后备
          vscode.NotebookCellOutputItem.text(
            `错误: ${errorMessage}`,
            'text/plain'
          ),
        ]),
      ]);
      execution.end(false, Date.now());
    }
  }

  dispose(): void {
    // 清理所有缓存的连接
    for (const [_key, cached] of this._connectionCache.entries()) {
      try {
        if (cached.connection && typeof cached.connection.end === 'function') {
          cached.connection.end();
        }
      } catch (error) {
        console.error(`[Notebook Controller] 关闭连接失败:`, error);
      }
    }
    this._connectionCache.clear();
    this._controller.dispose();
  }
}
