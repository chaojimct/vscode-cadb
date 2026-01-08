import * as vscode from 'vscode';
import { DataSourceProvider } from '../database_provider';
import { Datasource } from '../entity/datasource';

/**
 * SQL Notebook 控制器
 * 负责执行 SQL 代码单元格
 */
export class SqlNotebookController {
  private readonly _controller: vscode.NotebookController;
  private readonly _provider: DataSourceProvider;
  private readonly _context: vscode.ExtensionContext;

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
  }

  private async _execute(
    cells: vscode.NotebookCell[],
    _notebook: vscode.NotebookDocument,
    _controller: vscode.NotebookController
  ): Promise<void> {
    for (const cell of cells) {
      await this._doExecuteCell(cell);
    }
  }

  private async _doExecuteCell(cell: vscode.NotebookCell): Promise<void> {
    const execution = this._controller.createNotebookCellExecution(cell);
    execution.start(Date.now());

    try {
      const sql = cell.document.getText();
      if (!sql.trim()) {
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

      // 查找数据源
      const datasourceData = this._provider.model.find(
        (ds) => ds.name === datasourceName
      );
      if (!datasourceData) {
        execution.replaceOutput([
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json(
              {
                type: 'query-error',
                error: '数据源不存在',
              },
              'application/x.sql-error'
            ),
          ]),
        ]);
        execution.end(false, Date.now());
        return;
      }

      // 创建数据源实例
      const datasource = await Datasource.createInstance(
        this._provider.model,
        this._context,
        datasourceData,
        false
      );

      if (!datasource.dataloader) {
        execution.replaceOutput([
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json(
              {
                type: 'query-error',
                error: '无法创建数据库连接',
              },
              'application/x.sql-error'
            ),
          ]),
        ]);
        execution.end(false, Date.now());
        return;
      }

      // 获取连接
      await datasource.dataloader.connect();
      const connection = datasource.dataloader.getConnection();
      if (!connection) {
        execution.replaceOutput([
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json(
              {
                type: 'query-error',
                error: '无法获取数据库连接',
              },
              'application/x.sql-error'
            ),
          ]),
        ]);
        execution.end(false, Date.now());
        return;
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

      if (Array.isArray(results) && results.length > 0) {
        // 查询结果
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
      } else {
        // 非查询语句（INSERT, UPDATE, DELETE 等）
        const affectedRows = (results as any)?.affectedRows || 0;
        execution.replaceOutput([
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json(
              {
                type: 'query-result',
                columns: [],
                data: [],
                rowCount: affectedRows,
                executionTime,
                message: `执行成功，影响 ${affectedRows} 行`,
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
    this._controller.dispose();
  }
}

