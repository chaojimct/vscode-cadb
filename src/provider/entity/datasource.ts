import * as vscode from "vscode";
import path from "path";
import {
  Dataloader,
  FormResult,
  PromiseResult,
  TableResult,
} from "./dataloader";
import { MySQLDataloader } from "./mysql_dataloader";
import type { DatabaseManager } from "../component/database_manager";
import { RedisDataloader } from "./redis_dataloader";

const iconDir: string[] = ["..", "..", "resources", "icons"];

export interface DatasourceInputData {
  type:
    | "datasourceType" // 数据源
    | "datasource"
    | "collectionType" // 数据库
    | "collection"
    | "documentType"
    | "document" // 表
    | "fieldType"
    | "field" // 字段
    | "indexType"
    | "index" // 索引
    | "userType"
    | "user" // 用户
    | "fileType"
    | "file" // 文件
    | "item" // 通用项
    | "folder"; // 文件夹

  name: string;
  tooltip: string;
  extra?: string;

  dbType?: "mysql" | "redis";
  database?: string;
  username?: string;
  password?: string;
  host?: string;
  port?: number;
}

export class Datasource extends vscode.TreeItem {
  public data: DatasourceInputData;
  public children: Datasource[] = [];
  public parent?: Datasource;
  public type: string;
  public dataloader?: Dataloader;

  public connect(): Promise<void> {
    if (!this.dataloader) {
      return Promise.resolve();
    }
    return this.dataloader?.connect();
  }

  public test(): Promise<PromiseResult> {
    if (!this.dataloader) {
      return Promise.resolve({
        success: false,
        message: "未知错误导致连接失败",
      });
    }
    return this.dataloader.test();
  }

  public edit = (): Promise<FormResult | undefined> => {
    if (!this.dataloader) {
      return Promise.resolve(undefined);
    }
    switch (this.type) {
      case "user":
        return this.dataloader.descUser(this);
      case "datasource":
        return this.dataloader.descDatasource(this);
      case "collection":
        return this.dataloader.descDatabase(this);
      case "document":
        return this.dataloader.descTable(this);
      default:
        return Promise.resolve(undefined);
    }
  };

  public create = async (
    context: vscode.ExtensionContext,
    databaseManager?: DatabaseManager
  ): Promise<void> => {
    switch (this.type) {
      case "datasourceType":
        // TODO: 创建数据库
        break;
      case "fileType":
        if (!this.parent || !this.parent.label) {
          return Promise.resolve();
        }
        const dsPath = vscode.Uri.joinPath(
          context.globalStorageUri,
          this.parent.label.toString()
        );

        // 创建新的 .jsql 文件（SQL Notebook）
        const dayjs = require("dayjs");
        const filename = dayjs().format("YYYYMMDDHHmmss") + ".jsql";
        const fileUri = vscode.Uri.joinPath(dsPath, filename);

        // 查找当前数据库和数据源信息
        let datasourceName: string | null = null;
        let databaseName: string | null = null;

        // 向上查找连接和数据库节点
        let current: Datasource | undefined = this.parent;
        while (current) {
          if (current.type === "collection") {
            databaseName = current.label?.toString() || null;
          }
          if (current.type === "datasource") {
            datasourceName = current.label?.toString() || null;
          }
          current = current.parent;
        }

        // 创建空的 notebook 内容，包含数据库连接信息
        const emptyNotebook = {
          datasource: datasourceName,
          database: databaseName,
          cells: [],
        };
        const content = JSON.stringify(emptyNotebook, null, 2);

        // 写入文件
        await vscode.workspace.fs.writeFile(
          fileUri,
          Buffer.from(content, "utf-8")
        );

        // 打开文件作为 Notebook
        const notebookDocument = await vscode.workspace.openNotebookDocument(
          fileUri
        );
        await vscode.window.showNotebookDocument(notebookDocument);

        // 如果有 databaseManager，自动设置数据库
        if (databaseManager && databaseName) {
          // 查找当前数据库节点
          let dbNode: Datasource | undefined = this.parent;
          while (dbNode) {
            if (dbNode.type === "collection" && dbNode.label === databaseName) {
              databaseManager.setCurrentDatabase(dbNode, true);
              break;
            }
            dbNode = dbNode.parent;
          }
        }

        // 刷新文件列表
        this.dataloader?.listFiles(this, dsPath);
        break;
    }
  };

  public expand = (context: vscode.ExtensionContext): Promise<Datasource[]> => {
    if (!this.dataloader) {
      return Promise.resolve([]);
    }
    switch (this.type) {
      case "datasourceType":
        return this.dataloader.listDatabases(this);
      case "collectionType":
        return this.dataloader.listTables(this);
      case "fieldType":
        return this.dataloader.listColumns(this);
      case "indexType":
        return this.dataloader.listIndexes(this);
      case "userType":
        return this.dataloader.listUsers(this);
      case "fileType":
        if (!this.parent || !this.parent.label) {
          return Promise.resolve([]);
        }
        return this.dataloader.listFiles(
          this,
          vscode.Uri.joinPath(
            context.globalStorageUri,
            this.parent.label.toString()
          )
        );
      case "collection":
      case "datasource":
      case "document":
      case "user":
        return this.dataloader.listObjects(this, this.type);
      case "folder":
        return this.dataloader.listFolders(this);
      default:
        return Promise.resolve([]);
    }
  };

  public listData(): Promise<TableResult | null> {
    if (!this.dataloader) {
      return Promise.resolve(null);
    }
    return this.dataloader.listData(this);
  }

  public constructor(
    input: DatasourceInputData,
    dataloader?: Dataloader,
    parent?: Datasource
  ) {
    super(input.name);
    this.data = input;
    this.dataloader = dataloader;
    this.parent = parent;
    this.type = this.contextValue = input.type;
    this.tooltip = input.tooltip;
    // 设置节点的可折叠状态：如果是 datasource（可展开以列出数据库），则设置为 Collapsed
    if (
      input.type === "field" ||
      input.type === "index" ||
      input.type === "user" ||
      input.type === "file" ||
      input.type === "item"
    ) {
      this.collapsibleState = vscode.TreeItemCollapsibleState.None;
    } else {
      this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    }
    switch (input.type) {
      case "item":
        this.initItem(input);
        break;
      case "folder":
        this.initFolder(input);
        break;
      case "datasource":
      case "datasourceType":
        this.initDatasource(input);
        break;
      case "document":
        this.initDocument(input);
        break;
      case "collection":
      case "collectionType":
        this.initCollectionType(input);
        break;
      case "user":
      case "userType":
        this.initUserType(input);
        break;
      case "field":
      case "fieldType":
        this.initFieldType(input);
        break;
      case "index":
      case "indexType":
        this.initIndexType(input);
        break;
      case "file":
      case "fileType":
        this.initFileType(input);
        break;
    }
  }

  private initFileType(input: DatasourceInputData): void {
    if (input.type === "file") {
      this.description = input.extra;
      // 为文件类型添加点击命令，打开 SQL 编辑器
      this.command = {
        title: "打开 SQL 文件",
        command: "cadb.file.open",
        arguments: [this],
      };
      this.iconPath = {
        light: vscode.Uri.file(
          path.join(__filename, ...iconDir, "SQL_light.svg")
        ),
        dark: vscode.Uri.file(
          path.join(__filename, ...iconDir, "SQL_dark.svg")
        ),
      };
    } else {
      this.iconPath = {
        light: vscode.Uri.file(
          path.join(__filename, ...iconDir, "Folder_light.svg")
        ),
        dark: vscode.Uri.file(
          path.join(__filename, ...iconDir, "Folder_dark.svg")
        ),
      };
    }
  }

  private initIndexType(input: DatasourceInputData): void {
    if (input.type === "index") {
      this.description = input.extra;
    }
    this.iconPath = {
      light: vscode.Uri.file(
        path.join(__filename, ...iconDir, "Index_light.svg")
      ),
      dark: vscode.Uri.file(
        path.join(__filename, ...iconDir, "Index_dark.svg")
      ),
    };
  }

  private initFieldType(input: DatasourceInputData): void {
    if (input.type === "field") {
      this.description = input.extra;
    }
    this.iconPath = {
      light: vscode.Uri.file(
        path.join(__filename, ...iconDir, "Column_light.svg")
      ),
      dark: vscode.Uri.file(
        path.join(__filename, ...iconDir, "Column_dark.svg")
      ),
    };
  }

  private initDocument(input: DatasourceInputData): void {
    this.description = `${input.extra}`;
    this.iconPath = {
      light: vscode.Uri.file(
        path.join(__filename, ...iconDir, "Table_light.svg")
      ),
      dark: vscode.Uri.file(
        path.join(__filename, ...iconDir, "Table_dark.svg")
      ),
    };
    this.command = {
      title: "查看数据",
      command: "cadb.item.showData",
      arguments: [this],
    };
  }

  private initCollectionType(input: DatasourceInputData): void {
    if (input.type === "collection") {
      this.description = `${input.extra}`;
    }
    this.iconPath = {
      light: vscode.Uri.file(
        path.join(__filename, ...iconDir, "Database_light.svg")
      ),
      dark: vscode.Uri.file(
        path.join(__filename, ...iconDir, "Database_dark.svg")
      ),
    };
  }

  private initUserType(input: DatasourceInputData): void {
    if (input.type === "user") {
      this.description = `${input.extra}`;
      this.iconPath = {
        light: vscode.Uri.file(
          path.join(__filename, ...iconDir, "User_light.svg")
        ),
        dark: vscode.Uri.file(
          path.join(__filename, ...iconDir, "User_dark.svg")
        ),
      };
    } else {
      this.iconPath = {
        light: vscode.Uri.file(
          path.join(__filename, ...iconDir, "Folder_light.svg")
        ),
        dark: vscode.Uri.file(
          path.join(__filename, ...iconDir, "Folder_dark.svg")
        ),
      };
    }
  }

  private initItem(input: DatasourceInputData): void {
    this.iconPath = {
      light: vscode.Uri.file(
        path.join(__filename, ...iconDir, "Item_light.svg")
      ),
      dark: vscode.Uri.file(path.join(__filename, ...iconDir, "Item_dark.svg")),
    };
  }

  private initFolder(input: DatasourceInputData): void {
    this.iconPath = {
      light: vscode.Uri.file(
        path.join(__filename, ...iconDir, "Folder_light.svg")
      ),
      dark: vscode.Uri.file(
        path.join(__filename, ...iconDir, "Folder_dark.svg")
      ),
    };
  }

  private initDatasource(input: DatasourceInputData): void {
    if (input.type === "datasource") {
      this.description = `${input.host}:${input.port}`;
      switch (input.dbType) {
        case "mysql":
          this.iconPath = {
            light: vscode.Uri.file(
              path.join(__filename, ...iconDir, "mysql", "MySQL_light.svg")
            ),
            dark: vscode.Uri.file(
              path.join(__filename, ...iconDir, "mysql", "MySQL_dark.svg")
            ),
          };
          this.dataloader = new MySQLDataloader(this, input);
          break;
        case "redis":
          this.iconPath = {
            light: vscode.Uri.file(
              path.join(__filename, ...iconDir, "redis", "Redis_light.svg")
            ),
            dark: vscode.Uri.file(
              path.join(__filename, ...iconDir, "redis", "Redis_dark.svg")
            ),
          };
          this.dataloader = new RedisDataloader(this, input);
          break;
      }
    } else {
      this.iconPath = {
        light: vscode.Uri.file(
          path.join(__filename, ...iconDir, "Folder_light.svg")
        ),
        dark: vscode.Uri.file(
          path.join(__filename, ...iconDir, "Folder_dark.svg")
        ),
      };
    }
  }

  public static createInstance(
    model: DatasourceInputData[],
    context: vscode.ExtensionContext,
    input: DatasourceInputData,
    save: boolean = false
  ): Promise<Datasource> {
    return new Promise<Datasource>((resolve) => {
      const instance = new Datasource(input);
      if (save) {
        model.push(input);
        context.globalState
          .update("cadb.connections", model)
          .then(() => resolve(instance));
      }
      return resolve(instance);
    });
  }
}
