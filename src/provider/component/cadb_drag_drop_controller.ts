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
    const nodes = source.filter((node) => !!node.label?.toString());
    if (nodes.length === 0) {
      return;
    }

    // 仅对 document 类型节点（数据表）填充结构化拖拽数据
    const tableItems: CadbTableDragData[] = [];
    for (const node of nodes.filter((n) => n.type === "document")) {
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
      tableItems.push({ connectionName, databaseName, tableName });
    }

    if (tableItems.length > 0) {
      dataTransfer.set(
        CADB_TABLE_DRAG_MIME_TYPE,
        new vscode.DataTransferItem(JSON.stringify(tableItems)),
      );
    }

    // text/plain：所有节点均以 `label` 格式输出，拖入编辑器/聊天等场景直接可用
    // fieldType 节点：展开子字段列表，格式为 `field1`, `field2`, ...
    const plainParts: string[] = [];
    for (const node of nodes) {
      if (node.type === "fieldType") {
        const fields = (node.children ?? [])
          .filter((c) => c.type === "field" && !!c.label?.toString())
          .map((c) => `\`${c.label?.toString()}\``);
        if (fields.length > 0) {
          plainParts.push(fields.join(", "));
          continue;
        }
      }
      plainParts.push(`\`${node.label?.toString()}\``);
    }
    dataTransfer.set(
      "text/plain",
      new vscode.DataTransferItem(plainParts.join(" ")),
    );
  }

  async handleDrop(): Promise<void> {
    // tree does not accept external drops
  }
}
