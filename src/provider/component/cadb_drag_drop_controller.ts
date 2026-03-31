import * as vscode from "vscode";
import { Datasource } from "../entity/datasource";

export const CADB_TABLE_DRAG_MIME_TYPE =
  "application/vnd.code.tree.cadb-datasource-tree";

export interface CadbTableDragData {
  connectionName: string;
  databaseName: string;
  tableName: string;
}

export class CadbDragAndDropController implements vscode.TreeDragAndDropController<Datasource> {
  readonly dragMimeTypes = [CADB_TABLE_DRAG_MIME_TYPE, "text/plain"];
  readonly dropMimeTypes: string[] = [];

  async handleDrag(
    source: Datasource[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const tableNodes = source.filter((node) => node.type === "document");
    if (tableNodes.length === 0) {
      return;
    }

    const items: CadbTableDragData[] = [];
    for (const node of tableNodes) {
      const tableName = node.label?.toString() || "";
      if (!tableName) {
        continue;
      }

      let databaseName = "";
      let connectionName = "";
      let cur: Datasource | undefined = node.parent;
      while (cur) {
        if (cur.type === "collection") {
          databaseName = cur.label?.toString() || "";
        } else if (cur.type === "datasource") {
          connectionName = cur.label?.toString() || "";
          break;
        }
        cur = cur.parent;
      }

      items.push({ connectionName, databaseName, tableName });
    }

    if (items.length === 0) {
      return;
    }

    dataTransfer.set(
      CADB_TABLE_DRAG_MIME_TYPE,
      new vscode.DataTransferItem(JSON.stringify(items)),
    );

    // text/plain fallback：拖入聊天等场景时粘贴表名列表
    const tableNames = items.map((i) => `\`${i.tableName}\``).join("、");
    dataTransfer.set(
      "text/plain",
      new vscode.DataTransferItem(`数据表：${tableNames}`),
    );
  }

  async handleDrop(): Promise<void> {
    // tree does not accept external drops
  }
}
