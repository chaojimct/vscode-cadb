import * as vscode from "vscode";
import path from "path";
import {
  Dataloader,
  FormResult,
  PromiseResult,
  TableResult,
} from "./dataloader";
import { MySQLDataloader } from "./mysql_dataloader";
import type { CaEditor } from "../component/editor";
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
    | "file"; // 文件

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
  public root?: Datasource;
  public parent?: Datasource;
  public type: string;
  public dataloder?: Dataloader;

  public connect(): Promise<void> {
    if (!this.dataloder) {
      return Promise.resolve();
    }
    return this.dataloder?.connect();
  }

  public test(): Promise<PromiseResult> {
    if (!this.dataloder) {
      return Promise.resolve({
        success: false,
        message: "未知错误导致连接失败",
      });
    }
    return this.dataloder.test();
  }

  public edit = (): Promise<FormResult | undefined> => {
    if (!this.dataloder) {
      return Promise.resolve(undefined);
    }
    switch (this.type) {
			case "user":
				return this.dataloder.descUser(this);
			case "datasource":
				return this.dataloder.descDatasource(this);
      case "document":
        return this.dataloder.descTable(this);
      default:
        return Promise.resolve(undefined);
    }
  };

  public create = async (
    context: vscode.ExtensionContext,
    editor?: CaEditor
  ): Promise<void> => {
    switch (this.type) {
      case "fileType":
        if (!this.parent || !this.parent.label) {
          return Promise.resolve();
        }
        const dsPath = vscode.Uri.joinPath(
          context.globalStorageUri,
          this.parent.label.toString()
        );
        if (editor) {
          await editor.open(dsPath);
        } else {
          // 如果没有传入 editor，创建临时文件
          const dayjs = require("dayjs");
          const filename = dayjs().format("YYYYMMDDHHmmss") + ".sql";
          const fileUri = vscode.Uri.joinPath(dsPath, filename);
          await vscode.workspace.fs.writeFile(
            fileUri,
            Buffer.from(`-- ${filename}\n`)
          );
          const doc = await vscode.workspace.openTextDocument(fileUri);
          await vscode.window.showTextDocument(doc, {
            preview: false,
            viewColumn: vscode.ViewColumn.Active,
          });
        }
        this.dataloder?.listFiles(this, dsPath);
        break;
    }
  };

  public expand = (context: vscode.ExtensionContext): Promise<Datasource[]> => {
    if (!this.dataloder) {
      return Promise.resolve([]);
    }
    switch (this.type) {
      case "datasourceType":
        return this.dataloder.listDatabases(this);
      case "collectionType":
        return this.dataloder.listTables(this);
      case "fieldType":
        return this.dataloder.listColumns(this);
      case "indexType":
        return this.dataloder.listIndexes(this);
      case "userType":
        return this.dataloder.listUsers(this);
      case "fileType":
        if (!this.parent || !this.parent.label) {
          return Promise.resolve([]);
        }
        return this.dataloder.listFiles(
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
        return this.dataloder.listObjects(this, this.type);
      default:
        return Promise.resolve([]);
    }
  };

  public listData(): Promise<TableResult | null> {
    if (!this.dataloder) {
      return Promise.resolve(null);
    }
    return this.dataloder.listData(this);
  }

  public constructor(
    input: DatasourceInputData,
    dataloader?: Dataloader,
    parent?: Datasource
  ) {
    super(input.name);
		this.data = input;
    this.dataloder = dataloader;
    this.parent = parent;
    this.type = this.contextValue = input.type;
    this.tooltip = input.tooltip;
    // 设置节点的可折叠状态：如果是 datasource（可展开以列出数据库），则设置为 Collapsed
    if (
      input.type === "field" ||
      input.type === "index" ||
      input.type === "user" ||
      input.type === "file"
    ) {
      this.collapsibleState = vscode.TreeItemCollapsibleState.None;
    } else {
      this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    }
    switch (input.type) {
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
    }
    this.iconPath = {
      light: vscode.Uri.file(
        path.join(__filename, ...iconDir, "SQL_light.svg")
      ),
      dark: vscode.Uri.file(path.join(__filename, ...iconDir, "SQL_dark.svg")),
    };
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
    }
    this.iconPath = {
      light: vscode.Uri.file(
        path.join(__filename, ...iconDir, "User_light.svg")
      ),
      dark: vscode.Uri.file(path.join(__filename, ...iconDir, "User_dark.svg")),
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
          this.dataloder = new MySQLDataloader(this, input);
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
          this.dataloder = new RedisDataloader(this, input);
					break;
      }
    } else {
      this.iconPath = {
        light: vscode.Uri.file(
          path.join(__filename, ...iconDir, "Database_light.svg")
        ),
        dark: vscode.Uri.file(
          path.join(__filename, ...iconDir, "Database_dark.svg")
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
