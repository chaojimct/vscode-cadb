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
  editable?: boolean;
}

export interface TableResult {
  title: string;
  rowData: Record<string, any>[];
  columnDefs: ColDef[];
  queryTime?: number; // 查询时间（秒）
  totalCount?: number; // 总行数，用于远程分页
}

export interface FormResult {
  rowData: Record<string, any>[];
}

/**
 * 保存行数据的参数
 */
export interface SaveRowData {
  id: any; // 主键值（新行可为空）
  original: Record<string, any>; // 原始数据
  updated: Record<string, any>; // 更新的字段（仅包含改变的字段）
  full: Record<string, any>; // 完整的新数据
  isNew?: boolean; // 是否为新插入行
}

/**
 * 保存数据的参数
 */
export interface SaveDataParams {
  tableName: string; // 表名
  databaseName: string; // 数据库名
  primaryKeyField: string; // 主键字段名
  rows: SaveRowData[]; // 要保存的行数据（更新/插入）
  deletedRows?: Array<{ id: any }>; // 标记删除的行（主键值，执行 DELETE）
}

/**
 * 保存结果
 */
export interface SaveResult {
  successCount: number; // 成功数量
  errorCount: number; // 失败数量
  errors: string[]; // 错误信息列表
  /** 已执行的 SQL（如 MySQL UPDATE），用于输出到 CADB SQL 面板 */
  executedSql?: string[];
}

export interface Dataloader {
	rootNode(): Datasource;
	dbType(): string;
  test(): Promise<PromiseResult>;
  connect(): Promise<void>;
  getConnection(): any; // 返回数据库连接对象

  // 列举所有支持的排序规则
  listCollations(ds: Datasource): Promise<Datasource[]>;
  createDatabase(params: any): Promise<void>;
  listFiles(ds: Datasource, path: vscode.Uri): Promise<Datasource[]>;

  listUsers(ds: Datasource): Promise<Datasource[]>;
  listAllUsers(ds: Datasource): Promise<Datasource[]>;
  listDatabases(ds: Datasource): Promise<Datasource[]>;

  listObjects(ds: Datasource, type: string): Promise<Datasource[]>;
  listIndexes(ds: Datasource): Promise<Datasource[]>;
  listColumns(ds: Datasource): Promise<Datasource[]>;
  listTables(ds: Datasource): Promise<Datasource[]>;
  listFolders(ds: Datasource): Promise<Datasource[]>;
  listData(ds: Datasource): Promise<TableResult>;

  descDatasource(ds: Datasource): Promise<FormResult | undefined>;
  descUser(ds: Datasource): Promise<FormResult | undefined>;
  descDatabase(ds: Datasource): Promise<FormResult | undefined>;
  descTable(ds: Datasource): Promise<FormResult | undefined>;
  descColumn(ds: Datasource): Promise<FormResult | undefined>;
  descIndex(ds: Datasource): Promise<FormResult | undefined>;

  descStructure(): string[];

  /**
   * 保存表格数据（根据主键更新）
   * @param params 保存参数
   * @returns 保存结果
   */
  saveData(params: SaveDataParams): Promise<SaveResult>;
}
