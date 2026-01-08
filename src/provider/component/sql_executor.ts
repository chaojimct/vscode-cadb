import * as vscode from 'vscode';
import { DataSourceProvider } from '../database_provider';
import { Datasource } from '../entity/datasource';
import type { DatabaseManager } from './database_manager';
import { ResultWebviewProvider } from '../result_provider';

interface ConnectionCache {
  datasourceName: string;
  databaseName: string;
  connection: any;
  lastUsed: number;
}

/**
 * SQL 执行器
 * 复用 Notebook Controller 的连接管理逻辑
 */
export class SqlExecutor {
  private readonly _provider: DataSourceProvider;
  private readonly _databaseManager: DatabaseManager;
  private readonly _resultProvider: ResultWebviewProvider;
  private readonly _outputChannel: vscode.OutputChannel;
  private readonly _connectionCache = new Map<string, ConnectionCache>();
  private readonly _connectionTimeout = 5 * 60 * 1000; // 5 分钟超时

  constructor(
    provider: DataSourceProvider,
    databaseManager: DatabaseManager,
    resultProvider: ResultWebviewProvider,
    outputChannel: vscode.OutputChannel
  ) {
    this._provider = provider;
    this._databaseManager = databaseManager;
    this._resultProvider = resultProvider;
    this._outputChannel = outputChannel;

    // 定期清理过期的连接
    setInterval(() => {
      this._cleanupConnections();
    }, 60000); // 每分钟检查一次
  }

  /**
   * 格式化时间戳
   */
  private _formatTimestamp(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  /**
   * 执行 SQL 语句
   */
  async executeSql(sql: string, document: vscode.TextDocument): Promise<void> {
    try {
      // 检查是否选择了数据库
      const currentConnection = this._databaseManager.getCurrentConnection();
      const currentDatabase = this._databaseManager.getCurrentDatabase();

      let finalConnection = currentConnection;
      let finalDatabase = currentDatabase;

      if (!finalConnection || !finalDatabase) {
        vscode.window.showWarningMessage('请先选择数据库连接');
        // 提示用户选择数据库
        await this._databaseManager.selectDatabase();
        // 重新检查
        finalConnection = this._databaseManager.getCurrentConnection();
        finalDatabase = this._databaseManager.getCurrentDatabase();
        if (!finalConnection || !finalDatabase) {
          this._resultProvider.showError('未选择数据库连接', sql);
          return;
        }
      }

      const datasourceName = finalConnection.label?.toString() || '';
      const databaseName = finalDatabase.label?.toString() || '';

      // 获取或创建连接
      const connection = await this._getConnection(datasourceName, databaseName);

      // 判断 SQL 类型
      const trimmedSql = sql.trim().toUpperCase();
      const isSelectQuery = trimmedSql.startsWith('SELECT');
      const isModifyingQuery = /^(INSERT|UPDATE|DELETE|REPLACE|MERGE|CREATE|DROP|ALTER|TRUNCATE)/i.test(trimmedSql);

      // 执行 SQL
      const startTime = Date.now();
      
      // 只有修改数据的语句才需要事务
      if (isModifyingQuery) {
        // 开启事务
        await new Promise<void>((resolve, reject) => {
          connection.beginTransaction((err: any) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      }

      try {
        const result = await new Promise<any>((resolve, reject) => {
          connection.query(sql, (err: any, results: any, fields: any) => {
            if (err) {
              reject(err);
            } else {
              resolve({ results, fields });
            }
          });
        });

        // 只有修改数据的语句才需要提交事务
        if (isModifyingQuery) {
          await new Promise<void>((resolve, reject) => {
            connection.commit((err: any) => {
              if (err) {
                reject(err);
              } else {
                resolve();
              }
            });
          });
        }

        const executionTime = (Date.now() - startTime) / 1000;

        // 处理结果
        const { results, fields } = result;

        // 记录 SQL 执行日志到输出通道
        const timestamp = this._formatTimestamp(new Date(startTime));
        const rowCount = Array.isArray(results) ? results.length : (results as any)?.affectedRows || 0;
        const logMessage = `[${timestamp} ${databaseName}, ${executionTime.toFixed(3)}s] (${rowCount} rows) ${sql.replace(/\s+/g, ' ').trim()}`;
        this._outputChannel.appendLine(logMessage);

        // 判断是查询结果还是非查询语句
        if (Array.isArray(results)) {
          // SELECT 查询语句
          const columns = (fields || []).map((field: any) => ({
            field: field.name,
            type: field.type,
          }));

          // 显示结果
          this._resultProvider.showResult(
            {
              results,
              fields,
              executionTime,
            },
            sql
          );
        } else if (results && typeof results === 'object') {
          // 非查询语句（INSERT, UPDATE, DELETE 等）
          const affectedRows = (results as any)?.affectedRows || 0;
          const insertId = (results as any)?.insertId;

          // 显示执行结果消息
          const message = affectedRows > 0
            ? `执行成功，影响 ${affectedRows} 行${insertId ? `，插入 ID: ${insertId}` : ''} (${executionTime.toFixed(3)}s)`
            : `执行成功 (${executionTime.toFixed(3)}s)`;

          vscode.window.showInformationMessage(message);
        } else {
          vscode.window.showInformationMessage(`执行成功 (${executionTime.toFixed(3)}s)`);
        }
      } catch (error) {
        // 只有修改数据的语句才需要回滚事务
        if (isModifyingQuery) {
          await new Promise<void>((resolve) => {
            connection.rollback(() => {
              resolve(); // 即使回滚失败也继续
            });
          });
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('[SQL Executor] 执行出错:', errorMessage);
        this._resultProvider.showError(errorMessage, sql);
        vscode.window.showErrorMessage(`SQL 执行失败: ${errorMessage}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[SQL Executor] 执行出错:', errorMessage);
      this._resultProvider.showError(errorMessage, sql);
      vscode.window.showErrorMessage(`SQL 执行失败: ${errorMessage}`);
    }
  }

  /**
   * 执行 EXPLAIN 查询
   */
  async explainSql(sql: string, document: vscode.TextDocument): Promise<void> {
    try {
      // 检查是否选择了数据库
      const currentConnection = this._databaseManager.getCurrentConnection();
      const currentDatabase = this._databaseManager.getCurrentDatabase();

      let finalConnection = currentConnection;
      let finalDatabase = currentDatabase;

      if (!finalConnection || !finalDatabase) {
        vscode.window.showWarningMessage('请先选择数据库连接');
        await this._databaseManager.selectDatabase();
        finalConnection = this._databaseManager.getCurrentConnection();
        finalDatabase = this._databaseManager.getCurrentDatabase();
        if (!finalConnection || !finalDatabase) {
          this._resultProvider.showError('未选择数据库连接', sql);
          return;
        }
      }

      const datasourceName = finalConnection.label?.toString() || '';
      const databaseName = finalDatabase.label?.toString() || '';

      // 获取或创建连接
      const connection = await this._getConnection(datasourceName, databaseName);

      // 构建 EXPLAIN 查询
      const explainSql = `EXPLAIN ${sql}`;

      // 执行 EXPLAIN
      const startTime = Date.now();
      const result = await new Promise<any>((resolve, reject) => {
        connection.query(explainSql, (err: any, results: any, fields: any) => {
          if (err) {
            reject(err);
          } else {
            resolve({ results, fields });
          }
        });
      });

      const executionTime = (Date.now() - startTime) / 1000;

      // 显示 EXPLAIN 结果
      const { results, fields } = result;
      
      // 记录 EXPLAIN 执行日志到输出通道
      const timestamp = this._formatTimestamp(new Date(startTime));
      const rowCount = Array.isArray(results) ? results.length : 0;
      const logMessage = `[${timestamp} ${databaseName}, ${executionTime.toFixed(3)}s] (${rowCount} rows) ${explainSql.replace(/\s+/g, ' ').trim()}`;
      this._outputChannel.appendLine(logMessage);
      
      if (Array.isArray(results)) {
        const columns = (fields || []).map((field: any) => ({
          field: field.name,
          type: field.type,
        }));

        this._resultProvider.showResult(
          {
            results,
            fields,
            executionTime,
          },
          explainSql
        );
      } else {
        vscode.window.showInformationMessage('EXPLAIN 执行完成');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[SQL Executor] EXPLAIN 执行出错:', errorMessage);
      this._resultProvider.showError(errorMessage, sql);
      vscode.window.showErrorMessage(`EXPLAIN 执行失败: ${errorMessage}`);
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
          console.error(`[SQL Executor] 关闭连接失败:`, error);
        }
      }
    }

    // 从缓存中删除过期项
    expiredKeys.forEach((key) => this._connectionCache.delete(key));

    if (expiredKeys.length > 0) {
      console.log(`[SQL Executor] 清理了 ${expiredKeys.length} 个过期连接`);
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
        console.error(`[SQL Executor] 关闭连接失败:`, error);
      }
    }
    this._connectionCache.clear();
  }
}

