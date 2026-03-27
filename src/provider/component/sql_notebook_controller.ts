import * as vscode from "vscode";
import { DataSourceProvider } from "../database_provider";
import type { DatasourceInputData } from "../entity/datasource";
import type { DatabaseManager } from "./database_manager";
import { withMysqlSession } from "../mysql/pool_registry";

export class SqlNotebookController {
  private readonly _controller: vscode.NotebookController;
  private readonly _provider: DataSourceProvider;
  private readonly _context: vscode.ExtensionContext;
  private readonly _databaseManager: DatabaseManager;

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
        // 成功恢复后显式更新，确保 kernel 选择器回显
        this._updateDescription();
      }
      return success;
    }
    return false;
  }

  /**
   * 更新控制器 label/description，在顶部 kernel 选择器中回显当前选择的数据源和数据库
   */
  private _updateDescription(): void {
    const currentConnection = this._databaseManager.getCurrentConnection();
    const currentDatabase = this._databaseManager.getCurrentDatabase();

    const connectionLabel = currentConnection?.label?.toString() || '';
    const databaseLabel = currentDatabase?.label?.toString() || '';

    try {
      if (currentConnection && currentDatabase) {
        const dbInfo = `${connectionLabel} / ${databaseLabel}`;
        // 同时更新 label，使 kernel 选择器主显示区域能回显数据库信息
        this._controller.label = `SQL Notebook · ${dbInfo}`;
        this._controller.description = dbInfo;
        this._controller.detail = `点击「选择数据库」可更换连接`;
        vscode.commands.executeCommand('setContext', 'cadb.hasDatabaseSelected', true);
        vscode.commands.executeCommand('setContext', 'cadb.notebook.databaseLabel', dbInfo);
      } else if (currentConnection) {
        this._controller.label = `SQL Notebook · ${connectionLabel} (未选库)`;
        this._controller.description = connectionLabel;
        this._controller.detail = '未选择数据库，点击工具栏按钮选择';
        vscode.commands.executeCommand('setContext', 'cadb.hasDatabaseSelected', false);
        vscode.commands.executeCommand('setContext', 'cadb.notebook.databaseLabel', '');
      } else {
        this._controller.label = 'SQL Notebook';
        this._controller.description = '未选择数据库';
        this._controller.detail = '点击工具栏按钮选择数据库连接';
        vscode.commands.executeCommand('setContext', 'cadb.hasDatabaseSelected', false);
        vscode.commands.executeCommand('setContext', 'cadb.notebook.databaseLabel', '');
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
    // 1）优先使用 Cell 自己的 metadata（cell.metadata.cadb）
    const cellCadb = cell.metadata?.cadb as { datasource?: string; database?: string } | undefined;
    let datasourceName: string;
    let databaseName: string;

    if (cellCadb?.datasource && cellCadb?.database) {
      datasourceName = cellCadb.datasource;
      databaseName = cellCadb.database;
      await this._databaseManager.setActiveDatabase(datasourceName, databaseName);
    } else {
      // 2）否则尝试从 Notebook metadata 恢复
      await this._restoreConnectionFromMetadata(cell.notebook);
      const currentConnection = this._databaseManager.getCurrentConnection();
      const currentDatabase = this._databaseManager.getCurrentDatabase();

      if (!currentConnection || !currentDatabase) {
        const choice = await vscode.window.showWarningMessage(
          '没有选择数据库连接，请先选择数据库连接',
          { modal: true },
          '选择数据库', '取消'
        );

        if (choice === '选择数据库') {
          await this._databaseManager.selectDatabase();
          const newConnection = this._databaseManager.getCurrentConnection();
          const newDatabase = this._databaseManager.getCurrentDatabase();
          if (!newConnection || !newDatabase) {
            vscode.window.showErrorMessage('未选择数据库连接，无法执行SQL');
            return;
          }
        } else {
          return;
        }
      }

      datasourceName = this._databaseManager.getCurrentConnection()!.label?.toString() || '';
      databaseName = this._databaseManager.getCurrentDatabase()!.label?.toString() || '';
    }

    const execution = this._controller.createNotebookCellExecution(cell);
    const startTime = Date.now();
    try {
      execution.start(startTime);

      const finalConnection = this._databaseManager.getCurrentConnection();
      const finalDatabase = this._databaseManager.getCurrentDatabase();
      if (!finalConnection || !finalDatabase) return;

      const datasourceData = this._provider
        .getConnections()
        .find((ds) => ds.name === datasourceName);
      if (!datasourceData) {
        throw new Error(`找不到数据源: ${datasourceName}`);
      }

      const sql = cell.document.getText().trim();

      if (!sql) {
        return;
      }

      const result = await withMysqlSession(
        datasourceData as DatasourceInputData,
        databaseName,
        async (connection) =>
          new Promise<any>((resolve, reject) => {
            connection.query(sql, (err: any, results: any) => {
              if (err) {
                reject(err);
              } else {
                resolve(results);
              }
            });
          })
      );
      const executionTime = Date.now() - startTime;

      await this._saveNotebookMetadata(cell.notebook, datasourceName, databaseName);
      await this._saveCellMetadata(cell, datasourceName, databaseName);

      // 读取已有历史结果并追加本次结果
      const executionTimeSec = (Date.now() - startTime) / 1000;
      const previousResults = this._getPreviousResults(cell);
      const newResult = this._buildResultItem(result, executionTimeSec);
      const allResults = [...previousResults, newResult].slice(-20); // 最多保留 20 次

      const sqlResults = {
        type: 'query-results' as const,
        results: allResults,
        cadbRef: {
          notebookUri: cell.notebook.uri.toString(),
          cellIndex: cell.index,
        },
      };
      const output = new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.json(sqlResults, 'application/x.sql-results'),
      ]);
      await execution.replaceOutput([output]);
    } catch (error: any) {
      const previousResults = this._getPreviousResults(cell);
      const errMsg = error?.message ?? String(error);
      // 查询失败不写入历史：仅展示本次错误；若有历史则保留标签页并顶部提示错误
      if (previousResults.length === 0) {
        const output = new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.json(
            { type: 'query-error' as const, error: errMsg },
            'application/x.sql-results'
          ),
        ]);
        await execution.replaceOutput([output]);
      } else {
        const sqlResults = {
          type: 'query-results' as const,
          results: previousResults,
          executionError: errMsg,
          cadbRef: {
            notebookUri: cell.notebook.uri.toString(),
            cellIndex: cell.index,
          },
        };
        const output = new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.json(sqlResults, 'application/x.sql-results'),
        ]);
        await execution.replaceOutput([output]);
      }
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
   * 处理 Notebook 渲染器 postMessage（删除某条历史查询结果）
   */
  public async handleRendererMessage(
    editor: vscode.NotebookEditor,
    message: unknown
  ): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }
    const m = message as {
      type?: string;
      notebookUri?: string;
      cellIndex?: number;
      resultIndex?: number;
    };
    if (m.type !== "deleteSqlResult") {
      return;
    }
    if (
      typeof m.notebookUri !== "string" ||
      typeof m.cellIndex !== "number" ||
      typeof m.resultIndex !== "number"
    ) {
      return;
    }
    const notebook = editor.notebook;
    if (notebook.uri.toString() !== m.notebookUri) {
      return;
    }
    const cell = notebook.cellAt(m.cellIndex);
    if (!cell || cell.index !== m.cellIndex) {
      return;
    }
    const newOutputs = this._cloneCellOutputsWithResultRemoved(cell, m.resultIndex);
    if (newOutputs === null) {
      return;
    }
    try {
      const cellData = new vscode.NotebookCellData(
        cell.kind,
        cell.document.getText(),
        cell.document.languageId
      );
      cellData.outputs = newOutputs;
      cellData.metadata = { ...cell.metadata };
      if (cell.executionSummary) {
        cellData.executionSummary = cell.executionSummary;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.set(notebook.uri, [
        vscode.NotebookEdit.replaceCells(
          new vscode.NotebookRange(cell.index, cell.index + 1),
          [cellData]
        ),
      ]);
      await vscode.workspace.applyEdit(edit);
    } catch (e) {
      console.error("[SqlNotebookController] 删除查询结果失败:", e);
    }
  }

  /** 从单元格输出中移除指定下标的 query-results 条目，返回新 outputs；无法处理时返回 null */
  private _cloneCellOutputsWithResultRemoved(
    cell: vscode.NotebookCell,
    resultIndex: number
  ): vscode.NotebookCellOutput[] | null {
    if (resultIndex < 0) {
      return null;
    }
    const decoder = new TextDecoder();
    const found: vscode.NotebookCellOutput[] = [];
    let hit = false;
    for (const out of cell.outputs) {
      const jsonItem = out.items.find((i) => i.mime === "application/x.sql-results");
      if (!jsonItem) {
        found.push(this._cloneNotebookOutput(out));
        continue;
      }
      try {
        const parsed = JSON.parse(decoder.decode(jsonItem.data)) as {
          type?: string;
          results?: unknown[];
          executionError?: string;
          cadbRef?: unknown;
        };
        if (
          parsed.type !== "query-results" ||
          !Array.isArray(parsed.results) ||
          resultIndex >= parsed.results.length
        ) {
          found.push(this._cloneNotebookOutput(out));
          continue;
        }
        hit = true;
        parsed.results.splice(resultIndex, 1);
        delete parsed.executionError;
        parsed.cadbRef = {
          notebookUri: cell.notebook.uri.toString(),
          cellIndex: cell.index,
        };
        if (parsed.results.length === 0) {
          /* 去掉整条 sql-results 输出 */
          continue;
        }
        found.push(
          new vscode.NotebookCellOutput(
            [vscode.NotebookCellOutputItem.json(parsed, "application/x.sql-results")],
            out.metadata
          )
        );
      } catch {
        found.push(this._cloneNotebookOutput(out));
      }
    }
    return hit ? found : null;
  }

  private _cloneNotebookOutput(out: vscode.NotebookCellOutput): vscode.NotebookCellOutput {
    const items = out.items.map(
      (it) => new vscode.NotebookCellOutputItem(new Uint8Array(it.data), it.mime)
    );
    return new vscode.NotebookCellOutput(items, out.metadata);
  }

  /**
   * 销毁控制器
   */
  public dispose(): void {
    this._controller.dispose();
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

  /** 保存 Cell 的数据库连接到 cell.metadata.cadb */
  private async _saveCellMetadata(
    cell: vscode.NotebookCell,
    datasource: string,
    database: string
  ): Promise<void> {
    try {
      const edit = new vscode.WorkspaceEdit();
      const newMetadata = { ...cell.metadata, cadb: { datasource, database } };
      edit.set(cell.notebook.uri, [vscode.NotebookEdit.updateCellMetadata(cell.index, newMetadata)]);
      await vscode.workspace.applyEdit(edit);
    } catch (error) {
      console.error('[Notebook] 保存 Cell 元数据失败:', error);
    }
  }
}
