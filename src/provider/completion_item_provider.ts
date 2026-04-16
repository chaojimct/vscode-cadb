import * as vscode from "vscode";
import type { DatabaseManager } from "./component/database_manager";
import { Datasource, type DatasourceInputData } from "./entity/datasource";
import type { DataSourceProvider } from "./database_provider";

/**
 * SQL 自动补全提供者
 * 提供数据库、表、字段、索引、视图等名称的智能补全
 * 适用于 languageId 为 sql 的编辑器（含 *.sql、未命名 SQL 等）
 */
export class CaCompletionItemProvider implements vscode.CompletionItemProvider {
  private _databaseManager?: DatabaseManager;
  private provider?: DataSourceProvider;
  private cachedCompletions: Map<string, CachedCompletion> = new Map();
  private cacheTimeout = 60000; // 缓存 1 分钟
  /** 在补全前将 workspace 中该 SQL 文件绑定的连接/库恢复到 DatabaseManager（与 extension 中逻辑一致） */
  private _prepareSqlDocument?: (
    document: vscode.TextDocument,
  ) => Promise<void>;

  constructor() {}

  public setDatabaseManager(databaseManager: DatabaseManager): void {
    this._databaseManager = databaseManager;
  }

  public setProvider(provider: DataSourceProvider): void {
    this.provider = provider;
  }

  /**
   * 由 extension 注入：打开 *.sql 或触发补全前，按文件 URI 恢复上次选择的数据源与库
   */
  public setPrepareSqlDocument(
    fn: (document: vscode.TextDocument) => Promise<void>,
  ): void {
    this._prepareSqlDocument = fn;
  }

  /**
   * 提供补全项
   */
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): Promise<
    vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem>
  > {
    if (document.languageId !== "sql") {
      return [];
    }

    if (this._prepareSqlDocument) {
      try {
        await this._prepareSqlDocument(document);
      } catch {
        /* 恢复绑定失败时仍尝试用当前全局连接补全 */
      }
    }

    let currentConnection: Datasource | null = null;
    let currentDatabase: Datasource | null = null;

    if (this._databaseManager) {
      currentConnection = this._databaseManager.getCurrentConnection();
      currentDatabase = this._databaseManager.getCurrentDatabase();
    }

    if (!currentConnection) {
      return this.getSQLKeywords();
    }

    // 光标前文本（跨行）：用于识别 FROM/JOIN 与 table.column 等上下文
    const textBeforeCursor = this.getTextBeforeCursor(document, position);

    // 分析上下文，确定补全类型
    const completionType = this.getCompletionType(textBeforeCursor);

    const completions: vscode.CompletionItem[] = [];

    try {
      switch (completionType) {
        case "database":
          // 补全数据库名
          completions.push(
            ...(await this.getDatabaseCompletions(currentConnection)),
          );
          break;

        case "table":
          // 补全表名
          if (currentDatabase) {
            completions.push(
              ...(await this.getTableCompletions(currentDatabase)),
            );
          } else {
            completions.push(...(await this.getDatabaseCompletions(currentConnection)));
          }
          break;

        case "column":
          // 补全字段名
          if (currentDatabase) {
            const tableName = this.extractTableName(textBeforeCursor);
            if (tableName) {
              completions.push(
                ...(await this.getColumnCompletions(
                  currentDatabase,
                  tableName,
                )),
              );
            } else {
              // 如果无法确定表名，显示所有表的字段
              completions.push(
                ...(await this.getAllColumnsCompletions(currentDatabase)),
              );
            }
          }
          break;

        default:
          // 默认：显示 SQL 关键字、数据库和表名
          completions.push(...this.getSQLKeywords());
          if (currentDatabase) {
            completions.push(
              ...(await this.getTableCompletions(currentDatabase)),
            );
          } else {
            completions.push(
              ...(await this.getDatabaseCompletions(currentConnection)),
            );
          }
          break;
      }
    } catch (error) {
      console.error("补全提供失败:", error);
    }

    return completions;
  }

  /**
   * 解析补全项（可选）
   */
  resolveCompletionItem(
    item: vscode.CompletionItem,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.CompletionItem> {
    return item;
  }

  /**
   * 光标前一段文本（跨行），用于识别 FROM / JOIN / 表.列 等上下文
   */
  private getTextBeforeCursor(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): string {
    const offset = document.offsetAt(position);
    const maxLen = 64000;
    const start = Math.max(0, offset - maxLen);
    const range = new vscode.Range(document.positionAt(start), position);
    return document.getText(range);
  }

  /** 按配置 name 或 TreeItem 展示名匹配原始连接数据 */
  private resolveConnectionRaw(
    connectionLabel: string,
  ): DatasourceInputData | undefined {
    if (!this.provider) {
      return undefined;
    }
    const t = connectionLabel.trim();
    if (!t) {
      return undefined;
    }
    for (const ds of this.provider.getConnections()) {
      if ((ds.name || "").trim() === t) {
        return ds;
      }
      try {
        const node = new Datasource(ds);
        const lbl = node.label != null ? String(node.label).trim() : "";
        if (lbl && lbl === t) {
          return ds;
        }
      } catch {
        /* 忽略构造失败 */
      }
    }
    return undefined;
  }

  /**
   * 确定补全类型（基于光标前多行合并后的上下文）
   */
  private getCompletionType(
    text: string,
  ): "database" | "table" | "column" | "default" {
    const compact = text.replace(/\s+/g, " ").trimEnd();

    if (/USE\s+$/i.test(compact)) {
      return "database";
    }

    if (
      /(?:FROM|JOIN|INTO|UPDATE|ALTER\s+TABLE)\s+(?:`[^`]*`|[\w.]*)$/i.test(
        compact,
      )
    ) {
      return "table";
    }

    if (
      /(?:`[^`]+`|[a-zA-Z_][a-zA-Z0-9_]*)\.(?:`[^`]*`|[a-zA-Z0-9_]*)$/i.test(
        compact,
      )
    ) {
      return "column";
    }

    if (
      /(?:SELECT|WHERE|SET|HAVING|ON|ORDER BY|GROUP BY)\s+[\w`.,\s()]*$/i.test(
        compact,
      )
    ) {
      return "column";
    }

    return "default";
  }

  /**
   * 提取表名（table.column、db.table、FROM/JOIN 子句）
   */
  private extractTableName(text: string): string | null {
    const compact = text.replace(/\s+/g, " ").trimEnd();

    const dotMatch = compact.match(
      /(?:`([^`]+)`|([a-zA-Z_][a-zA-Z0-9_]*))\.(?:`([^`]*)`|[a-zA-Z0-9_]*)$/i,
    );
    if (dotMatch) {
      const id = (dotMatch[1] || dotMatch[2] || "").trim();
      if (!id) {
        return null;
      }
      if (id.includes(".")) {
        const parts = id.split(".");
        return parts[parts.length - 1] || id;
      }
      return id;
    }

    let last: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    const fromRe =
      /\bFROM\s+(?:`([^`]+)`|([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)?))/gi;
    while ((m = fromRe.exec(compact)) !== null) {
      last = m;
    }
    if (last) {
      const raw = (last[1] || last[2] || "").trim();
      if (raw) {
        return raw.includes(".") ? raw.split(".").pop() || raw : raw;
      }
    }

    last = null;
    const joinRe =
      /\bJOIN\s+(?:`([^`]+)`|([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)?))/gi;
    while ((m = joinRe.exec(compact)) !== null) {
      last = m;
    }
    if (last) {
      const raw = (last[1] || last[2] || "").trim();
      if (raw) {
        return raw.includes(".") ? raw.split(".").pop() || raw : raw;
      }
    }

    return null;
  }

  /**
   * 获取数据库名补全
   */
  private async getDatabaseCompletions(
    connection: Datasource
  ): Promise<vscode.CompletionItem[]> {
    const cacheKey = `databases:${connection.data?.name ?? connection.label ?? ""}`;
    const cached = this.getCached(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      if (!this.provider) {
        return [];
      }
      // 获取连接下的对象（包含 datasourceType, userType, fileType）
      const connLabel = String(
        connection.data?.name ?? connection.label ?? "",
      ).trim();
      const connectionObj = this.resolveConnectionRaw(connLabel);
      if (!connectionObj) {
        return [];
      }
      const connectionDatasource = new Datasource(connectionObj);
      const objects = await connectionDatasource.expand(this.provider.context);

      // 找到 datasourceType 节点
      const datasourceTypeNode = objects.find(
        (obj) => obj.type === "datasourceType"
      );
      if (!datasourceTypeNode) {
        return [];
      }

      // 展开获取所有数据库
      const databases = await datasourceTypeNode.expand(
        this.provider.context
      );
      const completions = databases.map((db) => {
        const item = new vscode.CompletionItem(
          db.label?.toString() || "",
          vscode.CompletionItemKind.Module
        );
        // 右侧显示类型标签
        const charset = db.description || '';
        item.detail = charset ? `[数据库] ${charset}` : '[数据库]';
        
        // 悬停文档
        const docs = [];
        docs.push(`**${db.label}**`);
        docs.push('');
        docs.push('📦 类型: 数据库');
        if (charset) {
          docs.push(`🔤 字符集: ${charset}`);
        }
        if (db.tooltip) {
          docs.push('');
          docs.push(db.tooltip.toString());
        }
        item.documentation = new vscode.MarkdownString(docs.join('\n'));
        
        return item;
      });

      this.setCached(cacheKey, completions);
      return completions;
    } catch (error) {
      return [];
    }
  }

  /**
   * 获取表名补全
   */
  private async getTableCompletions(
    database: Datasource
  ): Promise<vscode.CompletionItem[]> {
    const cacheKey = `tables:${database.label}`;
    const cached = this.getCached(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      if (!this.provider) {
        return [];
      }
      // 需要找到实际的数据库对象
      // 这里简化处理，假设 database 是一个包含 label 的对象
      const databaseName = database.label?.toString() || '';
      if (!databaseName) {
        return [];
      }

      // 从 provider 中查找数据库
      let databaseObj: Datasource | null = null;
      for (const connData of this.provider.getConnections()) {
        const conn = new Datasource(connData);
        const objects = await conn.expand(this.provider.context);
        const datasourceTypeNode = objects.find(
          (obj) => obj.type === "datasourceType"
        );
        if (datasourceTypeNode) {
          const databases = await datasourceTypeNode.expand(this.provider.context);
          const found = databases.find(
            (db) => db.label?.toString() === databaseName
          );
          if (found) {
            databaseObj = found;
            break;
          }
        }
      }

      if (!databaseObj) {
        return [];
      }

      // 获取数据库节点下的对象（collectionType, userType 等）
      const objects = await databaseObj.expand(this.provider.context);
      const tableTypeNode = objects.find(
        (obj) => obj.type === "collectionType"
      );

      if (!tableTypeNode) {
        return [];
      }

      // 获取所有表
      const tables = await tableTypeNode.expand(this.provider.context);
      const completions = tables.map((table) => {
        const item = new vscode.CompletionItem(
          table.label?.toString() || "",
          vscode.CompletionItemKind.Class
        );
        const tableInfo = table.description?.toString() || "";
        // 描述中必须体现所属数据库（建议列表右侧 detail）
        item.detail = tableInfo
          ? `[表] 所属数据库: ${databaseName} · ${tableInfo}`
          : `[表] 所属数据库: ${databaseName}`;

        // 悬停文档
        const docs = [];
        docs.push(`**${table.label}**`);
        docs.push("");
        docs.push("📋 类型: 数据表");
        docs.push(`🗄️ 所属数据库: ${databaseName}`);
        if (tableInfo) {
          docs.push(`ℹ️ 信息: ${tableInfo}`);
        }
        item.documentation = new vscode.MarkdownString(docs.join("\n"));
        
        return item;
      });

      this.setCached(cacheKey, completions);
      return completions;
    } catch (error) {
      return [];
    }
  }

  /**
   * 获取指定表的字段补全
   */
  private async getColumnCompletions(
    database: Datasource,
    tableName: string
  ): Promise<vscode.CompletionItem[]> {
    const cacheKey = `columns:${database.label}:${tableName}`;
    const cached = this.getCached(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      if (!this.provider) {
        return [];
      }
      // 查找表节点
      const table = await this.findTable(database, tableName);
      if (!table) {
        return [];
      }

      // 获取表的对象（字段、索引等）
      const objects = await table.expand(this.provider.context);
      const fieldTypeNode = objects.find((obj) => obj.type === "fieldType");

      if (!fieldTypeNode) {
        return [];
      }

      // 获取所有字段
      const fields = await fieldTypeNode.expand(this.provider.context);
      const dbLabel = String(database.label ?? "");
      const completions = fields.map((field) => {
        const item = new vscode.CompletionItem(
          field.label?.toString() || "",
          vscode.CompletionItemKind.Field
        );
        const fieldType =
          typeof field.description === "string" ? field.description : "";
        // 描述中必须体现所属表（建议列表右侧 detail）
        item.detail = fieldType
          ? `[字段] 所属表: ${tableName} · ${fieldType}`
          : `[字段] 所属表: ${tableName}`;

        // 悬停文档
        const docs = [];
        docs.push(`**${field.label}**`);
        docs.push("");
        docs.push("🔹 类型: 字段");
        docs.push(`📋 所属表: ${tableName}`);
        docs.push(`🗄️ 所属数据库: ${dbLabel}`);
        if (fieldType) {
          docs.push(`📊 数据类型: ${fieldType}`);
        }
        item.documentation = new vscode.MarkdownString(docs.join("\n"));
        
        return item;
      });

      this.setCached(cacheKey, completions);
      return completions;
    } catch (error) {
      return [];
    }
  }

  /**
   * 获取所有表的字段补全
   */
  private async getAllColumnsCompletions(
    database: Datasource
  ): Promise<vscode.CompletionItem[]> {
    try {
      if (!this.provider) {
        return [];
      }
      // 获取所有表
      const databaseName = database.label?.toString() || '';
      if (!databaseName) {
        return [];
      }

      // 从 provider 中查找数据库
      let databaseObj: Datasource | null = null;
      for (const connData of this.provider.getConnections()) {
        const conn = new Datasource(connData);
        const objects = await conn.expand(this.provider.context);
        const datasourceTypeNode = objects.find(
          (obj) => obj.type === "datasourceType"
        );
        if (datasourceTypeNode) {
          const databases = await datasourceTypeNode.expand(this.provider.context);
          const found = databases.find(
            (db) => db.label?.toString() === databaseName
          );
          if (found) {
            databaseObj = found;
            break;
          }
        }
      }

      if (!databaseObj) {
        return [];
      }

      const objects = await databaseObj.expand(this.provider.context);
      const tableTypeNode = objects.find(
        (obj) => obj.type === "collectionType"
      );

      if (!tableTypeNode) {
        return [];
      }

      const tables = await tableTypeNode.expand(this.provider.context);
      const allCompletions: vscode.CompletionItem[] = [];

      // 获取每个表的字段（限制数量避免太慢）
      const tablesToFetch = tables.slice(0, 10);
      for (const table of tablesToFetch) {
        const columns = await this.getColumnCompletions(
          database,
          table.label?.toString() || ""
        );
        allCompletions.push(...columns);
      }

      return allCompletions;
    } catch (error) {
      return [];
    }
  }

  /**
   * 查找表
   */
  private async findTable(
    database: Datasource,
    tableName: string
  ): Promise<Datasource | null> {
    try {
      if (!this.provider) {
        return null;
      }
      const databaseName = database.label?.toString() || '';
      if (!databaseName) {
        return null;
      }

      // 从 provider 中查找数据库
      let databaseObj: Datasource | null = null;
      for (const connData of this.provider.getConnections()) {
        const conn = new Datasource(connData);
        const objects = await conn.expand(this.provider.context);
        const datasourceTypeNode = objects.find(
          (obj) => obj.type === "datasourceType"
        );
        if (datasourceTypeNode) {
          const databases = await datasourceTypeNode.expand(this.provider.context);
          const found = databases.find(
            (db) => db.label?.toString() === databaseName
          );
          if (found) {
            databaseObj = found;
            break;
          }
        }
      }

      if (!databaseObj) {
        return null;
      }

      const objects = await databaseObj.expand(this.provider.context);
      const tableTypeNode = objects.find(
        (obj) => obj.type === "collectionType"
      );

      if (!tableTypeNode) {
        return null;
      }

      const tables = await tableTypeNode.expand(this.provider.context);
      return (
        tables.find(
          (table) =>
            table.label?.toString().toLowerCase() === tableName.toLowerCase()
        ) || null
      );
    } catch (error) {
      return null;
    }
  }

  /**
   * 获取 SQL 关键字补全
   */
  private getSQLKeywords(): vscode.CompletionItem[] {
    const keywords = [
      // DML
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "FROM",
      "WHERE",
      "JOIN",
      "LEFT JOIN",
      "RIGHT JOIN",
      "INNER JOIN",
      "ON",
      "AND",
      "OR",
      "NOT",
      "IN",
      "LIKE",
      "BETWEEN",
      "ORDER BY",
      "GROUP BY",
      "HAVING",
      "LIMIT",
      "OFFSET",
      "AS",
      "DISTINCT",
      "ALL",
      // DDL
      "CREATE",
      "ALTER",
      "DROP",
      "TRUNCATE",
      "TABLE",
      "DATABASE",
      "INDEX",
      "VIEW",
      // 数据类型
      "INT",
      "VARCHAR",
      "TEXT",
      "DATE",
      "DATETIME",
      "TIMESTAMP",
      "FLOAT",
      "DOUBLE",
      "DECIMAL",
      "BOOLEAN",
      // 约束
      "PRIMARY KEY",
      "FOREIGN KEY",
      "UNIQUE",
      "NOT NULL",
      "DEFAULT",
      "AUTO_INCREMENT",
      "CHECK",
      // 其他
      "USE",
      "SHOW",
      "DESCRIBE",
      "EXPLAIN",
      "COUNT",
      "SUM",
      "AVG",
      "MAX",
      "MIN",
      "UNION",
      "EXISTS",
      "CASE",
      "WHEN",
      "THEN",
      "ELSE",
      "END",
    ];

    return keywords.map((keyword) => {
      const item = new vscode.CompletionItem(
        keyword,
        vscode.CompletionItemKind.Keyword
      );
      // 右侧显示类型标签
      item.detail = "[关键字]";
      
      // 悬停文档
      const category = this.getKeywordCategory(keyword);
      const docs = [];
      docs.push(`**${keyword}**`);
      docs.push('');
      docs.push(`⌨️ 类型: SQL 关键字 (${category})`);
      item.documentation = new vscode.MarkdownString(docs.join('\n'));
      
      return item;
    });
  }

  /**
   * 获取关键字分类
   */
  private getKeywordCategory(keyword: string): string {
    const dml = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'ON', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN', 'ORDER BY', 'GROUP BY', 'HAVING', 'LIMIT', 'OFFSET', 'AS', 'DISTINCT', 'ALL'];
    const ddl = ['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'TABLE', 'DATABASE', 'INDEX', 'VIEW'];
    const dataTypes = ['INT', 'VARCHAR', 'TEXT', 'DATE', 'DATETIME', 'TIMESTAMP', 'FLOAT', 'DOUBLE', 'DECIMAL', 'BOOLEAN'];
    const constraints = ['PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE', 'NOT NULL', 'DEFAULT', 'AUTO_INCREMENT', 'CHECK'];
    const functions = ['COUNT', 'SUM', 'AVG', 'MAX', 'MIN'];
    
    if (dml.includes(keyword)) {
      return 'DML';
    }
    if (ddl.includes(keyword)) {
      return 'DDL';
    }
    if (dataTypes.includes(keyword)) {
      return '数据类型';
    }
    if (constraints.includes(keyword)) {
      return '约束';
    }
    if (functions.includes(keyword)) {
      return '函数';
    }
    return '其他';
  }

  /**
   * 获取缓存
   */
  private getCached(key: string): vscode.CompletionItem[] | null {
    const cached = this.cachedCompletions.get(key);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.items;
    }
    return null;
  }

  /**
   * 设置缓存
   */
  private setCached(key: string, items: vscode.CompletionItem[]): void {
    this.cachedCompletions.set(key, {
      items,
      timestamp: Date.now(),
    });
	}

  /**
   * 清除缓存
   */
  public clearCache(): void {
    this.cachedCompletions.clear();
  }
}

interface CachedCompletion {
  items: vscode.CompletionItem[];
  timestamp: number;
}
