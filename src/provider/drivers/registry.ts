import * as vscode from "vscode";
import type { Datasource, DatasourceInputData } from "../entity/datasource";
import type { Dataloader } from "../entity/dataloader";
import type { DriverCapabilities } from "./types";

/**
 * 已注册的数据库驱动（内置或将来由其它扩展在激活时 register）
 */
export interface RegisteredDatabaseDriver {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly capabilities: DriverCapabilities;
  /** 可选：独立驱动扩展的 ID，设置页可提示「去市场安装」 */
  readonly marketplaceExtensionId?: string;
  createDataloader(treeItem: Datasource, input: DatasourceInputData): Dataloader;
  /** 根连接节点 datasource 的图标与描述 */
  applyPresentation(treeItem: Datasource, input: DatasourceInputData): void;
}

const registry = new Map<string, RegisteredDatabaseDriver>();

export function registerDatabaseDriver(driver: RegisteredDatabaseDriver): void {
  if (registry.has(driver.id)) {
    console.warn(`[CADB] 重复注册数据库驱动: ${driver.id}，将被覆盖`);
  }
  registry.set(driver.id, driver);
}

export function getRegisteredDatabaseDriver(
  id: string | undefined
): RegisteredDatabaseDriver | undefined {
  if (!id) {
    return undefined;
  }
  return registry.get(id);
}

export function listRegisteredDatabaseDrivers(): RegisteredDatabaseDriver[] {
  return [...registry.values()];
}

/** 为 type===datasource 的根节点挂载 dataloader 与展示 */
export function attachDriverToDatasourceNode(
  treeItem: Datasource,
  input: DatasourceInputData
): void {
  const driver = getRegisteredDatabaseDriver(input.dbType);
  if (!driver) {
    console.error(`[CADB] 未注册的数据库类型: ${input.dbType ?? "(空)"}`);
    treeItem.iconPath = new vscode.ThemeIcon("error");
    treeItem.description = input.dbType ? `未知驱动: ${input.dbType}` : "未指定数据库类型";
    return;
  }
  driver.applyPresentation(treeItem, input);
  treeItem.dataloader = driver.createDataloader(treeItem, input);
}

export function driverSupportsCreateDatabase(dbType: string | undefined): boolean {
  return !!getRegisteredDatabaseDriver(dbType)?.capabilities.createDatabase;
}

export function driverSupportsSqlExecution(dbType: string | undefined): boolean {
  return !!getRegisteredDatabaseDriver(dbType)?.capabilities.sqlExecutionTarget;
}

export function driverSupportsTreeDelete(dbType: string | undefined): boolean {
  return !!getRegisteredDatabaseDriver(dbType)?.capabilities.supportsTreeDelete;
}

export function driverSupportsSchemaHover(dbType: string | undefined): boolean {
  return !!getRegisteredDatabaseDriver(dbType)?.capabilities.supportsSchemaHover;
}
