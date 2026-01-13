import { Uri } from "vscode";
import {
  Dataloader,
  FormResult,
  PromiseResult,
  SaveDataParams,
  SaveResult,
  TableResult,
} from "./dataloader";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Datasource, DatasourceInputData } from "./datasource";

export class OssDataLoader implements Dataloader {
  private ds: Datasource;
  private data: DatasourceInputData;
  private client: S3Client;

  constructor(ds: Datasource, input: DatasourceInputData) {
    this.ds = ds;
    this.data = input;

    this.client = new S3Client({
      region: input.region,
      endpoint: input.endpoint,
      credentials: {
        accessKeyId: input.accessKeyId || "",
        secretAccessKey: input.accessSecretKey || "",
      },
      forcePathStyle: false,
    });
  }

  rootNode(): Datasource {
    return this.ds;
  }
  dbType(): string {
    return this.ds.data.dbType || "oss";
  }
  async test(): Promise<PromiseResult> {
    try {
      const res = await this.client.send(
        new HeadBucketCommand({ Bucket: this.data.bucket })
      );
      console.log(res);
      return { success: true, message: "Connection successful" };
    } catch (error: any) {
      let message = error.message || "Connection failed";
      return { success: false, message };
    }
  }
  connect(): Promise<void> {
    throw new Error("Method not implemented.");
  }
  getConnection() {
    throw new Error("Method not implemented.");
  }
  listCollations(ds: Datasource): Promise<Datasource[]> {
    throw new Error("Method not implemented.");
  }
  createDatabase(params: any): Promise<void> {
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
    if (type === "datasource") {
      ds.children = [
        new Datasource(
          {
            type: "datasourceType",
            name: "桶文件",
            tooltip: "",
            extra: "bucket",
          },
          this,
          ds
        ),
      ];
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
  listFolders(ds: Datasource): Promise<Datasource[]> {
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
    throw new Error("Method not implemented.");
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
  saveData(params: SaveDataParams): Promise<SaveResult> {
    throw new Error("Method not implemented.");
  }
}
