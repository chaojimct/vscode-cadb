import * as vscode from "vscode";
import { driverSupportsSqlExecution } from "../drivers/registry";
import { DataSourceProvider } from "../database_provider";
import { Datasource } from "../entity/datasource";

/**
 * 数据库管理器 - 管理当前选择的数据库连接和数据库
 * 替代原来的 CaEditor，只保留数据库选择功能
 */
export class DatabaseManager {
  private currentDatabase: Datasource | null = null;
  private currentConnection: Datasource | null = null;
  public provider: DataSourceProvider;

  private _onDidChangeDatabase = new vscode.EventEmitter<void>();
  public readonly onDidChangeDatabase = this._onDidChangeDatabase.event;

  constructor(provider: DataSourceProvider) {
    this.provider = provider;
  }

  /**
   * 通知数据库选择已变化
   */
  private notifyDatabaseChanged(): void {
    this._onDidChangeDatabase.fire();
  }

  /**
   * 显示数据库选择器（单次选择，格式：连接名称 / 数据库名称）
   */
  public async selectDatabase(): Promise<void> {
    const result = await this.selectConnectionAndDatabase();
    if (!result) {
      return;
    }
    this.currentConnection = result.connection;
    this.currentDatabase = result.database;
    this.notifyDatabaseChanged();
  }

  /**
   * 一次性展示所有连接下的数据库，格式：连接名称 / 数据库名称
   * @param lastTarget 可选，用于在列表顶部显示「使用上次选择」
   */
  public async selectConnectionAndDatabase(lastTarget?: {
    connectionName: string;
    databaseName: string;
  }): Promise<{ connection: Datasource; database: Datasource } | undefined> {
    const connections = this.provider
      .getConnections()
      .map((conn) => new Datasource(conn))
      .filter((c) => driverSupportsSqlExecution(c.data.dbType));

    if (connections.length === 0) {
      vscode.window.showWarningMessage("请先添加数据库连接");
      return undefined;
    }

    interface CombinedPickItem extends vscode.QuickPickItem {
      connection?: Datasource;
      database?: Datasource;
      isLastChoice?: boolean;
    }

    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "正在加载数据库列表...",
        cancellable: false,
      },
      async () => {
        // 并行展开所有连接，获取各自的数据库列表
        const results = await Promise.all(
          connections.map(async (conn) => {
            try {
              const objects = await conn.expand(this.provider.context);
              const typeNode = objects.find((o) => o.type === "datasourceType");
              if (!typeNode) {
                return { conn, dbs: [] as Datasource[] };
              }
              const dbs = await typeNode.expand(this.provider.context);
              return { conn, dbs };
            } catch {
              return { conn, dbs: [] as Datasource[] };
            }
          }),
        );

        const items: CombinedPickItem[] = [];

        // 「使用上次选择」置顶
        if (lastTarget?.connectionName && lastTarget?.databaseName) {
          const hit = results.find(
            (r) =>
              String(r.conn.data?.name ?? r.conn.label ?? "").trim() ===
                lastTarget.connectionName &&
              r.dbs.some(
                (d) => String(d.label ?? "") === lastTarget.databaseName,
              ),
          );
          if (hit) {
            items.push({
              label: "$(history) 使用上次选择",
              description: `${lastTarget.connectionName} / ${lastTarget.databaseName}`,
              detail: "直接沿用上次选择的连接与数据库",
              isLastChoice: true,
            });
          }
        }

        for (const { conn, dbs } of results) {
          const connLabel = String(conn.label ?? "");
          const d = conn.data;
          const connInfo = [
            d.dbType ?? "",
            d.host ? (d.port ? `${d.host}:${d.port}` : d.host) : "",
            d.username ?? "",
          ]
            .filter(Boolean)
            .join("  ·  ");
          for (const db of dbs) {
            const dbLabel = String(db.label ?? "");
            items.push({
              label: `$(database) ${connLabel} / ${dbLabel}`,
              description:
                connInfo ||
                (typeof conn.tooltip === "string" ? conn.tooltip : ""),
              connection: conn,
              database: db,
            });
          }
        }

        if (items.length === 0) {
          vscode.window.showWarningMessage("暂无可用数据库");
          return undefined;
        }

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: "选择数据库（连接名称 / 数据库名称）",
          matchOnDescription: true,
        });

        if (!selected) {
          return undefined;
        }

        if (selected.isLastChoice && lastTarget) {
          const hit = results.find(
            (r) =>
              String(r.conn.data?.name ?? r.conn.label ?? "").trim() ===
              lastTarget.connectionName,
          );
          if (!hit) {
            return undefined;
          }
          const db = hit.dbs.find(
            (d) => String(d.label ?? "") === lastTarget.databaseName,
          );
          if (!db) {
            return undefined;
          }
          return { connection: hit.conn, database: db };
        }

        if (!selected.connection || !selected.database) {
          return undefined;
        }
        return { connection: selected.connection, database: selected.database };
      },
    );
  }

  /**
   * 选择连接（保留兼容性，新代码请使用 selectConnectionAndDatabase）
   */
  public async selectConnection(
    docType: string = "sql",
  ): Promise<Datasource | undefined> {
    const connections = this.provider
      .getConnections()
      .map((conn) => new Datasource(conn));

    if (connections.length === 0) {
      vscode.window.showWarningMessage("请先添加数据库连接");
      return undefined;
    }

    interface ConnectionQuickPickItem extends vscode.QuickPickItem {
      datasource: Datasource;
    }
    const connectionItems: ConnectionQuickPickItem[] = connections
      .filter((e) => {
        if (docType === "sql") {
          return driverSupportsSqlExecution(e.data.dbType);
        }
        return false;
      })
      .map((conn) => ({
        label: `$(plug) ${conn.label}`,
        description: typeof conn.tooltip === "string" ? conn.tooltip : "",
        datasource: conn,
      }));

    const selected = await vscode.window.showQuickPick(connectionItems, {
      placeHolder: "选择数据库连接",
      matchOnDescription: true,
    });

    return selected?.datasource;
  }

  /**
   * 从指定连接中选择数据库（保留兼容性）
   */
  public async selectDatabaseFromConnection(
    connection: Datasource,
  ): Promise<Datasource | undefined> {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "正在获取数据库列表...",
        cancellable: false,
      },
      async () => {
        // 获取连接下的对象（包含 datasourceType, userType, fileType）
        const objects = await connection.expand(this.provider.context);

        // 找到 datasourceType 节点
        const datasourceTypeNode = objects.find(
          (obj) => obj.type === "datasourceType",
        );
        if (!datasourceTypeNode) {
          vscode.window.showWarningMessage("无法找到数据库列表节点");
          return undefined;
        }

        // 展开 datasourceType 节点获取所有数据库
        const databases = await datasourceTypeNode.expand(
          this.provider.context,
        );

        if (databases.length === 0) {
          vscode.window.showWarningMessage("该连接没有可用的数据库");
          return undefined;
        }

        interface DatabaseQuickPickItem extends vscode.QuickPickItem {
          datasource: Datasource;
        }

        const databaseItems: DatabaseQuickPickItem[] = databases.map(
          (db: Datasource) => ({
            label: `$(database) ${db.label}`,
            description:
              typeof db.description === "string" ? db.description : "",
            datasource: db,
          }),
        );

        const selected = await vscode.window.showQuickPick(databaseItems, {
          placeHolder: `选择 ${connection.label} 中的数据库`,
          matchOnDescription: true,
        });

        return selected?.datasource;
      },
    );
  }

  /**
   * 快速执行 SQL 等场景：选库列表首项可「使用上次选择」（仅当连接与上次记录的 connectionName 一致且该库仍在列表中）
   */
  public async selectDatabaseFromConnectionWithLastRecall(
    connection: Datasource,
    lastTarget: { connectionName: string; databaseName: string } | undefined,
  ): Promise<Datasource | undefined> {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "正在获取数据库列表...",
        cancellable: false,
      },
      async () => {
        const objects = await connection.expand(this.provider.context);

        const datasourceTypeNode = objects.find(
          (obj) => obj.type === "datasourceType",
        );
        if (!datasourceTypeNode) {
          vscode.window.showWarningMessage("无法找到数据库列表节点");
          return undefined;
        }

        const databases = await datasourceTypeNode.expand(
          this.provider.context,
        );

        if (databases.length === 0) {
          vscode.window.showWarningMessage("该连接没有可用的数据库");
          return undefined;
        }

        const connKey = String(
          connection.data?.name ?? connection.label ?? "",
        ).trim();

        const showLast =
          !!lastTarget &&
          lastTarget.connectionName === connKey &&
          databases.some(
            (d) => String(d.label ?? "") === lastTarget.databaseName,
          );

        interface DatabaseQuickPickItem extends vscode.QuickPickItem {
          datasource?: Datasource;
          isLastChoice?: boolean;
        }

        const databaseItems: DatabaseQuickPickItem[] = [];
        if (showLast) {
          databaseItems.push({
            label: "$(history) 使用上次选择",
            description: lastTarget!.databaseName,
            detail: "直接使用上次在该连接下选择的数据库",
            isLastChoice: true,
          });
        }
        for (const db of databases) {
          databaseItems.push({
            label: `$(database) ${db.label}`,
            description:
              typeof db.description === "string" ? db.description : "",
            datasource: db,
          });
        }

        const selected = await vscode.window.showQuickPick(databaseItems, {
          placeHolder: showLast
            ? `选择 ${connection.label} 中的数据库，或「使用上次选择」`
            : `选择 ${connection.label} 中的数据库`,
          matchOnDescription: true,
        });

        if (!selected) {
          return undefined;
        }
        if (selected.isLastChoice && lastTarget) {
          return databases.find(
            (d) => String(d.label ?? "") === lastTarget.databaseName,
          );
        }
        return selected.datasource;
      },
    );
  }

  /**
   * 获取当前选中的连接
   */
  public getCurrentConnection(): Datasource | null {
    return this.currentConnection;
  }

  /**
   * 获取当前选中的数据库
   */
  public getCurrentDatabase(): Datasource | null {
    return this.currentDatabase;
  }

  /**
   * 直接设置当前数据库（从 TreeView 中选择）
   * @param database - 数据库 Datasource 对象（type: collection）
   * @param silent - 是否静默设置（不显示成功消息）
   */
  public setCurrentDatabase(
    database: Datasource,
    silent: boolean = false,
  ): void {
    // 查找数据库的连接节点
    // 结构可能为: datasource -> datasourceType -> collection
    let connectionNode: Datasource | undefined = undefined;

    let current = database.parent;
    while (current) {
      if (current.type === "datasource") {
        connectionNode = current;
        break;
      }
      current = current.parent;
    }

    if (!connectionNode) {
      vscode.window.showErrorMessage("无法确定数据库所属的连接");
      return;
    }

    // 设置连接和数据库
    this.currentConnection = connectionNode;
    this.currentDatabase = database;

    // 通知更新
    this.notifyDatabaseChanged();

    // 显示成功消息
    if (!silent) {
      vscode.window.showInformationMessage(
        `已切换到数据库: ${this.currentConnection.label} / ${this.currentDatabase.label}`,
      );
    }
  }

  /**
   * 根据名称设置当前数据库（用于从缓存或文件恢复状态）
   */
  public async setActiveDatabase(
    connectionName: string,
    databaseName: string,
  ): Promise<boolean> {
    const connections = this.provider
      .getConnections()
      .map((conn) => new Datasource(conn));
    const connection = connections.find(
      (c) => c.label === connectionName || c.data.name === connectionName,
    );

    if (!connection) {
      return false;
    }

    // 设置当前连接
    this.currentConnection = connection;

    // 构造一个临时的数据库节点对象
    // 注意：这个对象可能不包含完整的信息，仅用于显示和记录状态
    const dbNode = new Datasource({
      type: "collection",
      name: databaseName,
      tooltip: databaseName,
    });
    dbNode.label = databaseName;

    // 构建层级关系，以便 getCurrentConnection 能正常工作（虽然我们直接设置了 currentConnection）
    const typeNode = new Datasource({
      type: "datasourceType",
      name: "Databases",
      tooltip: "Databases",
    });
    typeNode.parent = connection;
    dbNode.parent = typeNode;

    this.currentDatabase = dbNode;
    this.notifyDatabaseChanged();

    return true;
  }
}
