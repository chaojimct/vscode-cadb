import { createClient, RedisClientType } from "redis";
import { Uri } from "vscode";
import {
  ColDef,
  Dataloader,
  FormResult,
  PromiseResult,
  SaveDataParams,
  SaveResult,
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
  rootNode(): Datasource {
    return this.ds;
  }
  dbType(): string {
    return this.ds.data.dbType || "redis";
  }
  listCollations(ds: Datasource): Promise<Datasource[]> {
    return Promise.resolve([]);
  }
  createDatabase(params: any): Promise<void> {
    return Promise.reject(new Error("Method not implemented."));
  }

  private async scanValues(
    ds: Datasource,
    type: string
  ): Promise<Datasource[]> {
    const result: Datasource[] = [];
    if (ds.parent && ds.parent.label) {
      await this.client.select(
        parseInt(ds.parent.label.toString().substring(2))
      );
    }
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
    return Promise.resolve([]);
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
  async listDatabases(ds: Datasource): Promise<Datasource[]> {
    const databases = await this.client.configGet("databases");
    const databasesNum = parseInt(databases["databases"]);
    for (let i = 0; i < databasesNum; i++) {
      ds.children.push(
        new Datasource(
          {
            type: "collection",
            extra: "",
            name: `DB${i}`,
            tooltip: `数据库${i}`,
          },
          this,
          ds
        )
      );
    }
    return Promise.resolve(ds.children);
  }
  async listObjects(ds: Datasource, type: string): Promise<Datasource[]> {
    if (!this.client.isOpen) {
      await this.client.connect();
    }
    ds.children = [];
    switch (type) {
      case "datasource":
        ds.children = [
          new Datasource(
            {
              name: "数据库",
              extra: "DBs",
              tooltip: "",
              type: "datasourceType",
            },
            this,
            ds
          ),
        ];
        break;
      case "collection":
        ds.children = [
          new Datasource(
            {
              type: "collectionType",
              name: "字符串",
              extra: "string",
              tooltip: "String",
            },
            this,
            ds
          ),
          new Datasource(
            {
              type: "collectionType",
              name: "列表",
              extra: "list",
              tooltip: "List",
            },
            this,
            ds
          ),
          new Datasource(
            {
              type: "collectionType",
              name: "集合",
              extra: "set",
              tooltip: "Set",
            },
            this,
            ds
          ),
          new Datasource(
            {
              type: "collectionType",
              name: "有序集合",
              extra: "zset",
              tooltip: "Sorted Set",
            },
            this,
            ds
          ),
          new Datasource(
            {
              type: "collectionType",
              name: "哈希表",
              extra: "hash",
              tooltip: "Hash",
            },
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
  async listTables(ds: Datasource): Promise<Datasource[]> {
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
  async listData(ds: Datasource): Promise<TableResult> {
    const startTime = Date.now();

    if (!this.client.isOpen) {
      await this.client.connect();
    }

    const key = ds.label?.toString() || "";
    const typeLabel = ds.parent?.tooltip?.toString() || "";
    const dbNode = ds.parent?.parent;

    if (dbNode?.label) {
      const dbLabel = dbNode.label.toString();
      const match = dbLabel.match(/^DB(\d+)$/i);
      if (match) {
        await this.client.select(parseInt(match[1], 10));
      }
    }

    let columnDefs: ColDef[] = [];
    let rowData: Record<string, any>[] = [];
    let title = key;

    const valueColDef = {
      field: "value",
      cellEditor: "agLargeTextCellEditor",
      cellEditorPopup: true,
    };
    const fieldsColDef = {
      field: "fields",
      cellEditor: "agLargeTextCellEditor",
      cellEditorPopup: true,
    };

    if (/^string$/i.test(typeLabel)) {
      const value = await this.client.get(key);
      columnDefs = [{ field: "key" }, valueColDef];
      rowData = [{ key, value: value ?? "" }];
      title = `String: ${key}`;
    } else if (/^List$/i.test(typeLabel)) {
      const values: string[] = await this.client.lRange(key, 0, -1);
      columnDefs = [{ field: "index" }, valueColDef];
      rowData = values.map((v, i) => ({ index: i, value: v }));
      title = `List: ${key}`;
    } else if (/^Set$/i.test(typeLabel)) {
      const values: string[] = await this.client.sMembers(key);
      columnDefs = [valueColDef];
      rowData = values.map((v) => ({ value: v }));
      title = `Set: ${key}`;
    } else if (/^Sorted Set$/i.test(typeLabel) || /^zset$/i.test(typeLabel)) {
      let entries: Array<{ value: string; score: number }> = [];
      try {
        const arr = (await this.client.sendCommand([
          "ZRANGE",
          key,
          "0",
          "-1",
          "WITHSCORES",
        ])) as string[];
        for (let i = 0; i < arr.length; i += 2) {
          entries.push({ value: arr[i], score: Number(arr[i + 1]) });
        }
      } catch {
        entries = [];
      }
      columnDefs = [{ field: "score" }, valueColDef];
      rowData = entries.map((e) => ({ score: e.score, value: e.value }));
      title = `ZSet: ${key}`;
    } else if (/^Hash$/i.test(typeLabel) || /^hash$/i.test(typeLabel)) {
      const obj = await this.client.hGetAll(key);
      columnDefs = [{ field: "field", editable: false }, valueColDef];
      rowData = Object.entries(obj).map(([f, v]) => ({ field: f, value: v ?? "" }));
      title = `Hash: ${key}`;
    } else if (/^Stream$/i.test(typeLabel) || /^stream$/i.test(typeLabel)) {
      const streamData = await this.client.xRange(key, "-", "+");
      columnDefs = [{ field: "id" }, fieldsColDef];
      rowData = streamData.map((e) => ({
        id: e.id,
        fields: JSON.stringify(e.message),
      }));
      title = `Stream: ${key}`;
    } else {
      return {
        title: key,
        columnDefs: [{ field: "key", editable: false }, valueColDef],
        rowData: [],
        queryTime: (Date.now() - startTime) / 1000,
      };
    }

    const queryTime = (Date.now() - startTime) / 1000;

    return {
      title,
      columnDefs,
      rowData,
      queryTime,
    };
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

  /**
   * 保存表格数据（Redis 不支持表结构更新）
   */
  async saveData(params: SaveDataParams): Promise<SaveResult> {
    throw new Error("Redis 请使用 saveKeyData 保存键值数据");
  }

  /**
   * 保存当前 key 的编辑结果（String/List/Set/ZSet/Hash）
   */
  async saveKeyData(params: {
    key: string;
    dbIndex: number;
    keyType: string;
    changes: Array<{ original: Record<string, any>; full: Record<string, any> }>;
  }): Promise<SaveResult> {
    const { key, dbIndex, keyType, changes } = params;
    if (!this.client.isOpen) await this.client.connect();
    await this.client.select(dbIndex);

    const typeLabel = keyType.toLowerCase();
    let successCount = 0;
    let errorCount = 0;
    const errors: string[] = [];

    try {
      if (/^string$/i.test(keyType)) {
        const row = changes[0]?.full;
        if (row?.value !== undefined) {
          await this.client.set(key, String(row.value));
          successCount = 1;
        }
      } else if (/^list$/i.test(keyType)) {
        for (const { original, full } of changes) {
          const idx = original?.index;
          const val = full?.value != null ? String(full.value) : "";
          if (typeof idx === "number") {
            await this.client.lSet(key, idx, val);
            successCount++;
          } else {
            await this.client.rPush(key, val);
            successCount++;
          }
        }
      } else if (/^set$/i.test(keyType)) {
        for (const { original, full } of changes) {
          const oldVal = original?.value != null ? String(original.value) : "";
          const newVal = full?.value != null ? String(full.value) : "";
          if (oldVal !== newVal) {
            if (oldVal) await this.client.sRem(key, oldVal);
            if (newVal) await this.client.sAdd(key, newVal);
            successCount++;
          }
        }
      } else if (/^sorted set$/i.test(keyType) || /^zset$/i.test(keyType)) {
        for (const { full } of changes) {
          const score = Number(full?.score);
          const value = full?.value != null ? String(full.value) : "";
          if (value === "" && !Number.isNaN(score)) continue;
          await this.client.zAdd(key, { score: Number.isNaN(score) ? 0 : score, value });
          successCount++;
        }
      } else if (/^hash$/i.test(keyType)) {
        for (const { full } of changes) {
          const field = full?.field != null ? String(full.field) : "";
          const value = full?.value != null ? String(full.value) : "";
          if (field) {
            await this.client.hSet(key, field, value);
            successCount++;
          }
        }
      } else if (/^stream$/i.test(keyType)) {
        for (const { original, full } of changes) {
          let id = original?.id ?? full?.id;
          if (id == null || id === "") id = "*";
          const fieldsStr = full?.fields;
          if (fieldsStr == null) continue;
          try {
            const obj = typeof fieldsStr === "string" ? JSON.parse(fieldsStr) : fieldsStr;
            if (typeof obj !== "object" || obj === null) continue;
            await this.client.xAdd(key, String(id), obj);
            successCount++;
          } catch (e) {
            errorCount++;
            errors.push(e instanceof Error ? e.message : String(e));
          }
        }
      } else {
        return { successCount: 0, errorCount: 1, errors: ["不支持的键类型: " + keyType] };
      }
    } catch (e) {
      errorCount++;
      errors.push(e instanceof Error ? e.message : String(e));
    }

    return { successCount, errorCount, errors };
  }

  /**
   * 复制连接用于 Pub/Sub（订阅需独立连接）
   */
  duplicateClient(): RedisClientType {
    return this.client.duplicate();
  }
}
