import * as vscode from "vscode";
import { Datasource } from "./datasource";

export interface PromiseResult {
  success: boolean;
  message?: string;
}

export interface ColDef {
  field: string;
  colId?: string;
  type?: string | string[];
}

export interface TableResult {
  title: string;
  rowData: Record<string, any>[];
  columnDefs: ColDef[];
  queryTime?: number; // 查询时间（秒）
}

export interface FormResult {
  rowData: Record<string, any>[];
}

export interface Dataloader {
  test(): Promise<PromiseResult>;
  connect(): Promise<void>;
  getConnection(): any; // 返回数据库连接对象

  listFiles(ds: Datasource, path: vscode.Uri): Promise<Datasource[]>;

  listUsers(ds: Datasource): Promise<Datasource[]>;
  listAllUsers(ds: Datasource): Promise<Datasource[]>;
  listDatabases(ds: Datasource): Promise<Datasource[]>;

  listObjects(ds: Datasource, type: string): Promise<Datasource[]>;
  listIndexes(ds: Datasource): Promise<Datasource[]>;
  listColumns(ds: Datasource): Promise<Datasource[]>;
  listTables(ds: Datasource): Promise<Datasource[]>;
	listFolders(ds: Datasource): Promise<Datasource[]>;
  listData(
    ds: Datasource,
    page?: number,
    pageSize?: number
  ): Promise<TableResult>;

  descDatasource(ds: Datasource): Promise<FormResult | undefined>;
  descUser(ds: Datasource): Promise<FormResult | undefined>;
  descDatabase(ds: Datasource): Promise<FormResult | undefined>;
  descTable(ds: Datasource): Promise<FormResult | undefined>;
  descColumn(ds: Datasource): Promise<FormResult | undefined>;
  descIndex(ds: Datasource): Promise<FormResult | undefined>;

  descStructure(): string[];
}
