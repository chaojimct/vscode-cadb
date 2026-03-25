import * as vscode from "vscode";
import { DataSourceProvider } from "../database_provider";
import type { DatasourceInputData } from "../entity/datasource";
import type { DatabaseManager } from "./database_manager";
import { ResultWebviewProvider } from "../result_provider";
import { ensureSelectRowLimit } from "./sql_limit_guard";
import { withMysqlSession } from "../mysql/pool_registry";

/**
 * SQL 执行器（通过全局 MySQL 连接池 withMysqlSession 执行，与侧栏/表格共用池）
 */
export class SqlExecutor {
  private readonly _provider: DataSourceProvider;
  private readonly _databaseManager: DatabaseManager;
  private readonly _resultProvider: ResultWebviewProvider;
  private readonly _outputChannel: vscode.OutputChannel;

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
  }

  private _formatTimestamp(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  async executeSql(sql: string, document: vscode.TextDocument): Promise<void> {
    try {
      const currentConnection = this._databaseManager.getCurrentConnection();
      const currentDatabase = this._databaseManager.getCurrentDatabase();

      let finalConnection = currentConnection;
      let finalDatabase = currentDatabase;

      if (!finalConnection || !finalDatabase) {
        vscode.window.showWarningMessage("请先选择数据库连接");
        await this._databaseManager.selectDatabase();
        finalConnection = this._databaseManager.getCurrentConnection();
        finalDatabase = this._databaseManager.getCurrentDatabase();
        if (!finalConnection || !finalDatabase) {
          this._resultProvider.showError("未选择数据库连接", sql);
          return;
        }
      }

      const datasourceName = finalConnection.label?.toString() || "";
      const databaseName = finalDatabase.label?.toString() || "";

      const connData = this._provider
        .getConnections()
        .find((ds) => ds.name === datasourceName);
      if (!connData) {
        throw new Error(`找不到数据源: ${datasourceName}`);
      }

      const cadbCfg = vscode.workspace.getConfiguration("cadb");
      const autoLimit = cadbCfg.get<boolean>("query.autoAppendSelectLimit", true);
      const limitRows = cadbCfg.get<number>("grid.pageSize", 2000);
      const sqlEffective = autoLimit ? ensureSelectRowLimit(sql, limitRows) : sql;

      const trimmedSql = sqlEffective.trim().toUpperCase();
      const isModifyingQuery =
        /^(INSERT|UPDATE|DELETE|REPLACE|MERGE|CREATE|DROP|ALTER|TRUNCATE)/i.test(
          trimmedSql
        );

      await withMysqlSession(
        connData as DatasourceInputData,
        databaseName,
        async (connection) => {
          const startTime = Date.now();

          if (isModifyingQuery) {
            await new Promise<void>((resolve, reject) => {
              connection.beginTransaction((err: any) =>
                err ? reject(err) : resolve()
              );
            });
          }

          try {
            const result = await new Promise<any>((resolve, reject) => {
              connection.query(
                sqlEffective,
                (err: any, results: any, fields: any) => {
                  if (err) {
                    reject(err);
                  } else {
                    resolve({ results, fields });
                  }
                }
              );
            });

            if (isModifyingQuery) {
              await new Promise<void>((resolve, reject) => {
                connection.commit((err: any) => (err ? reject(err) : resolve()));
              });
            }

            const executionTime = (Date.now() - startTime) / 1000;
            const { results, fields } = result;

            const timestamp = this._formatTimestamp(new Date(startTime));
            const rowCount = Array.isArray(results)
              ? results.length
              : (results as any)?.affectedRows || 0;
            const logMessage = `[${timestamp} ${databaseName}, ${executionTime.toFixed(3)}s] (${rowCount} rows) ${sqlEffective.replace(/\s+/g, " ").trim()}`;
            this._outputChannel.appendLine(logMessage);

            if (Array.isArray(results)) {
              const columns = (fields || []).map((field: any) => ({
                field: field.name,
                type: field.type,
              }));
              this._resultProvider.showResult(
                { results, fields, executionTime },
                sqlEffective
              );
            } else if (results && typeof results === "object") {
              const affectedRows = (results as any)?.affectedRows || 0;
              const insertId = (results as any)?.insertId;
              const message =
                affectedRows > 0
                  ? `执行成功，影响 ${affectedRows} 行${insertId ? `，插入 ID: ${insertId}` : ""} (${executionTime.toFixed(3)}s)`
                  : `执行成功 (${executionTime.toFixed(3)}s)`;
              vscode.window.showInformationMessage(message);
            } else {
              vscode.window.showInformationMessage(
                `执行成功 (${executionTime.toFixed(3)}s)`
              );
            }
          } catch (error) {
            if (isModifyingQuery) {
              await new Promise<void>((resolve) => {
                connection.rollback(() => resolve());
              });
            }
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            console.error("[SQL Executor] 执行出错:", errorMessage);
            this._resultProvider.showError(errorMessage, sqlEffective);
            vscode.window.showErrorMessage(`SQL 执行失败: ${errorMessage}`);
          }
        }
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("[SQL Executor] 执行出错:", errorMessage);
      this._resultProvider.showError(errorMessage, sql);
      vscode.window.showErrorMessage(`SQL 执行失败: ${errorMessage}`);
    }
  }

  async explainSql(sql: string, document: vscode.TextDocument): Promise<void> {
    try {
      const currentConnection = this._databaseManager.getCurrentConnection();
      const currentDatabase = this._databaseManager.getCurrentDatabase();

      let finalConnection = currentConnection;
      let finalDatabase = currentDatabase;

      if (!finalConnection || !finalDatabase) {
        vscode.window.showWarningMessage("请先选择数据库连接");
        await this._databaseManager.selectDatabase();
        finalConnection = this._databaseManager.getCurrentConnection();
        finalDatabase = this._databaseManager.getCurrentDatabase();
        if (!finalConnection || !finalDatabase) {
          this._resultProvider.showError("未选择数据库连接", sql);
          return;
        }
      }

      const datasourceName = finalConnection.label?.toString() || "";
      const databaseName = finalDatabase.label?.toString() || "";

      const connData = this._provider
        .getConnections()
        .find((ds) => ds.name === datasourceName);
      if (!connData) {
        throw new Error(`找不到数据源: ${datasourceName}`);
      }

      const cadbCfg = vscode.workspace.getConfiguration("cadb");
      const autoLimit = cadbCfg.get<boolean>("query.autoAppendSelectLimit", true);
      const limitRows = cadbCfg.get<number>("grid.pageSize", 2000);
      const sqlForExplain = autoLimit ? ensureSelectRowLimit(sql, limitRows) : sql;
      const explainSqlText = `EXPLAIN ${sqlForExplain}`;

      await withMysqlSession(
        connData as DatasourceInputData,
        databaseName,
        async (connection) => {
          const startTime = Date.now();
          const result = await new Promise<any>((resolve, reject) => {
            connection.query(
              explainSqlText,
              (err: any, results: any, fields: any) => {
                if (err) {
                  reject(err);
                } else {
                  resolve({ results, fields });
                }
              }
            );
          });

          const executionTime = (Date.now() - startTime) / 1000;
          const { results, fields } = result;

          const timestamp = this._formatTimestamp(new Date(startTime));
          const rowCount = Array.isArray(results) ? results.length : 0;
          const logMessage = `[${timestamp} ${databaseName}, ${executionTime.toFixed(3)}s] (${rowCount} rows) ${explainSqlText.replace(/\s+/g, " ").trim()}`;
          this._outputChannel.appendLine(logMessage);

          if (Array.isArray(results)) {
            this._resultProvider.showResult(
              { results, fields, executionTime },
              explainSqlText
            );
          } else {
            vscode.window.showInformationMessage("EXPLAIN 执行完成");
          }
        }
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("[SQL Executor] EXPLAIN 执行出错:", errorMessage);
      this._resultProvider.showError(errorMessage, sql);
      vscode.window.showErrorMessage(`EXPLAIN 执行失败: ${errorMessage}`);
    }
  }

  dispose(): void {
    // 连接由 MysqlPoolRegistry 统一管理
  }
}
