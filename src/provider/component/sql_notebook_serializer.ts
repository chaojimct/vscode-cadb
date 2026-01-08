import { TextDecoder, TextEncoder } from 'util';
import * as vscode from 'vscode';

/**
 * Notebook 数据接口
 */
interface NotebookData {
  datasource: string | null;
  database: string | null;
  cells: Array<{
    id: string;
    sql: string;
    result?: {
      columns: Array<{ name: string; type: number }>;
      data: any[];
      rowCount: number;
      executionTime: number;
    };
    error?: string;
  }>;
}

/**
 * SQL Notebook 序列化器
 * 负责将 .jsql 文件内容转换为 NotebookData，以及将 NotebookData 保存回文件
 */
export class SqlNotebookSerializer implements vscode.NotebookSerializer {
  async deserializeNotebook(
    content: Uint8Array,
    _token: vscode.CancellationToken
  ): Promise<vscode.NotebookData> {
    const contents = new TextDecoder().decode(content);
    
    let notebookData: NotebookData = {
      datasource: null,
      database: null,
      cells: [],
    };

    // 尝试解析 JSON
    if (contents.trim()) {
      try {
        notebookData = JSON.parse(contents);
      } catch (error) {
        // 如果解析失败，创建一个空的 notebook
        console.error('解析 notebook 文件失败:', error);
      }
    }

    // 将数据转换为 NotebookData
    const cells: vscode.NotebookCellData[] = [];

    // 如果有数据源和数据库信息，创建一个 Markdown cell 来显示
    if (notebookData.datasource || notebookData.database) {
      const metadata = [];
      if (notebookData.datasource) {
        metadata.push(`**数据源:** ${notebookData.datasource}`);
      }
      if (notebookData.database) {
        metadata.push(`**数据库:** ${notebookData.database}`);
      }
      cells.push(
        new vscode.NotebookCellData(
          vscode.NotebookCellKind.Markup,
          metadata.join('\n\n'),
          'markdown'
        )
      );
    }

    // 转换 SQL cells
    for (const cell of notebookData.cells) {
      const cellData = new vscode.NotebookCellData(
        vscode.NotebookCellKind.Code,
        cell.sql || '',
        'sql'
      );

      // 保存 cell 的元数据（ID、结果、错误等）
      cellData.metadata = {
        id: cell.id,
        result: cell.result,
        error: cell.error,
      };

      // 如果有输出，添加输出项
      if (cell.result) {
        cellData.outputs = [
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json(
              {
                type: 'query-result',
                columns: cell.result.columns,
                data: cell.result.data,
                rowCount: cell.result.rowCount,
                executionTime: cell.result.executionTime,
              },
              'application/x.sql-result'
            ),
          ]),
        ];
      } else if (cell.error) {
        cellData.outputs = [
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json(
              {
                type: 'query-error',
                error: cell.error,
              },
              'application/x.sql-error'
            ),
          ]),
        ];
      }

      cells.push(cellData);
    }

    // 如果没有 cells，添加一个空的 SQL cell
    if (cells.length === 0 || (cells.length === 1 && cells[0].kind === vscode.NotebookCellKind.Markup)) {
      cells.push(
        new vscode.NotebookCellData(
          vscode.NotebookCellKind.Code,
          '',
          'sql'
        )
      );
    }

    const notebookDataObj = new vscode.NotebookData(cells);
    notebookDataObj.metadata = {
      datasource: notebookData.datasource,
      database: notebookData.database,
    };
    return notebookDataObj;
  }

  async serializeNotebook(
    data: vscode.NotebookData,
    _token: vscode.CancellationToken
  ): Promise<Uint8Array> {
    const notebookData: NotebookData = {
      datasource: data.metadata?.datasource || null,
      database: data.metadata?.database || null,
      cells: [],
    };

    // 转换 cells
    for (const cell of data.cells) {
      // 跳过 Markdown cells（元数据 cell）
      if (cell.kind === vscode.NotebookCellKind.Markup) {
        continue;
      }

      const cellData: any = {
        id: cell.metadata?.id || `cell-${Date.now()}-${Math.random()}`,
        sql: cell.value || '',
      };

      // 从输出中提取结果或错误
      if (cell.outputs && cell.outputs.length > 0) {
        for (const output of cell.outputs) {
          for (const item of output.items) {
            try {
              const data = JSON.parse(new TextDecoder().decode(item.data));
              if (data.type === 'query-result') {
                cellData.result = {
                  columns: data.columns,
                  data: data.data,
                  rowCount: data.rowCount,
                  executionTime: data.executionTime,
                };
              } else if (data.type === 'query-error') {
                cellData.error = data.error;
              }
            } catch (error) {
              // 忽略解析错误
            }
          }
        }
      }

      // 如果 metadata 中有结果或错误，也保存
      if (cell.metadata?.result) {
        cellData.result = cell.metadata.result;
      }
      if (cell.metadata?.error) {
        cellData.error = cell.metadata.error;
      }

      notebookData.cells.push(cellData);
    }

    return new TextEncoder().encode(JSON.stringify(notebookData, null, 2));
  }
}

