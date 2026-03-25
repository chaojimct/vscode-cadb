import * as vscode from "vscode";
import { escape as mysqlEscape, type Pool } from "mysql2";
import type { DatabaseManager } from "./database_manager";
import { DataSourceProvider } from "../database_provider";
import type { DatasourceInputData } from "../entity/datasource";
import { driverSupportsSchemaHover } from "../drivers/registry";
import { getMysqlPoolRegistry } from "../mysql/pool_registry";

/** 最近悬浮的表信息，用于无参 command 链接回退（hover 内传参在某些环境下不生效） */
export let lastHoveredTableInfo: { conn: string; db: string; table: string } | null =
  null;

/**
 * SQL 悬浮提示提供者（每次查询经连接池 pool.query，不长期占用连接）
 */
export class SqlHoverProvider implements vscode.HoverProvider {
  private _databaseManager?: DatabaseManager;
  private _provider?: DataSourceProvider;

  dispose(): void {
    // 连接由 MysqlPoolRegistry 管理
  }

  setDatabaseManager(m: DatabaseManager): void {
    this._databaseManager = m;
  }

  setProvider(p: DataSourceProvider): void {
    this._provider = p;
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): Promise<vscode.Hover | null | undefined> {
    const resolved = await this._resolveContext(document);
    if (!resolved.input || !resolved.databaseName) {
      return undefined;
    }

    const pool = getMysqlPoolRegistry().getPool(resolved.input);

    const word = this._getWordAt(document, position);
    if (!word) return undefined;

    const sql = document.getText();
    const offset = document.offsetAt(position);
    const aliasMap = this._buildAliasMap(sql);

    const tableCol = this._parseTableColumn(word, sql, offset);
    if (tableCol) {
      const realTable =
        aliasMap.get(tableCol.table.toLowerCase()) ?? tableCol.table;
      return this._hoverColumn(
        pool,
        resolved.databaseName,
        realTable,
        tableCol.column
      );
    }

    const tableName = this._parseTableName(word, sql, offset);
    if (tableName) {
      return this._hoverTable(
        pool,
        resolved.databaseName,
        resolved.datasourceName,
        tableName,
        null
      );
    }

    const aliasTable = aliasMap.get(word.toLowerCase());
    if (aliasTable) {
      return this._hoverTable(
        pool,
        resolved.databaseName,
        resolved.datasourceName,
        aliasTable,
        word
      );
    }

    const columnName = this._parseStandaloneColumn(word, sql, offset);
    if (columnName) {
      const tablesInCell = this._extractTablesFromSql(sql);
      return this._hoverColumn(
        pool,
        resolved.databaseName,
        null,
        columnName,
        tablesInCell
      );
    }

    return undefined;
  }

  private async _resolveContext(document: vscode.TextDocument): Promise<{
    input: DatasourceInputData | null;
    databaseName: string;
    datasourceName: string;
  }> {
    let datasourceName = "";
    let databaseName = "";

    if (document.uri.scheme === "vscode-notebook-cell") {
      const notebook = vscode.workspace.notebookDocuments.find((nb) =>
        nb.getCells().some(
          (c) => c.document.uri.toString() === document.uri.toString()
        )
      );
      if (notebook) {
        const cell = notebook
          .getCells()
          .find((c) => c.document.uri.toString() === document.uri.toString());
        const cellCadb = cell?.metadata?.cadb as
          | { datasource?: string; database?: string }
          | undefined;
        if (cellCadb?.datasource && cellCadb?.database) {
          datasourceName = cellCadb.datasource;
          databaseName = cellCadb.database;
        } else if (notebook.metadata) {
          datasourceName = (notebook.metadata.datasource as string) || "";
          databaseName = (notebook.metadata.database as string) || "";
        }
      }
    }

    if ((!datasourceName || !databaseName) && this._databaseManager) {
      const conn = this._databaseManager.getCurrentConnection();
      const db = this._databaseManager.getCurrentDatabase();
      datasourceName = conn?.label?.toString() || "";
      databaseName = db?.label?.toString() || "";
    }

    if (!datasourceName || !databaseName || !this._provider) {
      return { input: null, databaseName: "", datasourceName: "" };
    }

    const connData = this._provider
      .getConnections()
      .find((ds) => ds.name === datasourceName);
    if (!connData || !driverSupportsSchemaHover(connData.dbType)) {
      return { input: null, databaseName, datasourceName };
    }

    return {
      input: connData as DatasourceInputData,
      databaseName,
      datasourceName,
    };
  }

  private _getWordAt(
    document: vscode.TextDocument,
    position: vscode.Position
  ): string | null {
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

  private _parseTableName(
    word: string,
    sql: string,
    offset: number
  ): string | null {
    const before = sql.substring(0, offset);
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
    const dotMatch = before.match(/([a-zA-Z0-9_]+)\.\s*$/);
    if (dotMatch && dotMatch[1].toLowerCase() === word.toLowerCase()) {
      return dotMatch[1];
    }
    return null;
  }

  private _parseStandaloneColumn(
    word: string,
    sql: string,
    offset: number
  ): string | null {
    const before = sql.substring(0, offset);
    if (/\.\s*$/.test(before.trimEnd())) return null;
    if (/\b(FROM|JOIN|INTO|UPDATE|TABLE)\s+[a-zA-Z0-9_]*$/i.test(before))
      return null;
    const upper = before.toUpperCase().replace(/\s+/g, " ");
    const tail = upper.slice(-80);
    if (!/\b(SELECT|WHERE|SET|ON|AND|OR|ORDER|GROUP|HAVING)\b/.test(tail))
      return null;
    return word;
  }

  private _buildAliasMap(sql: string): Map<string, string> {
    const map = new Map<string, string>();
    const regex =
      /\b(?:FROM|JOIN)\s+[`]?([a-zA-Z0-9_]+)[`]?(?:\s+(?:AS\s+)?[`]?([a-zA-Z0-9_]+)[`]?)?/gi;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(sql)) !== null) {
      const table = m[1];
      const alias = m[2];
      if (alias && alias.toLowerCase() !== table.toLowerCase()) {
        map.set(alias.toLowerCase(), table);
      }
      map.set(table.toLowerCase(), table);
    }
    return map;
  }

  private _extractTablesFromSql(sql: string): string[] {
    const tables: string[] = [];
    const seen = new Set<string>();
    const regex = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+[`]?([a-zA-Z0-9_]+)[`]?/gi;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(sql)) !== null) {
      const name = m[1].toLowerCase();
      if (!seen.has(name)) {
        seen.add(name);
        tables.push(m[1]);
      }
    }
    return tables;
  }

  private _hoverTable(
    pool: Pool,
    databaseName: string,
    datasourceName: string,
    tableName: string,
    alias: string | null = null
  ): Promise<vscode.Hover | null> {
    return new Promise((resolve) => {
      const db = "`" + databaseName.replace(/`/g, "``") + "`";
      const tbl = "`" + tableName.replace(/`/g, "``") + "`";
      pool.query(
        `SHOW CREATE TABLE ${db}.${tbl}`,
        (err: any, results: any[]) => {
          if (err || !results?.[0]) {
            resolve(null);
            return;
          }
          const row = results[0] as Record<string, string>;
          const createSql = row["Create Table"] ?? row["create table"] ?? "";
          lastHoveredTableInfo = {
            conn: datasourceName,
            db: databaseName,
            table: tableName,
          };
          const md = new vscode.MarkdownString();
          md.isTrusted = true;
          md.appendMarkdown(
            `[进入表数据](command:cadb.hover.openTableData) · [表编辑](command:cadb.hover.editTable)\n\n`
          );
          if (alias) {
            md.appendMarkdown(`别名 \`${alias}\` → 表 \`${tableName}\`\n\n`);
          }
          md.appendMarkdown(`### 表 \`${tableName}\` DDL\n\n`);
          md.appendCodeblock(createSql, "sql");
          resolve(new vscode.Hover(md));
        }
      );
    });
  }

  private _hoverColumn(
    pool: Pool,
    databaseName: string,
    tableName: string | null,
    columnName: string,
    tablesInCell: string[] = []
  ): Promise<vscode.Hover | null> {
    return new Promise((resolve) => {
      const db = mysqlEscape(databaseName);
      const col = mysqlEscape(columnName);
      let sql = `
        SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, COLUMN_COMMENT, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ${db} AND COLUMN_NAME = ${col}
        ORDER BY TABLE_NAME, ORDINAL_POSITION
      `;
      if (tableName) {
        const tbl = mysqlEscape(tableName);
        sql += ` AND TABLE_NAME = ${tbl}`;
      }

      pool.query(sql, (err: any, results: any[]) => {
        if (err || !results?.length) {
          resolve(null);
          return;
        }

        let rows = results as any[];
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
          const inCell = rows.filter((r) =>
            orderMap.has(r.TABLE_NAME.toLowerCase())
          );
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
          const label =
            tablesInCell.length > 0 ? "本语句中的表" : "该字段在多个表中存在";
          md.appendMarkdown(`${label}：\n\n`);
          for (const r of rows) {
            md.appendMarkdown(
              `- **${r.TABLE_NAME}**: \`${r.COLUMN_TYPE}\`${r.COLUMN_COMMENT ? ` — ${r.COLUMN_COMMENT}` : ""}\n`
            );
          }
        }

        resolve(new vscode.Hover(md));
      });
    });
  }
}
