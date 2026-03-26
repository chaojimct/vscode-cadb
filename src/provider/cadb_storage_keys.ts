/**
 * CADB 在 workspaceState / globalState 中的键（extension 与 commands 共用）。
 * 注：历史键 cadb.lastActiveTarget 已废弃，扩展不再读写；旧工作区可能仍残留该键，可忽略。
 */

export const CADB_WORKSPACE_OPEN_TABLE_PANELS_KEY = "cadb.openTablePanels";

export const CADB_GLOBAL_DATASOURCE_SIDEBAR_LAST_VISIBLE_KEY =
  "cadb.datasourceSidebarLastVisible";

export type CadbLastActiveTargetState =
  | {
      kind: "file";
      uri: string;
      updatedAt: number;
    }
  | {
      kind: "tableData" | "tableEdit";
      connectionName: string;
      databaseName: string;
      tableName: string;
      updatedAt: number;
    };

export type CadbLastActiveTargetInput =
  | { kind: "file"; uri: string }
  | {
      kind: "tableData";
      connectionName: string;
      databaseName: string;
      tableName: string;
    }
  | {
      kind: "tableEdit";
      connectionName: string;
      databaseName: string;
      tableName: string;
    };

