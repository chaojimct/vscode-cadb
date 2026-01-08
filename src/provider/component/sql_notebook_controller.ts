import * as vscode from 'vscode';
import { DataSourceProvider } from '../database_provider';
import { Datasource } from '../entity/datasource';

/**
 * SQL Notebook 控制器
 * 负责执行 SQL 代码单元格
 */
/**
 * 连接缓存，用于复用数据库连接
 */
interface ConnectionCache {
  datasource: string;
  database: string;
  connection: any;
  lastUsed: number;
}

export class SqlNotebookController {
  private readonly _controller: vscode.NotebookController;
  private readonly _provider: DataSourceProvider;
  private readonly _context: vscode.ExtensionContext;
  private readonly _connectionCache = new Map<string, ConnectionCache>();
  private readonly _connectionTimeout = 5 * 60 * 1000; // 5 分钟超时

  constructor(
    id: string,
    notebookType: string,
    label: string,
    provider: DataSourceProvider,
    context: vscode.ExtensionContext
  ) {
    this._provider = provider;
    this._context = context;

    this._controller = vscode.notebooks.createNotebookController(
      id,
      notebookType,
      label
    );

    this._controller.supportedLanguages = ['sql'];
    this._controller.supportsExecutionOrder = true;
    this._controller.executeHandler = this._execute.bind(this);
    
    // 定期清理过期的连接
    setInterval(() => this._cleanupConnections(), 60000); // 每分钟清理一次
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
    const cacheKey = `${datasourceName}:${databaseName}`;
    const cached = this._connectionCache.get(cacheKey);

    // 检查缓存是否有效
    if (cached && Date.now() - cached.lastUsed < this._connectionTimeout) {
      cached.lastUsed = Date.now();
      // 检查连接是否仍然有效
      try {
        await new Promise<void>((resolve, reject) => {
          cached.connection.ping((err: any) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
        return cached.connection;
      } catch (error) {
        // 连接已失效，移除缓存
        this._connectionCache.delete(cacheKey);
      }
    }

    // 创建新连接
    const datasourceData = this._provider.model.find(
      (ds) => ds.name === datasourceName
    );
    if (!datasourceData) {
      throw new Error('数据源不存在');
    }

    const datasource = await Datasource.createInstance(
      this._provider.model,
      this._context,
      datasourceData,
      false
    );

    if (!datasource.dataloader) {
      throw new Error('无法创建数据库连接');
    }

    await datasource.dataloader.connect();
    const connection = datasource.dataloader.getConnection();
    if (!connection) {
      throw new Error('无法获取数据库连接');
    }

    // 切换到指定数据库
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
      datasource: datasourceName,
      database: databaseName,
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
        try {
          cache.connection.destroy?.();
        } catch (error) {
          // 忽略销毁错误
        }
        this._connectionCache.delete(key);
      }
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

      // 获取 notebook 的元数据（数据源和数据库）
      const notebookMetadata = cell.notebook.metadata;
      const datasourceName = notebookMetadata?.datasource as string | undefined;
      const databaseName = notebookMetadata?.database as string | undefined;

      if (!datasourceName || !databaseName) {
        execution.replaceOutput([
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json(
              {
                type: 'query-error',
                error: '请先选择数据源和数据库',
              },
              'application/x.sql-error'
            ),
          ]),
        ]);
        execution.end(false, Date.now());
        return;
      }

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
          ]),
        ]);
      } else {
        // 空结果或其他情况
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
          ]),
        ]);
      }

      execution.end(true, Date.now());
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      execution.replaceOutput([
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.json(
            {
              type: 'query-error',
              error: errorMessage,
            },
            'application/x.sql-error'
          ),
        ]),
      ]);

      execution.end(false, Date.now());
    }
  }

  dispose(): void {
    // 清理所有连接
    for (const cache of this._connectionCache.values()) {
      try {
        cache.connection.destroy?.();
      } catch (error) {
        // 忽略销毁错误
      }
    }
    this._connectionCache.clear();
    this._controller.dispose();
  }
}

