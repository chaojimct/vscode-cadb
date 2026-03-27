import * as vscode from "vscode";
import { DataSourceProvider } from "./database_provider";
import { Datasource } from "./entity/datasource";
import { fuzzyMatch } from "./utils";
import { driverSupportsSqlExecution } from "./drivers/registry";

const CADB_TABLE_URI_SCHEME = "cadb";
const CADB_TABLE_URI_AUTHORITY = "table";

/**
 * 根据连接名、数据库名、表名解析出对应的表节点（Datasource），用于执行「查看数据」等命令。
 */
export async function resolveTableDatasource(
  provider: DataSourceProvider,
  context: vscode.ExtensionContext,
  connectionName: string,
  databaseName: string,
  tableName: string
): Promise<Datasource | null> {
  const connections = provider.getConnections();
  const connData = connections.find(
    (c) => (c.name || "").trim() === connectionName.trim()
  );
  if (!connData || !driverSupportsSqlExecution(connData.dbType)) {
    return null;
  }

  const connection = new Datasource(connData);
  const objects = await connection.expand(context);
  const datasourceTypeNode = objects?.find((o) => o.type === "datasourceType");
  if (!datasourceTypeNode) return null;

  const databases = await datasourceTypeNode.expand(context);
  const database = databases?.find(
    (db) => (db.label?.toString() || "").trim() === databaseName.trim()
  );
  if (!database) return null;

  const dbObjects = await database.expand(context);
  const tableTypeNode = dbObjects?.find((o) => o.type === "collectionType");
  if (!tableTypeNode) return null;

  const tables = await tableTypeNode.expand(context);
  const table = tables?.find(
    (t) => (t.label?.toString() || "").trim() === tableName.trim()
  );
  return table ?? null;
}

/**
 * 从 cadb://table/connectionName/databaseName/tableName 解析出三部分名称。
 */
export function parseTableUri(uri: vscode.Uri): {
  connectionName: string;
  databaseName: string;
  tableName: string;
} | null {
  if (uri.scheme !== CADB_TABLE_URI_SCHEME || uri.authority !== CADB_TABLE_URI_AUTHORITY) {
    return null;
  }
  const parts = uri.path.split("/").filter(Boolean);
  if (parts.length < 3) return null;
  return {
    connectionName: decodeURIComponent(parts[0]),
    databaseName: decodeURIComponent(parts[1]),
    tableName: decodeURIComponent(parts[2]),
  };
}

/**
 * 构建表的 cadb:// URI，用于工作区符号的 location。
 */
export function buildTableUri(
  connectionName: string,
  databaseName: string,
  tableName: string
): vscode.Uri {
  const path = [
    encodeURIComponent(connectionName),
    encodeURIComponent(databaseName),
    encodeURIComponent(tableName),
  ].join("/");
  return vscode.Uri.parse(
    `${CADB_TABLE_URI_SCHEME}://${CADB_TABLE_URI_AUTHORITY}/${path}`
  );
}

/** 关闭符号跳转打开的 cadb 虚拟文档标签，避免停留在空白中间页 */
async function closeCadbVirtualTableDocumentTab(uri: vscode.Uri): Promise<void> {
  const target = uri.toString();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputText && input.uri.toString() === target) {
        await vscode.window.tabGroups.close(tab);
        return;
      }
    }
  }
}

/**
 * 收集所有 MySQL 连接下的表信息 (connectionName, databaseName, tableName)。
 * 仅扫描「显示的数据库」：若连接有勾选的数据库则只处理这些，否则处理全部。
 */
async function collectAllMySQLTables(
  provider: DataSourceProvider,
  context: vscode.ExtensionContext,
  token: vscode.CancellationToken
): Promise<{ connectionName: string; databaseName: string; tableName: string }[]> {
  const connections = provider.getConnections();
  const result: { connectionName: string; databaseName: string; tableName: string }[] = [];

  for (const connData of connections) {
    if (token.isCancellationRequested) return result;

    if (!driverSupportsSqlExecution(connData.dbType)) continue;

    const connection = new Datasource(connData);
    const connectionName = connection.label?.toString() || connData.name || "";

    let objects: Datasource[] | undefined;
    try {
      objects = await connection.expand(context);
    } catch {
      continue;
    }

    const datasourceTypeNode = objects?.find((o) => o.type === "datasourceType");
    if (!datasourceTypeNode) continue;

    let databases: Datasource[] | undefined;
    try {
      databases = await datasourceTypeNode.expand(context);
    } catch {
      continue;
    }

    const selectedDbNames = provider.getSelectedDatabases(connectionName);
    let databasesToScan = databases || [];
    if (selectedDbNames.length > 0) {
      const set = new Set(selectedDbNames);
      databasesToScan = databasesToScan.filter((db) =>
        set.has(db.label?.toString() || "")
      );
    }

    for (const database of databasesToScan) {
      if (token.isCancellationRequested) return result;
      const databaseName = database.label?.toString() || "";

      let dbObjects: Datasource[] | undefined;
      try {
        dbObjects = await database.expand(context);
      } catch {
        continue;
      }

      const tableTypeNode = dbObjects?.find((o) => o.type === "collectionType");
      if (!tableTypeNode) continue;

      let tables: Datasource[] | undefined;
      try {
        tables = await tableTypeNode.expand(context);
      } catch {
        continue;
      }

      for (const table of tables || []) {
        if (token.isCancellationRequested) return result;
        const tableName = table.label?.toString() || "";
        if (tableName) {
          result.push({ connectionName, databaseName, tableName });
        }
      }
    }
  }

  return result;
}

/**
 * 工作区符号提供者：将 MySQL 数据表加入「转到工作区中的符号」(Ctrl/Cmd+T)。
 * 选择某个表符号时会短暂打开 cadb:// 虚拟文档，由 CadbTableDocumentContentProvider 打开表数据后自动关闭该标签。
 */
export class MySQLTableWorkspaceSymbolProvider
  implements vscode.WorkspaceSymbolProvider
{
  constructor(
    private readonly provider: DataSourceProvider,
    private readonly context: vscode.ExtensionContext
  ) {}

  async provideWorkspaceSymbols(
    query: string,
    token: vscode.CancellationToken
  ): Promise<vscode.SymbolInformation[]> {
    const all = await collectAllMySQLTables(
      this.provider,
      this.context,
      token
    );
    if (token.isCancellationRequested) return [];

    const q = (query || "").trim().toLowerCase();
    const filtered = q
      ? all.filter(
          (t) =>
            fuzzyMatch(query, t.tableName) ||
            fuzzyMatch(query, t.databaseName) ||
            fuzzyMatch(query, t.connectionName)
        )
      : all;

    return filtered.map((t) => {
      const location = new vscode.Location(
        buildTableUri(t.connectionName, t.databaseName, t.tableName),
        new vscode.Range(0, 0, 0, 0)
      );
      return new vscode.SymbolInformation(
        t.tableName,
        vscode.SymbolKind.Class,
        `${t.connectionName} / ${t.databaseName}`,
        location
      );
    });
  }
}

/**
 * 为 cadb://table/... 提供虚拟文档（内容为空），打开时异步执行「查看数据」并关闭本标签，避免符号搜索出现中间说明页。
 */
export class CadbTableDocumentContentProvider
  implements vscode.TextDocumentContentProvider
{
  constructor(
    private readonly provider: DataSourceProvider,
    private readonly context: vscode.ExtensionContext
  ) {}

  provideTextDocumentContent(
    uri: vscode.Uri,
    _token: vscode.CancellationToken
  ): string {
    const parsed = parseTableUri(uri);
    if (!parsed) {
      return "# 无效的表 URI";
    }

    // 不展示中间页：内容为空，打开真实表视图后关闭本虚拟文档标签
    void (async () => {
      try {
        const tableDatasource = await resolveTableDatasource(
          this.provider,
          this.context,
          parsed.connectionName,
          parsed.databaseName,
          parsed.tableName
        );
        if (tableDatasource) {
          await vscode.commands.executeCommand("cadb.item.showData", tableDatasource);
        }
      } catch {
        /* 忽略 */
      } finally {
        await closeCadbVirtualTableDocumentTab(uri);
      }
    })();

    return "";
  }
}
