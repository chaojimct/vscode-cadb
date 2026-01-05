import {
  createClient,
  RedisArgument,
  RedisClientType,
  RedisFunctions,
  RedisModules,
  RedisScripts,
} from "redis";
import { Uri } from "vscode";
import {
  Dataloader,
  FormResult,
  PromiseResult,
  TableResult,
} from "./dataloader";
import { Datasource, DatasourceInputData } from "./datasource";

export class RedisDataloader implements Dataloader {
  client: RedisClientType;
  ds: Datasource;
  constructor(ds: Datasource, input: DatasourceInputData) {
    this.ds = ds;
    // 使用类型断言来解决类型不匹配问题
    this.client = createClient({
      socket: {
        host: input.host,
        port: input.port,
      },
      password: input.password,
    });
  }

  private async scanValues(
    ds: Datasource,
    type: string
  ): Promise<Datasource[]> {
    const result: Datasource[] = [];
    // 其他情况
    for await (const keys of this.client.scanIterator({
      TYPE: type,
      MATCH: "*",
      COUNT: 1000,
    })) {
      for (const key of keys) {
        result.push(
          new Datasource(
            { type: "item", name: key.toString(), tooltip: key.toString() },
            this,
            ds
          )
        );
      }
    }
    return result;
  }
  async listFolders(ds: Datasource): Promise<Datasource[]> {
    if (!this.client.isOpen) {
      await this.client.connect();
    }
    if (ds.tooltip === "String") {
      ds.children = await this.scanValues(ds, "string");
    } else if (ds.tooltip === "List") {
      ds.children = await this.scanValues(ds, "list");
    } else if (ds.tooltip === "Set") {
      ds.children = await this.scanValues(ds, "set");
    } else if (ds.tooltip === "Sorted Set") {
      ds.children = await this.scanValues(ds, "zset");
    } else if (ds.tooltip === "Hash") {
      ds.children = await this.scanValues(ds, "hash");
    } else if (ds.tooltip === "Stream") {
      ds.children = await this.scanValues(ds, "stream");
    }
    return Promise.resolve(ds.children);
  }
  async test(): Promise<PromiseResult> {
    try {
      // 确保客户端已连接
      if (!this.client.isOpen) {
        await this.client.connect();
      }
      const result = await this.client.ping();
      return {
        success: result === "PONG",
        message: result === "PONG" ? "连接成功" : result,
      };
    } catch (error: any) {
      return {
        success: false,
        message: error.message || "连接失败",
      };
    }
  }
  connect(): Promise<void> {
    throw new Error("Method not implemented.");
  }
  getConnection() {
    throw new Error("Method not implemented.");
  }
  listFiles(ds: Datasource, path: Uri): Promise<Datasource[]> {
    throw new Error("Method not implemented.");
  }
  listUsers(ds: Datasource): Promise<Datasource[]> {
    throw new Error("Method not implemented.");
  }
  listAllUsers(ds: Datasource): Promise<Datasource[]> {
    throw new Error("Method not implemented.");
  }
  listDatabases(ds: Datasource): Promise<Datasource[]> {
    throw new Error("Method not implemented.");
  }
  listObjects(ds: Datasource, type: string): Promise<Datasource[]> {
    ds.children = [];
    switch (type) {
      case "datasource":
        ds.children = [
          new Datasource(
            { type: "folder", name: "字符串", tooltip: "String" },
            this,
            ds
          ),
          new Datasource(
            { type: "folder", name: "列表", tooltip: "List" },
            this,
            ds
          ),
          new Datasource(
            { type: "folder", name: "集合", tooltip: "Set" },
            this,
            ds
          ),
          new Datasource(
            { type: "folder", name: "有序集合", tooltip: "Sorted Set" },
            this,
            ds
          ),
          new Datasource(
            { type: "folder", name: "哈希表", tooltip: "Hash" },
            this,
            ds
          ),
        ];
        break;
    }
    return Promise.resolve(ds.children);
  }
  listIndexes(ds: Datasource): Promise<Datasource[]> {
    throw new Error("Method not implemented.");
  }
  listColumns(ds: Datasource): Promise<Datasource[]> {
    throw new Error("Method not implemented.");
  }
  listTables(ds: Datasource): Promise<Datasource[]> {
    throw new Error("Method not implemented.");
  }
  listData(
    ds: Datasource,
    page?: number,
    pageSize?: number
  ): Promise<TableResult> {
    throw new Error("Method not implemented.");
  }
  descDatasource(ds: Datasource): Promise<FormResult | undefined> {
    return Promise.resolve({
      rowData: [ds.data],
    });
  }
  descUser(ds: Datasource): Promise<FormResult | undefined> {
    throw new Error("Method not implemented.");
  }
  descDatabase(ds: Datasource): Promise<FormResult | undefined> {
    throw new Error("Method not implemented.");
  }
  descTable(ds: Datasource): Promise<FormResult | undefined> {
    throw new Error("Method not implemented.");
  }
  descColumn(ds: Datasource): Promise<FormResult | undefined> {
    throw new Error("Method not implemented.");
  }
  descIndex(ds: Datasource): Promise<FormResult | undefined> {
    throw new Error("Method not implemented.");
  }
  descStructure(): string[] {
    throw new Error("Method not implemented.");
  }
}
