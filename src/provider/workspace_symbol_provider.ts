import * as vscode from "vscode";
import { DataSourceProvider } from "./database_provider";
import { Datasource } from "./entity/datasource";

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
  if (!connData || (connData.dbType && connData.dbType !== "mysql")) {
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

/**
 * 模糊匹配：query 的字符按顺序出现在 text 中即视为匹配（忽略大小写）。
 */
function fuzzyMatch(query: string, text: string): boolean {
  if (!query.trim()) return true;
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase();
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) i++;
  }
  return i === q.length;
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

    if (connData.dbType && connData.dbType !== "mysql") continue;

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
 * 选择某个表符号时会打开 cadb:// 虚拟文档，由 CadbTableDocumentContentProvider 负责打开表数据视图。
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
 * 为 cadb://table/... 提供虚拟文档内容，并在打开时触发「查看数据」命令以打开表数据面板。
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
    if (!parsed) return "# 无效的表 URI";

    // 异步打开表数据视图，不阻塞文档内容返回
    resolveTableDatasource(
      this.provider,
      this.context,
      parsed.connectionName,
      parsed.databaseName,
      parsed.tableName
    ).then((tableDatasource) => {
      if (tableDatasource) {
        vscode.commands.executeCommand("cadb.item.showData", tableDatasource);
      }
    });

    return `# MySQL 表\n\n${parsed.connectionName} / ${parsed.databaseName} / ${parsed.tableName}\n\n正在打开表数据…`;
  }
}
