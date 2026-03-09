import { Uri } from "vscode";
import {
  Dataloader,
  FormResult,
  PromiseResult,
  SaveDataParams,
  SaveResult,
  TableResult,
} from "./dataloader";
import { HeadBucketCommand, ListBucketsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { Datasource, DatasourceInputData } from "./datasource";

/** 将字节数格式化为 KB、MB、GB 等易读字符串 */
function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const unit = units[Math.min(i, units.length - 1)];
  const value = bytes / Math.pow(1024, Math.min(i, units.length - 1));
  return value % 1 === 0 ? `${value} ${unit}` : `${value.toFixed(2)} ${unit}`;
}

/** 路径树节点：文件夹或文件 */
type OssPathFolder = { kind: "folder"; name: string; children: OssPathNode[] };
type OssPathFile = { kind: "file"; name: string; size: number; lastModified?: Date };
type OssPathNode = OssPathFolder | OssPathFile;

function getOrCreateFolder(parent: OssPathFolder, segment: string): OssPathFolder {
  const found = parent.children.find(
    (c): c is OssPathFolder => c.kind === "folder" && c.name === segment
  );
  if (found) return found;
  const folder: OssPathFolder = { kind: "folder", name: segment, children: [] };
  parent.children.push(folder);
  return folder;
}

function addFile(
  parent: OssPathFolder,
  segment: string,
  size: number,
  lastModified?: Date
): void {
  const existing = parent.children.find(
    (c): c is OssPathFile => c.kind === "file" && c.name === segment
  );
  if (existing) {
    existing.size = size;
    existing.lastModified = lastModified;
    return;
  }
  parent.children.push({ kind: "file", name: segment, size, lastModified });
}

/** 将路径树转换为 Datasource 树（递归） */
function ossPathNodesToDatasource(
  nodes: OssPathNode[],
  parentDs: Datasource,
  loader: OssDataLoader
): Datasource[] {
  return nodes.map((node) => {
    if (node.kind === "folder") {
      const ds = new Datasource(
        {
          name: node.name,
          type: "folder",
          tooltip: "",
          extra: "",
        },
        loader,
        parentDs
      );
      ds.children = ossPathNodesToDatasource(node.children, ds, loader);
      return ds;
    }
    const ds = new Datasource(
      {
        name: node.name,
        type: "item",
        tooltip: node.lastModified
          ? `${formatFileSize(node.size)} · ${node.lastModified.toISOString()}`
          : formatFileSize(node.size),
        extra: formatFileSize(node.size),
      },
      loader,
      parentDs
    );
    return ds;
  });
}

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
      await this.client.send(
        new HeadBucketCommand({ Bucket: this.data.bucket })
      );
      return { success: true, message: "Connection successful" };
    } catch (error: any) {
      let message = error.message || "Connection failed";
      return { success: false, message };
    }
  }
  connect(): Promise<void> {
    throw new Error("connect Method not implemented.");
  }
  getConnection() {
    throw new Error("getConnection Method not implemented.");
  }
  listCollations(ds: Datasource): Promise<Datasource[]> {
    throw new Error("listCollations Method not implemented.");
  }
  createDatabase(params: any): Promise<void> {
    throw new Error("createDatabase Method not implemented.");
  }
  listFiles(ds: Datasource, path: Uri): Promise<Datasource[]> {
    throw new Error("listFiles Method not implemented.");
  }
  listUsers(ds: Datasource): Promise<Datasource[]> {
    throw new Error("listUsers Method not implemented.");
  }
  listAllUsers(ds: Datasource): Promise<Datasource[]> {
    throw new Error("listAllUsers Method not implemented.");
  }
  listDatabases(ds: Datasource): Promise<Datasource[]> {
    throw new Error("listDatabases Method not implemented.");
  }
  async listObjects(ds: Datasource, type: string): Promise<Datasource[]> {
    try {
      const buckets = await this.client.send(new ListBucketsCommand({ 
        BucketRegion: this.data.region,
       }));
       ds.children = buckets.Buckets?.map((bucket) => new Datasource({
        name: bucket.Name || "",
        type: "collectionType",
        tooltip: "",
        extra: "bucket",
      }, this, ds)) || [];
    } catch (error: any) {
      return [];
    }
    return Promise.resolve(ds.children);
  }
  listIndexes(ds: Datasource): Promise<Datasource[]> {
    throw new Error("listIndexes Method not implemented.");
  }
  listColumns(ds: Datasource): Promise<Datasource[]> {
    throw new Error("listColumns Method not implemented.");
  }
  /**
   * 列出该 bucket 下所有文件（分页拉取全部对象）
   */
  async listTables(ds: Datasource): Promise<Datasource[]> {
    const bucketName =
      (ds.data as { bucket?: string })?.bucket ??
      ds.label?.toString() ??
      this.data.bucket;
    if (!bucketName) {
      return [];
    }
    const allContents: { Key?: string; Size?: number; LastModified?: Date }[] = [];
    let continuationToken: string | undefined;
    try {
      do {
        const result = await this.client.send(
          new ListObjectsV2Command({
            Bucket: bucketName,
            ContinuationToken: continuationToken,
            MaxKeys: 1000,
          })
        );
        if (result.Contents?.length) {
          allContents.push(...result.Contents);
        }
        continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
      } while (continuationToken);
      const root: OssPathFolder = { kind: "folder", name: "", children: [] };
      for (const obj of allContents) {
        const key = obj.Key ?? "";
        const size = obj.Size ?? 0;
        const segments = key.split("/").filter(Boolean);
        if (segments.length === 0) continue;
        const isFolder = key.endsWith("/") && size === 0;
        if (isFolder) {
          let parent = root;
          for (const seg of segments) {
            parent = getOrCreateFolder(parent, seg);
          }
        } else {
          let parent = root;
          for (let i = 0; i < segments.length - 1; i++) {
            parent = getOrCreateFolder(parent, segments[i]);
          }
          addFile(parent, segments[segments.length - 1], size, obj.LastModified);
        }
      }
      ds.children = ossPathNodesToDatasource(root.children, ds, this);
    } catch (error: any) {
      ds.children = [];
    }
    return ds.children;
  }
  listFolders(ds: Datasource): Promise<Datasource[]> {
    throw new Error("listFolders Method not implemented.");
  }
  listData(ds: Datasource): Promise<TableResult> {
    throw new Error("listData Method not implemented.");
  }
  descDatasource(ds: Datasource): Promise<FormResult | undefined> {
    return Promise.resolve({
      rowData: [ds.data],
    });
  }
  descUser(ds: Datasource): Promise<FormResult | undefined> {
    throw new Error("descUser Method not implemented.");
  }
  descDatabase(ds: Datasource): Promise<FormResult | undefined> {
    throw new Error("descDatabase Method not implemented.");
  }
  descTable(ds: Datasource): Promise<FormResult | undefined> {
    throw new Error("descTable Method not implemented.");
  }
  descColumn(ds: Datasource): Promise<FormResult | undefined> {
    throw new Error("descColumn Method not implemented.");
  }
  descIndex(ds: Datasource): Promise<FormResult | undefined> {
    throw new Error("descIndex Method not implemented.");
  }
  descStructure(): string[] {
    throw new Error("descStructure Method not implemented.");
  }
  saveData(params: SaveDataParams): Promise<SaveResult> {
    throw new Error("saveData Method not implemented.");
  }
}
