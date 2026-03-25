import * as vscode from "vscode";
import path from "path";
import { Datasource, type DatasourceInputData } from "../entity/datasource";
import { MySQLDataloader } from "../entity/mysql_dataloader";
import { RedisDataloader } from "../entity/redis_dataloader";
import { OssDataLoader } from "../entity/oss_dataloader";
import { registerDatabaseDriver, type RegisteredDatabaseDriver } from "./registry";

const iconDir: string[] = ["..", "..", "resources", "icons"];

function iconPair(
  subfolder: string,
  lightFile: string,
  darkFile: string
): { light: vscode.Uri; dark: vscode.Uri } {
  return {
    light: vscode.Uri.file(path.join(__filename, ...iconDir, subfolder, lightFile)),
    dark: vscode.Uri.file(path.join(__filename, ...iconDir, subfolder, darkFile)),
  };
}

function registerMysql(): void {
  const driver: RegisteredDatabaseDriver = {
    id: "mysql",
    displayName: "MySQL",
    description: "MySQL / MariaDB（客户端：mysql2，连接池与查询）",
    npmDependencyNames: ["mysql2"],
    capabilities: {
      createDatabase: true,
      sqlExecutionTarget: true,
      supportsTreeDelete: true,
      supportsSchemaHover: true,
    },
    applyPresentation(treeItem: Datasource, input: DatasourceInputData) {
      treeItem.description = `${input.host}:${input.port}`;
      const markColor = input.markColor;
      const markColorThemeIds: Record<string, string> = {
        red: "charts.red",
        yellow: "charts.yellow",
        blue: "charts.blue",
        green: "charts.green",
        cyan: "charts.cyan",
        purple: "charts.purple",
        gray: "charts.gray",
        orange: "charts.orange",
        pink: "charts.pink",
      };
      if (markColor && markColor !== "none" && markColorThemeIds[markColor]) {
        treeItem.resourceUri = vscode.Uri.parse(
          `cadb-color://datasource/${encodeURIComponent(input.name)}?color=${encodeURIComponent(
            markColorThemeIds[markColor]
          )}`
        );
      } else {
        treeItem.resourceUri = undefined;
      }
      treeItem.iconPath = iconPair("mysql", "MySQL_light.svg", "MySQL_dark.svg");
    },
    createDataloader(treeItem: Datasource, input: DatasourceInputData) {
      return new MySQLDataloader(treeItem, input);
    },
  };
  registerDatabaseDriver(driver);
}

function registerRedis(): void {
  const driver: RegisteredDatabaseDriver = {
    id: "redis",
    displayName: "Redis",
    description: "Redis 键值与数据结构（官方 Node 客户端 redis）",
    npmDependencyNames: ["redis"],
    capabilities: { createDatabase: false, sqlExecutionTarget: false },
    applyPresentation(treeItem: Datasource, input: DatasourceInputData) {
      treeItem.description = `${input.host}:${input.port}`;
      treeItem.resourceUri = undefined;
      treeItem.iconPath = iconPair("redis", "Redis_light.svg", "Redis_dark.svg");
    },
    createDataloader(treeItem: Datasource, input: DatasourceInputData) {
      return new RedisDataloader(treeItem, input);
    },
  };
  registerDatabaseDriver(driver);
}

function registerOss(): void {
  const driver: RegisteredDatabaseDriver = {
    id: "oss",
    displayName: "OSS",
    description: "对象存储 S3 兼容（AWS SDK v3：@aws-sdk/client-s3）",
    npmDependencyNames: ["@aws-sdk/client-s3"],
    capabilities: { createDatabase: false, sqlExecutionTarget: false },
    applyPresentation(treeItem: Datasource, input: DatasourceInputData) {
      treeItem.description = `${input.bucket ?? ""}`;
      treeItem.resourceUri = undefined;
      treeItem.iconPath = iconPair("oss", "OSS_light.svg", "OSS_dark.svg");
    },
    createDataloader(treeItem: Datasource, input: DatasourceInputData) {
      return new OssDataLoader(treeItem, input);
    },
  };
  registerDatabaseDriver(driver);
}

/** 在扩展激活最早阶段调用一次；后续可通过 registerDatabaseDriver 追加驱动 */
export function registerBuiltinDatabaseDrivers(): void {
  registerMysql();
  registerRedis();
  registerOss();
}
