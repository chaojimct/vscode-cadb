import * as vscode from "vscode";
import type { DatabaseManager } from "./database_manager";
import { DataSourceProvider } from "../database_provider";
import { Datasource } from "../entity/datasource";

interface ConnectionCache {
  connection: any;
  lastUsed: number;
}

/**
 * SQL 悬浮提示提供者
 * - 表名悬浮：展示该表的 DDL (SHOW CREATE TABLE)
 * - 字段名悬浮：展示类型、备注等
 */
export class SqlHoverProvider implements vscode.HoverProvider {
  private _databaseManager?: DatabaseManager;
  private _provider?: DataSourceProvider;
  private _connectionCache = new Map<string, ConnectionCache>();
  private _connectionTimeout = 5 * 60 * 1000;

  setDatabaseManager(m: DatabaseManager): void {
    this._databaseManager = m;
  }

  setProvider(p: DataSourceProvider): void {
    this._provider = p;
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | null | undefined> {
    const { connection, databaseName, datasourceName } = await this._resolveConnection(document);
    if (!connection || !databaseName) {
      return undefined;
    }

    const word = this._getWordAt(document, position);
    if (!word) return undefined;

    const sql = document.getText();
    const offset = document.offsetAt(position);

    // 检查是否为 table.column 格式（光标在 column 部分）
    const tableCol = this._parseTableColumn(word, sql, offset);
    if (tableCol) {
      return this._hoverColumn(connection, databaseName, tableCol.table, tableCol.column);
    }

    // 检查是否为表名（在 FROM, JOIN, UPDATE, INSERT INTO 等上下文中）
    const tableName = this._parseTableName(word, sql, offset);
    if (tableName) {
      return this._hoverTable(connection, databaseName, tableName);
    }

    // 检查是否为裸字段名（无表前缀）
    const columnName = this._parseStandaloneColumn(word, sql, offset);
    if (columnName) {
      const tablesInCell = this._extractTablesFromSql(sql);
      return this._hoverColumn(connection, databaseName, null, columnName, tablesInCell);
    }

    return undefined;
  }

  private async _resolveConnection(
    document: vscode.TextDocument
  ): Promise<{ connection: any; databaseName: string; datasourceName: string } | { connection: null; databaseName: string; datasourceName: string }> {
    let datasourceName = "";
    let databaseName = "";

    if (document.uri.scheme === "vscode-notebook-cell") {
      const notebook = vscode.workspace.notebookDocuments.find((nb) =>
        nb.getCells().some((c) => c.document.uri.toString() === document.uri.toString())
      );
      if (notebook?.metadata) {
        datasourceName = (notebook.metadata.datasource as string) || "";
        databaseName = (notebook.metadata.database as string) || "";
      }
    }

    if ((!datasourceName || !databaseName) && this._databaseManager) {
      const conn = this._databaseManager.getCurrentConnection();
      const db = this._databaseManager.getCurrentDatabase();
      datasourceName = conn?.label?.toString() || "";
      databaseName = db?.label?.toString() || "";
    }

    if (!datasourceName || !databaseName) {
      return { connection: null, databaseName: "", datasourceName: "" };
    }

    try {
      const connection = await this._getConnection(datasourceName, databaseName);
      return { connection, databaseName, datasourceName };
    } catch {
      return { connection: null, databaseName, datasourceName };
    }
  }

  private _getWordAt(document: vscode.TextDocument, position: vscode.Position): string | null {
    const range = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_]+/);
    return range ? document.getText(range) : null;
  }

  private _parseTableColumn(
    word: string,
    sql: string,
    offset: number
  ): { table: string; column: string } | null {
    const before = sql.substring(0, offset);
    const match = before.match(/([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]*)$/);
    if (!match || match[2] !== word) return null;
    return { table: match[1], column: word };
  }

  private _parseTableName(word: string, sql: string, offset: number): string | null {
    const before = sql.substring(0, offset);
    const after = sql.substring(offset);
    const regex = /\b(FROM|JOIN|INTO|UPDATE|TABLE)\s+([a-zA-Z0-9_]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(sql)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      const tablePart = m[2];
      if (
        tablePart.toLowerCase() === word.toLowerCase() &&
        offset >= start &&
        offset <= end
      ) {
        return tablePart;
      }
    }
    // 检查 table. 后的表名部分（光标在表名上）
    const dotMatch = before.match(/([a-zA-Z0-9_]+)\.\s*$/);
    if (dotMatch && dotMatch[1].toLowerCase() === word.toLowerCase()) {
      return dotMatch[1];
    }
    return null;
  }

  private _parseStandaloneColumn(word: string, sql: string, offset: number): string | null {
    const before = sql.substring(0, offset);
    if (/\.\s*$/.test(before.trimEnd())) return null;
    if (/\b(FROM|JOIN|INTO|UPDATE|TABLE)\s+[a-zA-Z0-9_]*$/i.test(before)) return null;
    const upper = before.toUpperCase().replace(/\s+/g, " ");
    const tail = upper.slice(-80);
    if (!/\b(SELECT|WHERE|SET|ON|AND|OR|ORDER|GROUP|HAVING)\b/.test(tail)) return null;
    return word;
  }

  /**
   * 从 SQL 中提取本 cell 出现的表名（按出现顺序）
   */
  private _extractTablesFromSql(sql: string): string[] {
    const tables: string[] = [];
    const seen = new Set<string>();
    const regex = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+[`]?([a-zA-Z0-9_]+)[`]?/gi;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(sql)) !== null) {
      const name = m[1].toLowerCase();
      if (!seen.has(name)) {
        seen.add(name);
        tables.push(m[1]); // 保留原始大小写用于查询
      }
    }
    return tables;
  }

  private _hoverTable(
    connection: any,
    databaseName: string,
    tableName: string
  ): Promise<vscode.Hover | null> {
    return new Promise((resolve) => {
      const db = "`" + databaseName.replace(/`/g, "``") + "`";
      const tbl = "`" + tableName.replace(/`/g, "``") + "`";
      connection.query(
        `SHOW CREATE TABLE ${db}.${tbl}`,
        (err: any, results: any[]) => {
          if (err || !results?.[0]) {
            resolve(null);
            return;
          }
          const row = results[0] as Record<string, string>;
          const createSql = row["Create Table"] ?? row["create table"] ?? "";
          const md = new vscode.MarkdownString();
          md.appendMarkdown(`### 表 \`${tableName}\` DDL\n\n`);
          md.appendCodeblock(createSql, "sql");
          resolve(new vscode.Hover(md));
        }
      );
    });
  }

  private _hoverColumn(
    connection: any,
    databaseName: string,
    tableName: string | null,
    columnName: string,
    tablesInCell: string[] = []
  ): Promise<vscode.Hover | null> {
    return new Promise((resolve) => {
      const db = connection.escape(databaseName);
      const col = connection.escape(columnName);
      let sql = `
        SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, COLUMN_COMMENT, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ${db} AND COLUMN_NAME = ${col}
        ORDER BY TABLE_NAME, ORDINAL_POSITION
      `;
      if (tableName) {
        const tbl = connection.escape(tableName);
        sql += ` AND TABLE_NAME = ${tbl}`;
      }

      connection.query(sql, (err: any, results: any[]) => {
        if (err || !results?.length) {
          resolve(null);
          return;
        }

        let rows = results as any[];
        // 按优先级排序：1) 紧跟表名(table.column 已指定 table) 2) cell 中表 3) 全库
        if (!tableName && tablesInCell.length > 0) {
          const orderMap = new Map(tablesInCell.map((t, i) => [t.toLowerCase(), i]));
          rows = [...rows].sort((a, b) => {
            const aIdx = orderMap.get(a.TABLE_NAME.toLowerCase());
            const bIdx = orderMap.get(b.TABLE_NAME.toLowerCase());
            if (aIdx !== undefined && bIdx !== undefined) return aIdx - bIdx;
            if (aIdx !== undefined) return -1;
            if (bIdx !== undefined) return 1;
            return a.TABLE_NAME.localeCompare(b.TABLE_NAME);
          });
          // 仅 cell 中表有该字段时，只显示 cell 表
          const inCell = rows.filter((r) => orderMap.has(r.TABLE_NAME.toLowerCase()));
          if (inCell.length > 0) rows = inCell;
        }

        const md = new vscode.MarkdownString();

        if (rows.length === 1) {
          const r = rows[0];
          md.appendMarkdown(`### 字段 \`${r.COLUMN_NAME}\`\n\n`);
          md.appendMarkdown(`| 属性 | 值 |\n|------|----|\n`);
          md.appendMarkdown(`| 表 | ${r.TABLE_NAME} |\n`);
          md.appendMarkdown(`| 类型 | \`${r.COLUMN_TYPE}\` |\n`);
          md.appendMarkdown(`| 可空 | ${r.IS_NULLABLE} |\n`);
          if (r.COLUMN_DEFAULT != null && r.COLUMN_DEFAULT !== "") {
            md.appendMarkdown(`| 默认值 | \`${r.COLUMN_DEFAULT}\` |\n`);
          }
          if (r.EXTRA) {
            md.appendMarkdown(`| 额外 | ${r.EXTRA} |\n`);
          }
          if (r.COLUMN_COMMENT) {
            md.appendMarkdown(`\n**备注:** ${r.COLUMN_COMMENT}`);
          }
        } else {
          md.appendMarkdown(`### 字段 \`${columnName}\`\n\n`);
          const label = tablesInCell.length > 0 ? "本语句中的表" : "该字段在多个表中存在";
          md.appendMarkdown(`${label}：\n\n`);
          for (const r of rows) {
            md.appendMarkdown(`- **${r.TABLE_NAME}**: \`${r.COLUMN_TYPE}\`${r.COLUMN_COMMENT ? ` — ${r.COLUMN_COMMENT}` : ""}\n`);
          }
        }

        resolve(new vscode.Hover(md));
      });
    });
  }

  private async _getConnection(
    datasourceName: string,
    databaseName: string
  ): Promise<any> {
    const cacheKey = `${datasourceName}/${databaseName}`;
    const cached = this._connectionCache.get(cacheKey);
    if (cached && Date.now() - cached.lastUsed < this._connectionTimeout) {
      cached.lastUsed = Date.now();
      return cached.connection;
    }

    if (!this._provider) throw new Error("Provider 未设置");
    const connData = this._provider.getConnections().find((ds) => ds.name === datasourceName);
    if (!connData) throw new Error(`找不到数据源: ${datasourceName}`);
    if (connData.dbType && connData.dbType !== "mysql") {
      throw new Error("悬浮提示仅支持 MySQL 数据源");
    }

    const ds = new Datasource(connData);
    await ds.connect();
    if (!ds.dataloader) throw new Error("数据源无连接");

    const connection = (ds.dataloader as any).getConnection();
    await new Promise<void>((resolve, reject) => {
      connection.changeUser({ database: databaseName }, (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });

    this._connectionCache.set(cacheKey, {
      connection,
      lastUsed: Date.now(),
    });
    return connection;
  }
}
