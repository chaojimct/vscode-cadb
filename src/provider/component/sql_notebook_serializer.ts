import { TextDecoder, TextEncoder } from 'util';
import * as vscode from 'vscode';

/**
 * .jsql 文件格式接口（与文件系统存储格式对应）
 */
interface RawNotebook {
  datasource?: string | null;
  database?: string | null;
  cells: RawNotebookCell[];
}

interface RawNotebookCell {
  id?: string;
  sql: string;
  result?: {
    columns: Array<{ name: string; type: number }>;
    data: any[];
    rowCount: number;
    executionTime: number;
  };
  results?: any[]; // 多次执行的历史结果（application/x.sql-results）
  error?: string;
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
    
    let raw: RawNotebook;
    try {
      raw = JSON.parse(contents) as RawNotebook;
      // 验证数据结构
      if (!raw.cells || !Array.isArray(raw.cells)) {
        raw = { cells: [] };
      }
    } catch (error) {
      // 如果解析失败，创建一个空的 notebook
      console.error('解析 notebook 文件失败:', error);
      raw = { cells: [] };
    }

    // 将原始数据转换为 NotebookCellData
    const cells = raw.cells.map(
      item =>
        new vscode.NotebookCellData(
          vscode.NotebookCellKind.Code,
          item.sql || '',
          'sql'
        )
    );

    // 如果没有 cells，添加一个空的 SQL cell
    if (cells.length === 0) {
      cells.push(
        new vscode.NotebookCellData(
          vscode.NotebookCellKind.Code,
          '',
          'sql'
        )
      );
    }

    // 恢复输出（如果有保存的结果或错误）
    for (let i = 0; i < raw.cells.length && i < cells.length; i++) {
      const rawCell = raw.cells[i];
      const cellData = cells[i];

      // 保存 cell 的元数据（ID）
      if (rawCell.id) {
        cellData.metadata = { id: rawCell.id };
      }

      // 恢复输出
      if (rawCell.results && Array.isArray(rawCell.results) && rawCell.results.length > 0) {
        cellData.outputs = [
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json(
              { type: 'query-results', results: rawCell.results },
              'application/x.sql-results'
            ),
          ]),
        ];
      } else if (rawCell.result) {
        cellData.outputs = [
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json(
              { type: 'query-results', results: [{
                type: 'query-result',
                columns: rawCell.result.columns,
                data: rawCell.result.data,
                rowCount: rawCell.result.rowCount,
                executionTime: rawCell.result.executionTime,
              }] },
              'application/x.sql-results'
            ),
          ]),
        ];
      } else if (rawCell.error) {
        cellData.outputs = [
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json(
              { type: 'query-results', results: [{ type: 'query-error', error: rawCell.error }] },
              'application/x.sql-results'
            ),
          ]),
        ];
      }
    }

    const notebookData = new vscode.NotebookData(cells);
    // 保存 notebook 级别的元数据（数据源和数据库）
    if (raw.datasource || raw.database) {
      notebookData.metadata = {
        datasource: raw.datasource || null,
        database: raw.database || null,
      };
    }

    return notebookData;
  }

  async serializeNotebook(
    data: vscode.NotebookData,
    _token: vscode.CancellationToken
  ): Promise<Uint8Array> {
    const contents: RawNotebookCell[] = [];

    // 只处理代码单元格
    for (const cell of data.cells) {
      if (cell.kind !== vscode.NotebookCellKind.Code) {
        continue;
      }

      const rawCell: RawNotebookCell = {
        id: cell.metadata?.id || `cell-${Date.now()}-${Math.random()}`,
        sql: cell.value || '',
      };

      // 从输出中提取结果或错误
      if (cell.outputs && cell.outputs.length > 0) {
        for (const output of cell.outputs) {
          for (const item of output.items) {
            try {
              const outputData = JSON.parse(new TextDecoder().decode(item.data));
              if (outputData.type === 'query-results' && Array.isArray(outputData.results)) {
                rawCell.results = outputData.results;
              } else if (outputData.type === 'query-result') {
                rawCell.result = {
                  columns: outputData.columns,
                  data: outputData.data,
                  rowCount: outputData.rowCount,
                  executionTime: outputData.executionTime,
                };
              } else if (outputData.type === 'query-error') {
                rawCell.error = outputData.error;
              }
            } catch (error) {
              // 忽略解析错误
            }
          }
        }
      }

      contents.push(rawCell);
    }

    const raw: RawNotebook = {
      datasource: data.metadata?.datasource || null,
      database: data.metadata?.database || null,
      cells: contents,
    };

    return new TextEncoder().encode(JSON.stringify(raw, null, 2));
  }
}

