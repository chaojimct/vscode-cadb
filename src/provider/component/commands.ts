import * as vscode from "vscode";
import { DataSourceProvider } from "../database_provider";
import {
  getConnectionGroupFormOptions,
  getConnectionGroupsEditorLines,
  getRemovedGroupsForMigration,
  getStoredConnectionGroupsOrder,
  normalizeConnectionGroupsOrderForSave,
  setConnectionGroupsOrder,
} from "../connection_groups";
import { Datasource } from "../entity/datasource";
import path from "path";
import { FormResult, type ListDataSortCol, type TableResult } from "../entity/dataloader";
import { MySQLDataloader } from "../entity/mysql_dataloader";
import { OssDataLoader } from "../entity/oss_dataloader";
import { RedisDataloader } from "../entity/redis_dataloader";
import { DatabaseManager } from "./database_manager";
import { ResultWebviewProvider } from "../result_provider";
import { DatabaseSelector } from "./database_selector";
import { createWebview } from "../webview_helper";
import type { RedisClientType } from "redis";
import { resolveTableDatasource } from "../workspace_symbol_provider";
import { fuzzyMatch } from "../utils";
import { ensureSelectRowLimit } from "./sql_limit_guard";
import {
  driverSupportsCreateDatabase,
  driverSupportsTreeDelete,
} from "../drivers/registry";
import {
  getDriverOptionsForEditConnection,
  getDriverOptionsForNewConnection,
  getDriversManagementPayload,
  isDriverEnabled,
  setDriverEnabled,
} from "../drivers/enabled_store";

/**
 * 将 unknown 错误转换为可展示的消息文本
 */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 向 settings webview 回传统一的状态消息
 */
function postWebviewStatus(
  webview: vscode.Webview,
  payload: { success: boolean; message: string }
) {
  webview.postMessage({
    command: "status",
    success: payload.success,
    message: payload.message,
  });
}

/**
 * 处理 settings webview 的保存消息
 * - datasource：更新连接配置（按 dbType 分发）
 * - user：更新用户信息
 * - collection：更新数据库配置（仅 MySQL）
 */
async function handleSettingsSaveMessage(
  provider: DataSourceProvider,
  item: Datasource,
  panel: vscode.WebviewPanel,
  payload: any
) {
  try {
    if (item.type === "datasource") {
      await saveDatasourceConfigForEdit(provider, item, payload);
      postWebviewStatus(panel.webview, {
        success: true,
        message: "✔️ 连接配置更新成功",
      });
      return;
    }

    if (item.type === "user") {
      await updateUserInfo(provider, item, payload);
      postWebviewStatus(panel.webview, {
        success: true,
        message: "✔️ 用户信息更新成功",
      });
      return;
    }

    if (item.type === "collection") {
      await updateDatabaseConfig(item, payload);
      provider.refresh();
      postWebviewStatus(panel.webview, {
        success: true,
        message: "✔️ 数据库配置更新成功",
      });
    }
  } catch (error) {
    console.error("保存失败:", error);
    postWebviewStatus(panel.webview, {
      success: false,
      message: `❗ 保存失败: ${toErrorMessage(error)}`,
    });
  }
}

/**
 * 处理 settings webview 的测试连接消息（仅 datasource）
 */
async function handleSettingsTestMessage(
  provider: DataSourceProvider,
  item: Datasource,
  panel: vscode.WebviewPanel,
  payload: any
) {
  if (item.type !== "datasource") {
    return;
  }

  try {
    const db = await Datasource.createInstance(
      provider.getConnections(),
      provider.context,
      payload
    );
    const res = await db.test();
    if (res.success) {
      postWebviewStatus(panel.webview, {
        success: true,
        message: "✔️ 连接测试成功",
      });
    } else {
      postWebviewStatus(panel.webview, {
        success: false,
        message: `❗ ${res.message}`,
      });
    }
  } catch (error) {
    postWebviewStatus(panel.webview, {
      success: false,
      message: `❗ 测试失败: ${toErrorMessage(error)}`,
    });
  }
}

/**
 * 新建数据源时的保存入口（按 dbType 分发）
 */
async function saveDatasourceConfigForCreate(
  provider: DataSourceProvider,
  payload: any
): Promise<void> {
  const name = String(payload?.name || "").trim();
  if (!name) {
    throw new Error("连接名称不能为空");
  }
  const dbType = String(payload?.dbType || "").trim();
  if (!dbType) {
    throw new Error("请选择数据库类型");
  }
  if (!isDriverEnabled(provider.context, dbType)) {
    throw new Error("该数据库驱动未启用，请先在命令面板执行「CADB: 管理数据库驱动」并勾选对应类型");
  }
  const connections = provider.getConnections();
  if (connections.some((c) => c.name === name)) {
    throw new Error("该连接名称已存在");
  }
  await provider.addConnection(payload);
}

/**
 * 编辑数据源时的保存入口（按 dbType 分发）
 */
async function saveDatasourceConfigForEdit(
  provider: DataSourceProvider,
  item: Datasource,
  payload: any
): Promise<void> {
  const nextDb = String(payload?.dbType || "").trim();
  const origDb = item.data?.dbType;
  if (
    nextDb &&
    nextDb !== origDb &&
    !isDriverEnabled(provider.context, nextDb)
  ) {
    throw new Error("所选数据库类型未启用，请先在「管理数据库驱动」中启用");
  }
  if (payload?.dbType === "oss") {
    await saveOssDatasourceConfig(provider, payload, {
      originalName: item.label?.toString() || "",
    });
    return;
  }

  await updateNonOssDatasourceConfig(provider, item, payload);
}

function findAncestorByType(
  node: Datasource,
  type: string
): Datasource | undefined {
  let current: Datasource | undefined = node;
  while (current) {
    if (current.type === type) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function escapeMySqlId(name: string): string {
  return name.replace(/`/g, "``");
}

function parseMySqlUser(label: string): { user: string; host: string } | null {
  const idx = label.lastIndexOf("@");
  if (idx <= 0 || idx >= label.length - 1) return null;
  const user = label.slice(0, idx);
  const host = label.slice(idx + 1);
  if (!user || !host) return null;
  return { user, host };
}

function getDatasourceNode(node: Datasource): Datasource | undefined {
  return findAncestorByType(node, "datasource");
}

function getDatabaseName(node: Datasource): string | null {
  const dbNode = findAncestorByType(node, "collection");
  const db = dbNode?.label?.toString() ?? "";
  return db ? db : null;
}

function getTableName(node: Datasource): string | null {
  const tNode = findAncestorByType(node, "document");
  const t = tNode?.label?.toString() ?? "";
  return t ? t : null;
}

/** 从 OSS 树节点解析出 bucket 与完整 key（path） */
function getOssBucketAndKey(node: Datasource): { bucket: string; key: string } | null {
  const bucketNode = findAncestorByType(node, "collectionType");
  if (!bucketNode) return null;
  const bucket = bucketNode.label?.toString() ?? "";
  if (!bucket) return null;
  const parts: string[] = [];
  let cur: Datasource | undefined = node;
  while (cur && cur !== bucketNode) {
    const name = cur.label?.toString() ?? "";
    if (name) parts.unshift(name);
    cur = cur.parent;
  }
  const key = parts.join("/") + (node.type === "folder" ? "/" : "");
  return { bucket, key };
}

/** OSS 文件：下载到临时目录后按后缀用默认编辑器打开 */
async function ossPreview(
  node: Datasource,
  provider: DataSourceProvider
): Promise<void> {
  if (node.type === "folder") {
    return;
  }
  const loader = node.dataloader as OssDataLoader | undefined;
  const info = getOssBucketAndKey(node);
  if (!loader || !info) {
    vscode.window.showWarningMessage("无法解析 OSS 路径");
    return;
  }
  const { bucket, key } = info;
  try {
    const buf = await loader.getObject(bucket, key);
    const baseDir = vscode.Uri.joinPath(
      provider.context.globalStorageUri,
      "cadb-oss-preview",
      bucket
    );
    const keyParts = key.split("/").filter(Boolean);
    const fileName = keyParts[keyParts.length - 1] || "file";
    const tempUri =
      keyParts.length > 1
        ? vscode.Uri.joinPath(baseDir, ...keyParts.slice(0, -1), fileName)
        : vscode.Uri.joinPath(baseDir, fileName);
    await vscode.workspace.fs.createDirectory(baseDir);
    let parent = baseDir;
    for (const segment of keyParts.slice(0, -1)) {
      parent = vscode.Uri.joinPath(parent, segment);
      await vscode.workspace.fs.createDirectory(parent);
    }
    await vscode.workspace.fs.writeFile(tempUri, buf);
    await vscode.commands.executeCommand("vscode.open", tempUri, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
    });
  } catch (e) {
    vscode.window.showErrorMessage(
      `打开失败: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function validateAndGetFilePath(
  item: any,
  operation: string
): string | undefined {
  const fileItem = item as Datasource;
  if (!fileItem || fileItem.type !== "file") {
    vscode.window.showErrorMessage(`无法${operation}：不是有效的文件项`);
    return undefined;
  }

  const filePath =
    typeof fileItem.tooltip === "string"
      ? fileItem.tooltip
      : fileItem.tooltip?.value || "";

  if (!filePath) {
    vscode.window.showErrorMessage("无法获取文件路径");
    return undefined;
  }
  return filePath;
}

async function editEntry(
  provider: DataSourceProvider,
  item: Datasource,
  outputChannel: vscode.OutputChannel
) {
  let panel: vscode.WebviewPanel | null = null;
  let configType = "";

  if (item.type === "datasource") {
    panel = createWebview(provider, "settings", `【${item.label}】编辑`);
    configType = "datasource";
  } else if (item.type === "user") {
    panel = createWebview(provider, "settings", `【${item.label}】编辑`);
    configType = "user";
  } else if (item.type === "collection") {
    const datasourceNode = findAncestorByType(item, "datasource");
    const dbType = datasourceNode?.data?.dbType || "mysql";
    if (!driverSupportsCreateDatabase(dbType)) {
      vscode.window.showWarningMessage("当前连接类型不支持在此编辑数据库属性");
      return;
    }
    panel = createWebview(provider, "settings", `【${item.label}】编辑`);
    configType = "database";
  } else if (
    item.type === "document" ||
    item.type === "field" ||
    item.type === "index"
  ) {
    const tableNode =
      item.type === "document" ? item : findAncestorByType(item, "document");
    const tableName = tableNode?.label?.toString() || "";
    const databaseName = tableNode?.parent?.parent?.label?.toString() || "";
    const connectionName =
      tableNode?.dataloader?.rootNode().label?.toString() || "";
    const editPanelKey = `${connectionName}|${databaseName}|${tableName}`;

    const existingEdit = openTableEditPanels.get(editPanelKey);
    if (existingEdit) {
      existingEdit.reveal();
      try {
        const data = tableNode?.dataloader
          ? await tableNode.dataloader.descTable(tableNode!)
          : null;
        if (data) {
          existingEdit.webview.postMessage({
            command: "load",
            configType: "",
            data: { ...data, connectionName, databaseName, tableName },
          });
        }
      } catch (e) {
        console.error("重新加载表结构失败:", e);
      }
      return;
    }

    const tableEditPanel = createWebview(
      provider,
      "tableEdit",
      `【${item.label}】编辑`
    );
    openTableEditPanels.set(editPanelKey, tableEditPanel);
    tableEditPanel.onDidDispose(() => openTableEditPanels.delete(editPanelKey));

    // tableEdit: 先注册消息监听，等 webview 发 ready 后再加载表结构
    tableEditPanel.webview.onDidReceiveMessage(async (message) => {
      if (!tableNode?.dataloader) {
        tableEditPanel.webview.postMessage({
          command: "status",
          success: false,
          message: "无法获取表结构",
        });
        return;
      }

      if (message.command === "switchToTableData") {
        await sqlResultView(tableNode, provider, outputChannel);
        return;
      }

      if (message.command === "ready") {
        try {
          const data = await tableNode.dataloader.descTable(tableNode);
          tableEditPanel.webview.postMessage({
            command: "load",
            configType: "",
            data: {
              ...data,
              connectionName,
              databaseName,
              tableName,
            },
          });
        } catch (error) {
          console.error("加载表结构失败:", error);
          tableEditPanel.webview.postMessage({
            command: "status",
            success: false,
            message: `加载失败: ${error instanceof Error ? error.message : String(error)
              }`,
          });
        }
        return;
      }

      if (message.command === "saveField") {
        const loader = tableNode.dataloader;
        if (!(loader instanceof MySQLDataloader)) {
          tableEditPanel.webview.postMessage({
            command: "status",
            success: false,
            message: "当前数据库类型不支持修改表结构",
          });
          return;
        }
        const databaseName = tableNode.parent?.parent?.label?.toString();
        const tableName = tableNode.label?.toString();
        if (!databaseName || !tableName) {
          tableEditPanel.webview.postMessage({
            command: "status",
            success: false,
            message: "无法获取数据库或表名",
          });
          return;
        }
        const { data: fieldData, originalName, isNew } = message;
        if (!fieldData || !fieldData.name) {
          tableEditPanel.webview.postMessage({
            command: "status",
            success: false,
            message: "字段数据不完整",
          });
          return;
        }
        try {
          const operation = isNew ? "add" : "modify";
          const startTime = Date.now();
          const sql = await loader.alterColumn({
            databaseName,
            tableName,
            operation,
            originalName,
            field: {
              name: fieldData.name,
              type: fieldData.type || "varchar",
              length: fieldData.length,
              defaultValue: fieldData.defaultValue ?? null,
              nullable: fieldData.nullable !== false,
              autoIncrement: fieldData.autoIncrement,
              primaryKey: fieldData.primaryKey,
              comment: fieldData.comment || "",
            },
          });
          const executionTime = (Date.now() - startTime) / 1000;
          const outputChannel = vscode.window.createOutputChannel("CADB SQL");
          const ts = new Date();
          const timestamp = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, "0")}-${String(ts.getDate()).padStart(2, "0")} ${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}`;
          outputChannel.appendLine(`[${timestamp} ${databaseName}, ${executionTime.toFixed(3)}s] ${sql.replace(/\s+/g, " ").trim()}`);
          outputChannel.show(true);
          tableEditPanel.webview.postMessage({
            command: "status",
            success: true,
            message: "字段保存成功",
          });
          const freshData = await loader.descTable(tableNode);
          tableEditPanel.webview.postMessage({
            command: "load",
            configType: "",
            data: freshData,
          });
        } catch (error) {
          console.error("保存字段失败:", error);
          tableEditPanel.webview.postMessage({
            command: "status",
            success: false,
            message: `保存失败: ${toErrorMessage(error)}`,
          });
        }
        return;
      }

      if (message.command === "deleteField") {
        const loader = tableNode.dataloader;
        if (!(loader instanceof MySQLDataloader)) {
          tableEditPanel.webview.postMessage({
            command: "status",
            success: false,
            message: "当前数据库类型不支持修改表结构",
          });
          return;
        }
        const databaseName = tableNode.parent?.parent?.label?.toString();
        const tableName = tableNode.label?.toString();
        if (!databaseName || !tableName) {
          tableEditPanel.webview.postMessage({
            command: "status",
            success: false,
            message: "无法获取数据库或表名",
          });
          return;
        }
        const { fieldName } = message;
        if (!fieldName) {
          tableEditPanel.webview.postMessage({
            command: "status",
            success: false,
            message: "缺少字段名",
          });
          return;
        }
        try {
          const startTime = Date.now();
          const sql = await loader.alterColumn({
            databaseName,
            tableName,
            operation: "drop",
            originalName: fieldName,
          });
          const executionTime = (Date.now() - startTime) / 1000;
          const outputChannel = vscode.window.createOutputChannel("CADB SQL");
          const ts = new Date();
          const timestamp = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, "0")}-${String(ts.getDate()).padStart(2, "0")} ${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}`;
          outputChannel.appendLine(`[${timestamp} ${databaseName}, ${executionTime.toFixed(3)}s] ${sql.replace(/\s+/g, " ").trim()}`);
          outputChannel.show(true);
          tableEditPanel.webview.postMessage({
            command: "status",
            success: true,
            message: "字段删除成功",
          });
          const freshData = await loader.descTable(tableNode);
          tableEditPanel.webview.postMessage({
            command: "load",
            configType: "",
            data: freshData,
          });
        } catch (error) {
          console.error("删除字段失败:", error);
          tableEditPanel.webview.postMessage({
            command: "status",
            success: false,
            message: `删除失败: ${toErrorMessage(error)}`,
          });
        }
        return;
      }

      if (message.command === "saveIndex") {
        const loader = tableNode.dataloader;
        if (!(loader instanceof MySQLDataloader)) {
          tableEditPanel.webview.postMessage({
            command: "status",
            success: false,
            message: "当前数据库类型不支持修改表结构",
          });
          return;
        }
        const databaseName = tableNode.parent?.parent?.label?.toString();
        const tableName = tableNode.label?.toString();
        if (!databaseName || !tableName) {
          tableEditPanel.webview.postMessage({
            command: "status",
            success: false,
            message: "无法获取数据库或表名",
          });
          return;
        }
        const { data: indexData, originalName, isNew } = message;
        if (!indexData || !indexData.name || !indexData.fields) {
          tableEditPanel.webview.postMessage({
            command: "status",
            success: false,
            message: "索引数据不完整",
          });
          return;
        }
        let fields = indexData.fields;
        if (typeof fields === "string") {
          fields = (fields as string).split(",").map((f: string) => f.trim()).filter(Boolean);
        } else if (!Array.isArray(fields)) {
          fields = [];
        }
        if (fields.length === 0) {
          tableEditPanel.webview.postMessage({
            command: "status",
            success: false,
            message: "索引至少需要选择一个字段",
          });
          return;
        }
        try {
          const operation = isNew ? "add" : "modify";
          const startTime = Date.now();
          const sql = await loader.alterIndex({
            databaseName,
            tableName,
            operation,
            originalName,
            index: {
              name: indexData.name,
              type: indexData.type || "index",
              fields: fields as string[],
              unique: indexData.unique,
              comment: indexData.comment || "",
            },
          });
          const executionTime = (Date.now() - startTime) / 1000;
          const outputChannel = vscode.window.createOutputChannel("CADB SQL");
          const ts = new Date();
          const timestamp = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, "0")}-${String(ts.getDate()).padStart(2, "0")} ${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}`;
          for (const line of sql.split("\n").filter(Boolean)) {
            outputChannel.appendLine(`[${timestamp} ${databaseName}, ${executionTime.toFixed(3)}s] ${line.replace(/\s+/g, " ").trim()}`);
          }
          outputChannel.show(true);
          tableEditPanel.webview.postMessage({
            command: "status",
            success: true,
            message: "索引保存成功",
          });
          const freshData = await loader.descTable(tableNode);
          tableEditPanel.webview.postMessage({
            command: "load",
            configType: "",
            data: freshData,
          });
        } catch (error) {
          console.error("保存索引失败:", error);
          tableEditPanel.webview.postMessage({
            command: "status",
            success: false,
            message: `保存失败: ${toErrorMessage(error)}`,
          });
        }
        return;
      }

      if (message.command === "deleteIndex") {
        const loader = tableNode.dataloader;
        if (!(loader instanceof MySQLDataloader)) {
          tableEditPanel.webview.postMessage({
            command: "status",
            success: false,
            message: "当前数据库类型不支持修改表结构",
          });
          return;
        }
        const databaseName = tableNode.parent?.parent?.label?.toString();
        const tableName = tableNode.label?.toString();
        if (!databaseName || !tableName) {
          tableEditPanel.webview.postMessage({
            command: "status",
            success: false,
            message: "无法获取数据库或表名",
          });
          return;
        }
        const indexName = message.indexName;
        if (!indexName) {
          tableEditPanel.webview.postMessage({
            command: "status",
            success: false,
            message: "缺少索引名",
          });
          return;
        }
        try {
          const startTime = Date.now();
          const sql = await loader.alterIndex({
            databaseName,
            tableName,
            operation: "drop",
            originalName: indexName,
          });
          const executionTime = (Date.now() - startTime) / 1000;
          const ts = new Date();
          const timestamp = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, "0")}-${String(ts.getDate()).padStart(2, "0")} ${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}`;
          outputChannel.appendLine(`[${timestamp} ${databaseName}, ${executionTime.toFixed(3)}s] ${sql.replace(/\s+/g, " ").trim()}`);
          outputChannel.show(true);
          tableEditPanel.webview.postMessage({
            command: "status",
            success: true,
            message: "索引删除成功",
          });
          const freshData = await loader.descTable(tableNode);
          tableEditPanel.webview.postMessage({
            command: "load",
            configType: "",
            data: freshData,
          });
        } catch (error) {
          console.error("删除索引失败:", error);
          tableEditPanel.webview.postMessage({
            command: "status",
            success: false,
            message: `删除失败: ${toErrorMessage(error)}`,
          });
        }
        return;
      }
    });
    return;
  } else {
    return;
  }

  let data: FormResult | undefined = undefined;
  try {
    data = await item.edit();
  } catch (error) {
    console.error("加载编辑数据失败:", error);
    vscode.window.showErrorMessage(
      `加载编辑数据失败: ${error instanceof Error ? error.message : String(error)
      }`
    );
    return;
  }
  const settingsPanel = panel!;
  if (configType === "database") {
    const databaseData = data?.rowData?.[0] || {};
    let collations: Datasource[] = [];
    try {
      collations = item.dataloader
        ? await item.dataloader.listCollations(item)
        : [];
    } catch {
      collations = [];
    }
    const options = collations.map((c) => ({
      label: c.label?.toString() || "",
      value: c.label?.toString() || "",
    }));

    settingsPanel.webview.postMessage({
      command: "load",
      configType: configType,
      data: {
        ...databaseData,
        _mode: "edit",
        _originalName: databaseData?.name || item.label?.toString() || "",
      },
      options: { collation: options },
    });
  } else {
    settingsPanel.webview.postMessage({
      command: "load",
      configType: configType,
      data: data,
      driverOptions:
        item.type === "datasource"
          ? getDriverOptionsForEditConnection(provider.context, item.data?.dbType)
          : undefined,
      groupOptions:
        item.type === "datasource"
          ? getConnectionGroupFormOptions(
              provider.context,
              provider.getConnections(),
              data?.rowData?.[0]?.group ?? item.data?.group
            )
          : undefined,
    });
  }

  settingsPanel.webview.onDidReceiveMessage(async (message) => {
    switch (message.command) {
      case "save":
        await handleSettingsSaveMessage(provider, item, settingsPanel, message.payload);
        break;
      case "test":
        await handleSettingsTestMessage(provider, item, settingsPanel, message.payload);
        break;
    }
  });
}

/**
 * 更新非 OSS 数据源连接配置
 */
async function updateNonOssDatasourceConfig(
  provider: DataSourceProvider,
  item: Datasource,
  payload: any
): Promise<void> {
  const originalName = item.label?.toString() || "";
  if (!originalName) {
    throw new Error("未找到要更新的连接配置");
  }
  const next = {
    ...(item.data || {}),
    ...payload,
    type: "datasource",
    tooltip: `${payload.dbType}://${payload.host}:${payload.port}`,
  };
  await provider.updateConnectionByName(originalName, next);
  provider.refresh();
}

async function saveOssDatasourceConfig(
  provider: DataSourceProvider,
  payload: any,
  options: { originalName?: string }
): Promise<void> {
  // TODO: 实现 OSS 数据源保存逻辑（新建/编辑共用此入口）
  void provider;
  void payload;
  void options;
  throw new Error("OSS 数据源保存逻辑未实现");
}

/**
 * 更新用户信息
 */
async function updateUserInfo(
  provider: DataSourceProvider,
  item: Datasource,
  payload: any
): Promise<void> {
  // 用户信息更新需要通过数据库操作
  // 这里调用 item 的 update 方法（如果有的话）
  if (item.dataloader) {
    // TODO: 实现用户信息的数据库更新逻辑
    // 这需要在 dataloader 中添加 updateUser 方法
    vscode.window.showInformationMessage(
      "用户信息已更新（需要实现数据库更新逻辑）"
    );
  } else {
    throw new Error("无法获取数据库连接");
  }
}

async function updateDatabaseConfig(
  item: Datasource,
  payload: any
): Promise<void> {
  const databaseName = item.label?.toString() || "";
  const originalName = payload?._originalName || databaseName;
  const requestedName = payload?.name || originalName;
  if (requestedName !== originalName) {
    throw new Error("暂不支持重命名数据库");
  }

  const collation = payload?.collation;
  if (!collation) {
    throw new Error("排序规则不能为空");
  }
  if (!/^[0-9A-Za-z_]+$/.test(String(collation))) {
    throw new Error("排序规则格式非法");
  }

  if (!item.dataloader) {
    throw new Error("无法获取数据库连接");
  }

  await item.connect();
  const conn: any = item.dataloader.getConnection();
  if (!conn || typeof conn.query !== "function") {
    throw new Error("当前数据源不支持编辑数据库");
  }

  const escapedDbName = originalName.replace(/`/g, "``");
  const charset = String(collation).split("_")[0];
  if (!/^[0-9A-Za-z_]+$/.test(charset)) {
    throw new Error("字符集格式非法");
  }
  await new Promise<void>((resolve, reject) => {
    conn.query(
      `ALTER DATABASE \`${escapedDbName}\` CHARACTER SET ${charset} COLLATE ${collation}`,
      (err: any) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });
}

export function registerDatasourceCommands(
  provider: DataSourceProvider,
  treeView: vscode.TreeView<Datasource>,
  outputChannel: vscode.OutputChannel
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  Datasource.createDatabaseHost = {
    createWebview: (viewType, title) =>
      createWebview(provider, viewType as "settings", title),
    refresh: (item?) => provider.refresh(item),
    loadCollectionChildren: (node) => provider.loadCollectionChildren(node),
    getConnectionFilesDirUri: (name) => provider.getConnectionFilesDirUri(name),
  };

  // 注册刷新命令，支持完整加载
  disposables.push(
    vscode.commands.registerCommand(
      "cadb.datasource.refresh",
      async (item?: Datasource) => {
        if (item && item.type === "datasource") {
          // 如果指定了数据源，则完整加载该数据源
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `正在刷新 ${item.label}...`,
              cancellable: false,
            },
            async (progress) => {
              // 清除缓存
              provider.clearCachedTreeData(item.label?.toString() || "");
              // 清空子节点，强制重新加载
              item.children = [];
              // 完整加载
              await provider.loadAllChildren(item, progress);
              // 刷新视图
              provider.refresh();
            }
          );
        } else {
          // 否则执行普通刷新
          provider.refresh();
        }
      }
    )
  );

  disposables.push(
    vscode.commands.registerCommand("cadb.datasource.add", async (item) => {
      await (item as Datasource).create(provider.context, provider.databaseManager);
      provider.refresh();
    })
  );

  disposables.push(
    vscode.commands.registerCommand("cadb.datasource.new", async (item) => {
      const driverOptions = getDriverOptionsForNewConnection(provider.context);
      if (driverOptions.length === 0) {
        vscode.window.showWarningMessage(
          "没有已启用的数据库驱动。请在命令面板执行「CADB: 管理数据库驱动」至少启用一种类型。"
        );
        return;
      }
      const panel = createWebview(provider, "settings", "数据库连接配置");
      // 发送初始化消息，指定为 datasource 类型的新建模式
      panel.webview.postMessage({
        command: "load",
        configType: "datasource",
        data: null,
        driverOptions,
        groupOptions: getConnectionGroupFormOptions(
          provider.context,
          provider.getConnections()
        ),
      });

      panel.webview.onDidReceiveMessage(async (message) => {
        switch (message.command) {
          case "save":
            {
              try {
                await saveDatasourceConfigForCreate(provider, message.payload);
                provider.refresh();
                postWebviewStatus(panel.webview, {
                  success: true,
                  message: "✔️保存成功",
                });
              } catch (error) {
                postWebviewStatus(panel.webview, {
                  success: false,
                  message: `❗ 保存失败: ${toErrorMessage(error)}`,
                });
              }
            }
            return;
          case "test":
            {
              try {
                const db = await Datasource.createInstance(
                  provider.getConnections(),
                  provider.context,
                  message.payload
                );
                const res = await db.test();
                if (res.success) {
                  postWebviewStatus(panel.webview, {
                    success: res.success,
                    message: "✔️连接成功",
                  });
                } else {
                  postWebviewStatus(panel.webview, {
                    success: res.success,
                    message: `❗${res.message}`,
                  });
                }
              } catch (error) {
                postWebviewStatus(panel.webview, {
                  success: false,
                  message: `❗ 测试失败: ${toErrorMessage(error)}`,
                });
              }
            }
            break;
        }
      });
    })
  );

  disposables.push(
    vscode.commands.registerCommand("cadb.datasource.edit", (item) =>
      editEntry(provider, item, outputChannel)
    )
  );

  disposables.push(
    vscode.commands.registerCommand("cadb.datasource.rename", async (item: Datasource) => {
      if (!item || item.type !== "datasource") {
        return;
      }
      const oldName = item.label?.toString()?.trim() || "";
      if (!oldName) {
        vscode.window.showWarningMessage("无法获取当前连接名称");
        return;
      }
      const connections = provider.getConnections();
      const newName = await vscode.window.showInputBox({
        title: "重命名数据源连接",
        prompt: "输入新的连接名称",
        value: oldName,
        validateInput: (value) => {
          const name = value?.trim() || "";
          if (!name) return "名称不能为空";
          if (name === oldName) return "名称未更改";
          if (connections.some((c) => c.name === name)) return "该名称已被其他连接使用";
          return "";
        },
      });
      if (newName === undefined || newName.trim() === "" || newName.trim() === oldName) {
        return;
      }
      const name = newName.trim();
      if (connections.some((c) => c.name === name)) {
        vscode.window.showWarningMessage("该名称已被其他连接使用");
        return;
      }
      try {
        await provider.renameConnectionRecord(oldName, name);
      } catch (error) {
        vscode.window.showErrorMessage(
          `未找到要重命名的连接: ${toErrorMessage(error)}`
        );
        return;
      }
      provider.renameConnection(oldName, name);
      provider.refresh();
      vscode.window.showInformationMessage(`已重命名为 "${name}"`);
    })
  );

  // 注册通用删除命令
  disposables.push(
    vscode.commands.registerCommand("cadb.delete", async (item: Datasource) => {
      if (!item) {
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `确定要删除 "${item.label}" 吗？此操作无法撤销。`,
        { modal: true },
        "删除",
        "取消"
      );

      if (confirm === "删除") {
        const dsNode = getDatasourceNode(item) ?? (item.type === "datasource" ? item : undefined);
        const dbType = dsNode?.data?.dbType;
        if (!driverSupportsTreeDelete(dbType)) {
          vscode.window.showWarningMessage("当前连接类型不支持在侧栏删除该对象");
          return;
        }
        const loader = dsNode?.dataloader as any;
        if (!dsNode || !loader) {
          vscode.window.showErrorMessage("无法获取数据库连接");
          return;
        }
        try {
          await dsNode.connect();
          const conn: any = loader.getConnection?.();
          if (!conn || typeof conn.query !== "function") {
            throw new Error("无法获取 MySQL 连接");
          }

          if (item.type === "datasource") {
            const name = item.label?.toString() ?? "";
            if (!name) {
              throw new Error("连接名称为空");
            }
            await provider.deleteConnectionRecord(name);
            try {
              const dsPath = vscode.Uri.joinPath(provider.context.globalStorageUri, name);
              await vscode.workspace.fs.delete(dsPath, { recursive: true, useTrash: true });
            } catch (_) {}
            provider.refresh();
            vscode.window.showInformationMessage(`已删除连接 "${name}"`);
            return;
          }

          const run = (sql: string) =>
            new Promise<void>((resolve, reject) => {
              conn.query(sql, (err: any) => {
                if (err) reject(err);
                else resolve();
              });
            });

          if (item.type === "collection") {
            const db = item.label?.toString() ?? "";
            if (!db) throw new Error("无法获取数据库名");
            await run(`DROP DATABASE \`${escapeMySqlId(db)}\``);
            provider.refresh();
            vscode.window.showInformationMessage(`已删除数据库 "${db}"`);
            return;
          }

          if (item.type === "document") {
            const db = getDatabaseName(item);
            const table = item.label?.toString() ?? "";
            if (!db || !table) throw new Error("无法解析库名或表名");
            await run(`DROP TABLE \`${escapeMySqlId(db)}\`.\`${escapeMySqlId(table)}\``);
            provider.refresh();
            vscode.window.showInformationMessage(`已删除表 "${db}.${table}"`);
            return;
          }

          if (item.type === "field") {
            const db = getDatabaseName(item);
            const table = getTableName(item);
            const col = item.label?.toString() ?? "";
            if (!db || !table || !col) throw new Error("无法解析库名/表名/字段名");
            if (typeof loader.alterColumn !== "function") {
              throw new Error("当前连接不支持删除字段");
            }
            await loader.alterColumn({
              databaseName: db,
              tableName: table,
              operation: "drop",
              originalName: col,
            });
            provider.refresh();
            vscode.window.showInformationMessage(`已删除字段 "${db}.${table}.${col}"`);
            return;
          }

          if (item.type === "index") {
            const db = getDatabaseName(item);
            const table = getTableName(item);
            const idxName = item.label?.toString() ?? "";
            if (!db || !table || !idxName) throw new Error("无法解析库名/表名/索引名");
            if (typeof loader.alterIndex !== "function") {
              throw new Error("当前连接不支持删除索引");
            }
            await loader.alterIndex({
              databaseName: db,
              tableName: table,
              operation: "drop",
              originalName: idxName,
            });
            provider.refresh();
            vscode.window.showInformationMessage(`已删除索引 "${db}.${table}.${idxName}"`);
            return;
          }

          if (item.type === "user") {
            const label = item.label?.toString() ?? "";
            const parsed = parseMySqlUser(label);
            if (!parsed) {
              throw new Error("无法解析用户名与主机");
            }
            await run(`DROP USER ${conn.escape(parsed.user)}@${conn.escape(parsed.host)}`);
            provider.refresh();
            vscode.window.showInformationMessage(`已删除用户 "${label}"`);
            return;
          }

          vscode.window.showWarningMessage(`暂不支持删除该类型节点：${item.type}`);
        } catch (error) {
          vscode.window.showErrorMessage(`删除失败: ${toErrorMessage(error)}`);
        }
      }
    })
  );

  disposables.push(
    vscode.commands.registerCommand("cadb.datasource.expand", async (item) => {
      const children = await (item as Datasource).expand(provider.context);
      provider.createChildren(item as Datasource, children);
      treeView.reveal(item as Datasource, { expand: true });
    })
  );

  // 搜索数据源：Ctrl+F / Cmd+F 弹出 QuickPick，模糊匹配并定位到节点
  disposables.push(
    vscode.commands.registerCommand("cadb.datasource.search", async () => {
      const allNodes = provider.getFlattenedNodes();
      if (allNodes.length === 0) {
        vscode.window.showInformationMessage("暂无数据源节点可搜索，请先添加连接并刷新。");
        return;
      }
      interface SearchItem extends vscode.QuickPickItem {
        element: Datasource;
      }
      const allItems: SearchItem[] = allNodes.map((el) => {
        const label = el.label?.toString()?.trim() || "未命名";
        const description = provider.getReadablePath(el);
        return { label, description, element: el };
      });

      const qp = vscode.window.createQuickPick<SearchItem>();
      qp.placeholder = "输入关键词模糊搜索（连接 / 数据库 / 表…）";
      qp.matchOnDescription = true;
      qp.matchOnDetail = true;
      qp.items = allItems;

      qp.onDidChangeValue((value) => {
        if (!value.trim()) {
          qp.items = allItems;
          return;
        }
        const filtered = allItems.filter(
          (item) =>
            fuzzyMatch(value, item.label) || fuzzyMatch(value, item.description ?? "")
        );
        qp.items = filtered.length > 0 ? filtered : [{ label: "(无匹配)", element: allNodes[0] } as SearchItem];
      });

      qp.onDidAccept(() => {
        const picked = qp.selectedItems[0];
        qp.hide();
        if (picked && "element" in picked && picked.element && picked.label !== "(无匹配)") {
          treeView.reveal(picked.element, { expand: true, select: true, focus: true });
        }
      });

      qp.show();
    })
  );

  // 注册选择数据库/表命令
  disposables.push(
    vscode.commands.registerCommand(
      "cadb.datasource.filterEntry",
      async (item: Datasource) => {
        try {
          // 确保 item 是 datasourceType 或 collectionType 节点
          if (item.type !== "datasourceType" && item.type !== "collectionType") {
            return;
          }

          // 获取连接节点
          let connectionNode: Datasource | undefined = item.parent;
          if (item.type === "collectionType") {
            // 对于 collectionType，需要向上查找连接节点
            while (connectionNode && connectionNode.type !== "datasource") {
              connectionNode = connectionNode.parent;
            }
          }

          if (!connectionNode || !connectionNode.label) {
            vscode.window.showWarningMessage("无法找到连接信息");
            return;
          }

          const connectionName = connectionNode.label.toString();

          // 显示加载提示
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "正在加载列表...",
              cancellable: false,
            },
            async () => {
              if (item.type === "datasourceType") {
                // 处理数据库过滤
                const allDatabases = await item.expand(provider.context);
                if (allDatabases.length === 0) {
                  return;
                }
                // 获取当前已选择的数据库
                const currentSelected =
                  provider.getSelectedDatabases(connectionName);
                // 创建 QuickPick 项
                interface DatabaseQuickPickItem extends vscode.QuickPickItem {
                  database: string;
                }

                const quickPickItems: DatabaseQuickPickItem[] = allDatabases.map(
                  (db) => ({
                    label: db.label?.toString() || "",
                    description: db.description
                      ? typeof db.description === "string"
                        ? db.description
                        : db.description.toString()
                      : undefined,
                    database: db.label?.toString() || "",
                    picked: currentSelected.includes(db.label?.toString() || ""),
                  })
                );

                // 显示多选 QuickPick
                const selected = await vscode.window.showQuickPick(
                  quickPickItems,
                  {
                    placeHolder: `选择要显示的数据库（当前连接: ${connectionName}）`,
                    canPickMany: true,
                    matchOnDescription: true,
                  }
                );

                if (selected) {
                  const selectedDbs = selected.map((item) => item.database);
                  // 保存选择
                  provider.setSelectedDatabases(connectionName, selectedDbs);
                  // 清空 datasourceType 节点的子节点缓存，强制重新加载
                  item.children = [];
                  // 刷新 TreeView
                  provider.refresh();
                }
              } else if (item.type === "collectionType") {
                // 处理表过滤
                const databaseNode = item.parent;
                if (!databaseNode || !databaseNode.label) {
                  vscode.window.showWarningMessage("无法找到数据库信息");
                  return;
                }

                const databaseName = databaseNode.label.toString();
                const allTables = await item.expand(provider.context);
                if (allTables.length === 0) {
                  return;
                }

                // 获取当前已选择的表
                const currentSelected =
                  provider.getSelectedTables(connectionName, databaseName);

                // 创建 QuickPick 项
                interface TableQuickPickItem extends vscode.QuickPickItem {
                  table: string;
                }

                const quickPickItems: TableQuickPickItem[] = allTables.map(
                  (table) => ({
                    label: table.label?.toString() || "",
                    description: table.description
                      ? typeof table.description === "string"
                        ? table.description
                        : table.description.toString()
                      : undefined,
                    table: table.label?.toString() || "",
                    picked: currentSelected.includes(table.label?.toString() || ""),
                  })
                );

                // 显示多选 QuickPick
                const selected = await vscode.window.showQuickPick(
                  quickPickItems,
                  {
                    placeHolder: `选择要显示的表（数据库: ${databaseName}）`,
                    canPickMany: true,
                    matchOnDescription: true,
                  }
                );

                if (selected) {
                  const selectedTables = selected.map((item) => item.table);
                  // 保存选择
                  provider.setSelectedTables(connectionName, databaseName, selectedTables);
                  // 清空 collectionType 节点的子节点缓存，强制重新加载
                  item.children = [];
                  // 刷新 TreeView
                  provider.refresh();
                }
              }
            }
          );
        } catch (error) {
          console.error("[FilterEntry] 错误:", error);
          vscode.window.showErrorMessage(
            `选择列表项失败: ${error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    )
  );

  // 注册使用数据库命令（从 TreeView collection 节点）
  disposables.push(
    vscode.commands.registerCommand(
      "cadb.collection.useDatabase",
      (item: Datasource) => {
        try {
          // 确保 item 是 collection 节点
          if (item.type !== "collection") {
            vscode.window.showWarningMessage("请在数据库节点上执行此操作");
            return;
          }

          // 通过 databaseManager 设置当前数据库
          if (provider.databaseManager) {
            provider.databaseManager.setCurrentDatabase(item);
          } else {
            vscode.window.showErrorMessage("数据库管理器未初始化");
          }
        } catch (error) {
          console.error("[UseDatabase] 错误:", error);
          vscode.window.showErrorMessage(
            `切换数据库失败: ${error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    )
  );

  // 注册复制连接地址命令（仅连接地址：host:port）
  disposables.push(
    vscode.commands.registerCommand(
      "cadb.datasource.copyConnectionAddress",
      async (item: Datasource) => {
        try {
          if (item.type !== "datasource" || !item.data) {
            vscode.window.showWarningMessage("请在数据源节点上执行此操作");
            return;
          }

          const host = item.data.host || "localhost";
          const port = item.data.port || 3306;
          const address = `${host}:${port}`;

          await vscode.env.clipboard.writeText(address);
          vscode.window.showInformationMessage(`已复制连接地址: ${address}`);
        } catch (error) {
          vscode.window.showErrorMessage(
            `复制失败: ${error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    )
  );

  // 注册复制用户名密码命令（仅用户名密码：username@password）
  disposables.push(
    vscode.commands.registerCommand(
      "cadb.datasource.copyCredentials",
      async (item: Datasource) => {
        try {
          if (item.type !== "datasource" || !item.data) {
            vscode.window.showWarningMessage("请在数据源节点上执行此操作");
            return;
          }

          const username = item.data.username || "";
          const password = item.data.password || "";
          const credentials = `${username}@${password}`;

          await vscode.env.clipboard.writeText(credentials);
          vscode.window.showInformationMessage("已复制用户名密码");
        } catch (error) {
          vscode.window.showErrorMessage(
            `复制失败: ${error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    )
  );

  // 注册复制完整连接命令（JDBC URL）
  disposables.push(
    vscode.commands.registerCommand(
      "cadb.datasource.copyFullConnection",
      async (item: Datasource) => {
        try {
          if (item.type !== "datasource" || !item.data) {
            vscode.window.showWarningMessage("请在数据源节点上执行此操作");
            return;
          }

          const dbType = item.data.dbType || "mysql";
          const host = item.data.host || "localhost";
          const port = item.data.port || 3306;
          const username = item.data.username || "";
          const password = item.data.password || "";
          const database = item.data.database || "";

          let jdbcUrl = "";

          if (dbType === "mysql") {
            // MySQL JDBC URL: jdbc:mysql://host:port/database?user=username&password=password
            const params = new URLSearchParams();
            if (username) {
              params.append("user", username);
            }
            if (password) {
              params.append("password", password);
            }
            const queryString = params.toString();
            jdbcUrl = `jdbc:mysql://${host}:${port}${database ? `/${database}` : ""
              }${queryString ? `?${queryString}` : ""}`;
          } else if (dbType === "redis") {
            // Redis URL: redis://username:password@host:port
            if (username && password) {
              jdbcUrl = `redis://${username}:${password}@${host}:${port}`;
            } else if (password) {
              jdbcUrl = `redis://:${password}@${host}:${port}`;
            } else {
              jdbcUrl = `redis://${host}:${port}`;
            }
          } else {
            // 其他数据库类型，使用通用格式
            jdbcUrl = `${dbType}://${host}:${port}${database ? `/${database}` : ""
              }`;
          }

          await vscode.env.clipboard.writeText(jdbcUrl);
          vscode.window.showInformationMessage("已复制完整连接地址");
        } catch (error) {
          vscode.window.showErrorMessage(
            `复制失败: ${error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    )
  );

  disposables.push(
    vscode.commands.registerCommand("cadb.drivers.manage", async () => {
      const panel = createWebview(provider, "settings", "数据库驱动");
      const sendLoad = () => {
        panel.webview.postMessage({
          command: "load",
          configType: "drivers",
          drivers: getDriversManagementPayload(provider.context),
        });
      };
      sendLoad();
      panel.webview.onDidReceiveMessage(async (message) => {
        if (message.command === "setDriverEnabled") {
          const id = String((message as { id?: string }).id ?? "").trim();
          const enabled = !!(message as { enabled?: boolean }).enabled;
          if (!id) {
            return;
          }
          const r = await setDriverEnabled(provider.context, id, enabled);
          if (!r.ok) {
            postWebviewStatus(panel.webview, {
              success: false,
              message: r.message ?? "操作失败",
            });
          } else {
            postWebviewStatus(panel.webview, {
              success: true,
              message: enabled ? "✔️ 已安装（启用）驱动" : "✔️ 已卸载（停用）驱动",
            });
          }
          sendLoad();
        }
      });
    })
  );

  disposables.push(
    vscode.commands.registerCommand("cadb.connectionGroups.manage", async () => {
      const panel = createWebview(provider, "settings", "连接分组");
      const sendLoad = () => {
        panel.webview.postMessage({
          command: "load",
          configType: "connectionGroups",
          groups: getConnectionGroupsEditorLines(provider.context, provider.getConnections()),
        });
      };
      sendLoad();
      panel.webview.onDidReceiveMessage(async (message) => {
        if (message.command === "saveConnectionGroups") {
          const lines = Array.isArray((message as { groups?: unknown }).groups)
            ? (message as { groups: unknown[] }).groups.map((x) => String(x))
            : [];
          const prevStored = getStoredConnectionGroupsOrder(provider.context);
          const nextStored = normalizeConnectionGroupsOrderForSave(lines);
          const removed = getRemovedGroupsForMigration(prevStored, nextStored);
          if (removed.length > 0) {
            await provider.migrateConnectionsToDefaultForGroups(new Set(removed));
          }
          await setConnectionGroupsOrder(provider.context, nextStored);
          postWebviewStatus(panel.webview, {
            success: true,
            message: "✔️ 已保存连接分组",
          });
          provider.refresh();
          sendLoad();
        }
      });
    })
  );

  return disposables;
}

/** 已打开的表格数据面板：key = connectionName|databaseName|tableName，同一表只保留一个 */
const openTablePanels = new Map<string, vscode.WebviewPanel>();
/** 当前聚焦的表数据 WebviewPanel（用于快捷键切换侧栏） */
let lastActiveDatasourceTablePanel: vscode.WebviewPanel | undefined;

/** 与 package.json 中 Cmd/Ctrl+F 的 when 一致；勿用 activeWebviewPanelId==='datasourceTable'（扩展内多为带前缀的 viewType） */
const CONTEXT_DATASOURCE_TABLE_GRID_FOCUSED = "cadb.datasourceTableGridFocused";

function debugGridSidePanelShortcut(label: string, detail?: Record<string, unknown>) {
  try {
    const on = vscode.workspace
      .getConfiguration("cadb")
      .get<boolean>("grid.debugSidePanelShortcut", false);
    if (!on) {
      return;
    }
    const tail = detail && Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : "";
    console.log(`[CADB grid shortcut] ${label}${tail}`);
  } catch (_e) {
    /* ignore */
  }
}

/** 根据 openTablePanels 中 WebviewPanel.active 同步快捷键 when 上下文与 lastActive */
function refreshDatasourceTableGridFocusContext() {
  let activePanel: vscode.WebviewPanel | undefined;
  for (const p of openTablePanels.values()) {
    try {
      if (p.active) {
        activePanel = p;
        break;
      }
    } catch (_e) {
      /* 面板已 dispose */
    }
  }
  lastActiveDatasourceTablePanel = activePanel;
  void vscode.commands.executeCommand(
    "setContext",
    CONTEXT_DATASOURCE_TABLE_GRID_FOCUSED,
    !!activePanel
  );
  debugGridSidePanelShortcut("refreshFocusContext", {
    openPanels: openTablePanels.size,
    activeMatch: !!activePanel,
  });
}

/** Webview 内 window 获得焦点时调用（iframe/内部焦点有时不同步 panel.active） */
function markDatasourceTableGridDomFocused(panel: vscode.WebviewPanel) {
  let inMap = false;
  for (const p of openTablePanels.values()) {
    if (p === panel) {
      inMap = true;
      break;
    }
  }
  if (!inMap) {
    return;
  }
  lastActiveDatasourceTablePanel = panel;
  void vscode.commands.executeCommand("setContext", CONTEXT_DATASOURCE_TABLE_GRID_FOCUSED, true);
  debugGridSidePanelShortcut("gridPanelDomFocus");
}

function attachDatasourceTablePanelFocusTracking(panel: vscode.WebviewPanel) {
  panel.onDidChangeViewState(() => {
    refreshDatasourceTableGridFocusContext();
  });
}
/** 已打开的表结构编辑面板：key 同上，用于相互跳转 */
const openTableEditPanels = new Map<string, vscode.WebviewPanel>();

function getGridPageSize(): number {
  return vscode.workspace.getConfiguration("cadb").get<number>("grid.pageSize", 2000);
}

async function sqlResultView(
  datasource: Datasource,
  provider: DataSourceProvider,
  outputChannel: vscode.OutputChannel
) {
  const pageSize = getGridPageSize();
  const tableName = datasource.label?.toString() || "";
  const databaseName = datasource.parent?.parent?.label?.toString() || "";
  const connectionName =
    datasource.dataloader?.rootNode().label?.toString() || "";
  const panelKey = `${connectionName}|${databaseName}|${tableName}`;

  /** 与 AG Grid 列过滤 / 排序同步，用于 listData 生成 SQL */
  let lastFilterModel: Record<string, unknown> = {};
  let lastSortModel: ListDataSortCol[] = [];

  const logTableSql = (sql: string) => {
    const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    outputChannel.appendLine(`[${ts}] [表数据] ${databaseName}.${tableName}`);
    outputChannel.appendLine(sql.replace(/\s+/g, " ").trim());
  };

  const listOpts = (
    offset: number,
    limit: number,
    messageFilter?: Record<string, unknown> | null,
    messageSort?: ListDataSortCol[] | null
  ) => {
    if (messageFilter !== undefined) {
      lastFilterModel =
        messageFilter != null && typeof messageFilter === "object"
          ? { ...messageFilter }
          : {};
    }
    if (messageSort !== undefined) {
      lastSortModel = Array.isArray(messageSort)
        ? messageSort.filter(
            (s) =>
              s &&
              typeof s.colId === "string" &&
              (s.sort === "asc" || s.sort === "desc")
          )
        : [];
    }
    return {
      offset,
      limit,
      filterModel: lastFilterModel,
      sortModel: lastSortModel,
      sqlLogger: logTableSql,
    };
  };

  const data = await datasource.listData(listOpts(0, pageSize, {}, []));

  const postLoad = (payload: TableResult | null, offset: number, limit: number) =>
    payload
      ? {
          command: "load" as const,
          data: {
            ...payload,
            pageSize: limit,
            offset,
            connectionName,
            databaseName,
            tableName,
          },
        }
      : null;

  const existing = openTablePanels.get(panelKey);
  if (existing) {
    existing.reveal();
    setTimeout(() => refreshDatasourceTableGridFocusContext(), 0);
    setTimeout(() => {
      const msg = postLoad(data, 0, pageSize);
      if (msg) existing.webview.postMessage(msg);
    }, 150);
    return;
  }

  const panel = createWebview(
    provider,
    "datasourceTable",
    data?.title || "未命名页"
  );
  openTablePanels.set(panelKey, panel);
  panel.onDidDispose(() => {
    openTablePanels.delete(panelKey);
    if (lastActiveDatasourceTablePanel === panel) {
      lastActiveDatasourceTablePanel = undefined;
    }
    refreshDatasourceTableGridFocusContext();
  });
  attachDatasourceTablePanelFocusTracking(panel);

  panel.webview.onDidReceiveMessage(async (message) => {
    if (message.command === "gridPanelDomFocus") {
      markDatasourceTableGridDomFocused(panel);
      return;
    }
    if (message.command === "ready") {
      const limit = getGridPageSize();
      const freshData = await datasource.listData(
        listOpts(0, limit, message.filterModel, message.sortModel)
      );
      const msg = postLoad(freshData, 0, limit);
      if (msg) panel.webview.postMessage(msg);
      return;
    }
    if (message.command === "loadPage") {
      const offset = typeof message.offset === "number" ? message.offset : 0;
      const limit = getGridPageSize();
      const freshData = await datasource.listData(
        listOpts(offset, limit, message.filterModel, message.sortModel)
      );
      const msg = postLoad(freshData, offset, limit);
      if (msg) panel.webview.postMessage(msg);
      return;
    }
    if (message.command === "showMessage") {
      const msg = message.message ?? "";
      if (message.type === "error") {
        vscode.window.showErrorMessage(msg);
      } else {
        vscode.window.showWarningMessage(msg);
      }
      return;
    }
    if (message.command === "switchToTableEdit") {
      const conn = message.connectionName ?? connectionName;
      const db = message.databaseName ?? databaseName;
      const tbl = message.tableName ?? tableName;
      const tableDs = await resolveTableDatasource(provider, provider.context, conn, db, tbl);
      if (tableDs) editEntry(provider, tableDs, outputChannel);
      return;
    }
    if (message.command === "quickQuery") {
      const conn = message.connectionName ?? connectionName;
      const db = message.databaseName ?? databaseName;
      const tbl = message.tableName ?? tableName;
      if (conn && db && tbl) {
        vscode.commands.executeCommand("cadb.quickQuery", conn, db, tbl);
      }
      return;
    }
    switch (message.command) {
      case "save":
        try {
          const saveRows = Array.isArray(message.data) ? message.data : [];
          const deletedRows = Array.isArray(message.deleted) ? message.deleted : [];
          if (saveRows.length === 0 && deletedRows.length === 0) {
            panel.webview.postMessage({
              command: "status",
              success: false,
              message: "没有需要保存的数据",
            });
            return;
          }

          // 获取数据源配置
          const connectionData = provider
            .getConnections()
            .find((ds) => ds.name === connectionName);
          if (!connectionData) {
            panel.webview.postMessage({
              command: "status",
              success: false,
              message: "数据源不存在",
            });
            return;
          }

          // 创建数据源实例
          const dsInstance = await Datasource.createInstance(
            provider.getConnections(),
            provider.context,
            connectionData,
            false
          );

          if (!dsInstance.dataloader) {
            panel.webview.postMessage({
              command: "status",
              success: false,
              message: "无法创建数据库连接",
            });
            return;
          }

          // 主键字段：优先用前端上报的，否则从列定义取
          const primaryKeyField =
            message.primaryKeyField ||
            data?.columnDefs?.find((col: any) => col.key === "PRI")?.field ||
            "id";

          // 新增行：先把 original 复制到 updated，用户修改再覆盖；full 用合并结果供 INSERT 使用
          const normalizedRows = saveRows.map((r: { isNew?: boolean; original?: Record<string, any>; updated?: Record<string, any>; full?: Record<string, any>;[k: string]: any }) => {
            if (!r.isNew || (!r.original && !r.updated)) return r;
            const base = r.original || {};
            const overrides = r.updated || {};
            const merged = { ...base, ...overrides };
            return { ...r, updated: merged, full: merged };
          });

          const saveResult = await dsInstance.dataloader.saveData({
            tableName: tableName,
            databaseName: databaseName,
            primaryKeyField: primaryKeyField,
            rows: normalizedRows,
            deletedRows: deletedRows.map((r: { id: any }) => ({ id: r.id })),
          });

          if (saveResult.errorCount === 0) {
            const msg = `成功更新 ${saveResult.successCount} 行`;
            vscode.window.showInformationMessage(msg);
            if (saveResult.executedSql?.length) {
              const timestamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
              outputChannel.appendLine(`-- [${timestamp}] 表格保存 · ${databaseName}.${tableName}`);
              saveResult.executedSql.forEach((sql) => {
                outputChannel.appendLine(sql.replace(/\s+/g, " ").trim());
              });
              outputChannel.show(true);
            }
            panel.webview.postMessage({
              command: "status",
              success: true,
              message: msg,
            });
            const limit = getGridPageSize();
            const refreshedData = await datasource.listData(listOpts(0, limit, undefined, undefined));
            const loadMsg = postLoad(refreshedData, 0, limit);
            if (loadMsg) panel.webview.postMessage(loadMsg);
          } else {
            const errMsg = `更新完成：成功 ${saveResult.successCount} 行，失败 ${saveResult.errorCount} 行。${saveResult.errors.length > 0 ? saveResult.errors[0] : ""
              }`;
            panel.webview.postMessage({
              command: "status",
              success: false,
              message: errMsg,
            });
          }
        } catch (error) {
          console.error("保存失败:", error);
          const errMsg = `保存失败: ${error instanceof Error ? error.message : String(error)}`;
          vscode.window.showErrorMessage(errMsg);
          panel.webview.postMessage({
            command: "status",
            success: false,
            message: errMsg,
          });
        }
        break;
      case "refresh": {
        const offset = typeof message.offset === "number" ? message.offset : 0;
        const limit = getGridPageSize();
        const freshData = await datasource.listData(
          listOpts(offset, limit, message.filterModel, message.sortModel)
        );
        const loadMsg = postLoad(freshData, offset, limit);
        if (loadMsg) panel.webview.postMessage(loadMsg);
        break;
      }
    }
  });
}

async function keyValueResultView(
  datasource: Datasource,
  provider: DataSourceProvider
) {
  const key = datasource.label?.toString() || "";
  const dbNode = datasource.parent?.parent;
  const databaseName = dbNode?.label?.toString() || "";
  const connectionName = datasource.dataloader?.rootNode().label?.toString() || "";
  const panelKey = `${connectionName}|${databaseName}|${key}`;

  const existing = openTablePanels.get(panelKey);
  if (existing) {
    existing.reveal();
    setTimeout(() => refreshDatasourceTableGridFocusContext(), 0);
    const data = await datasource.listData();
    if (data) {
      setTimeout(() => {
        existing.webview.postMessage({ command: "load", data });
      }, 150);
    }
    return;
  }

  let data: Awaited<ReturnType<Datasource["listData"]>>;
  try {
    data = await datasource.listData();
  } catch (error) {
    vscode.window.showErrorMessage(
      `加载键值数据失败: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  if (!data?.columnDefs?.length) {
    vscode.window.showWarningMessage("暂无数据或暂不支持该类型");
    return;
  }

  const panel = createWebview(
    provider,
    "datasourceTable",
    data?.title || key || "键值数据"
  );
  openTablePanels.set(panelKey, panel);
  panel.onDidDispose(() => {
    openTablePanels.delete(panelKey);
    if (lastActiveDatasourceTablePanel === panel) {
      lastActiveDatasourceTablePanel = undefined;
    }
    refreshDatasourceTableGridFocusContext();
  });
  attachDatasourceTablePanelFocusTracking(panel);

  panel.webview.onDidReceiveMessage(async (message) => {
    if (message.command === "gridPanelDomFocus") {
      markDatasourceTableGridDomFocused(panel);
      return;
    }
    if (message.command === "ready") {
      const freshData = await datasource.listData();
      if (freshData) {
        panel.webview.postMessage({ command: "load", data: freshData });
      }
      return;
    }
    if (message.command === "showMessage") {
      const msg = message.message ?? "";
      if (message.type === "error") {
        vscode.window.showErrorMessage(msg);
      } else {
        vscode.window.showWarningMessage(msg);
      }
      return;
    }
    switch (message.command) {
      case "refresh": {
        const freshData = await datasource.listData();
        if (freshData) {
          panel.webview.postMessage({ command: "load", data: freshData });
        }
        break;
      }
      case "save": {
        const loader = datasource.dataloader as import("../entity/redis_dataloader").RedisDataloader;
        if (!loader?.saveKeyData) {
          panel.webview.postMessage({
            command: "status",
            success: false,
            message: "当前数据源不支持保存",
          });
          break;
        }
        const keyType =
          datasource.parent?.tooltip?.toString() ||
          datasource.parent?.label?.toString() ||
          "";
        const dbLabel = databaseName || "";
        const dbMatch = dbLabel.match(/^DB(\d+)$/i);
        const dbIndex = dbMatch ? parseInt(dbMatch[1], 10) : 0;
        const rows = Array.isArray(message.data) ? message.data : [];
        const changes = rows.map((r: any) => ({
          original: r.original || {},
          full: r.full || r.current || r,
        }));
        try {
          const result = await loader.saveKeyData({
            key,
            dbIndex,
            keyType,
            changes,
          });
          if (result.errorCount === 0) {
            const msg = `成功保存 ${result.successCount} 处修改`;
            vscode.window.showInformationMessage(msg);
            panel.webview.postMessage({
              command: "status",
              success: true,
              message: msg,
            });
            const freshData = await datasource.listData();
            if (freshData) {
              panel.webview.postMessage({ command: "load", data: freshData });
            }
          } else {
            const errMsg = `保存完成：成功 ${result.successCount}，失败 ${result.errorCount}。${result.errors[0] ?? ""}`;
            panel.webview.postMessage({
              command: "status",
              success: false,
              message: errMsg,
            });
          }
        } catch (err) {
          const errMsg = `保存失败: ${err instanceof Error ? err.message : String(err)}`;
          vscode.window.showErrorMessage(errMsg);
          panel.webview.postMessage({
            command: "status",
            success: false,
            message: errMsg,
          });
        }
        break;
      }
    }
  });
}

/** Redis Pub/Sub 面板：每个连接一个，用 connectionName 做 key */
const openRedisPubsubPanels = new Map<string, vscode.WebviewPanel>();

async function openRedisPubsubView(
  item: Datasource,
  provider: DataSourceProvider
) {
  if (item.type !== "datasource" || item.data?.dbType !== "redis") {
    vscode.window.showWarningMessage("Pub/Sub 仅支持 Redis 连接");
    return;
  }

  const connectionName = item.label?.toString() || "";
  const existing = openRedisPubsubPanels.get(connectionName);
  if (existing) {
    existing.reveal();
    return;
  }

  const panel = createWebview(
    provider,
    "redisPubsub",
    `Redis Pub/Sub - ${connectionName}`
  );
  openRedisPubsubPanels.set(connectionName, panel);

  let subscriberClient: RedisClientType | null = null;

  panel.onDidDispose(() => {
    openRedisPubsubPanels.delete(connectionName);
    if (subscriberClient?.isOpen) {
      subscriberClient.quit().catch(() => { });
      subscriberClient = null;
    }
  });

  const connectionData = provider.getConnections().find((c) => c.name === connectionName);
  if (!connectionData) {
    panel.webview.postMessage({ command: "status", success: false, message: "连接配置不存在" });
    return;
  }

  let loader: RedisDataloader | null = null;

  panel.webview.onDidReceiveMessage(async (message) => {
    if (message.command === "ready") {
      return;
    }

    if (!loader) {
      const ds = await Datasource.createInstance(
        provider.getConnections(),
        provider.context,
        connectionData,
        false
      );
      loader = ds.dataloader instanceof RedisDataloader ? (ds.dataloader as RedisDataloader) : null;
    }

    if (!loader) {
      panel.webview.postMessage({ command: "status", success: false, message: "无法创建 Redis 连接" });
      return;
    }

    try {
      if (message.command === "subscribe") {
        const channel = String(message.channel ?? "").trim();
        if (!channel) return;

        if (!subscriberClient) {
          subscriberClient = loader.duplicateClient();
          await subscriberClient.connect();
          subscriberClient.on("message", (ch: string, payload: string) => {
            if (panel.webview) {
              panel.webview.postMessage({ command: "message", channel: ch, payload });
            }
          });
        }

        await subscriberClient.subscribe(channel, (payload) => {
          if (panel.webview) {
            panel.webview.postMessage({ command: "message", channel, payload });
          }
        });
        panel.webview.postMessage({ command: "subscribed", channel });
      } else if (message.command === "unsubscribe") {
        const channel = String(message.channel ?? "").trim();
        if (subscriberClient && channel) {
          await subscriberClient.unsubscribe(channel);
          panel.webview.postMessage({ command: "unsubscribed", channel });
        }
      } else if (message.command === "publish") {
        const channel = String(message.channel ?? "").trim();
        const messagePayload = message.message ?? "";
        if (!channel) {
          panel.webview.postMessage({ command: "status", success: false, message: "请输入频道名" });
          return;
        }
        if (!loader.client.isOpen) await loader.client.connect();
        await loader.client.publish(channel, messagePayload);
        panel.webview.postMessage({ command: "status", success: true, message: "发布成功" });
      }
    } catch (err) {
      panel.webview.postMessage({
        command: "status",
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

export function registerDatasourceItemCommands(
  provider: DataSourceProvider,
  outputChannel: vscode.OutputChannel,
  databaseManager: DatabaseManager
) {
  vscode.commands.registerCommand("cadb.item.showData", async (args) => {
    const datasource = args as Datasource;
    const dbType = datasource.dataloader?.dbType() || "";
    if (dbType === "mysql") {
      await sqlResultView(datasource, provider, outputChannel);
    } else if (dbType === "redis") {
      await keyValueResultView(datasource, provider);
    } else if (dbType === "oss") {
      await ossPreview(datasource, provider);
    } else {
      vscode.window.showWarningMessage(`${dbType} 数据源查看数据功能待实现`);
    }
  });

  vscode.commands.registerCommand(
    "cadb.quickQuery",
    async (connectionName: string, databaseName: string, tableName: string) => {
      const escapeTable = (s: string) => "`" + String(s).replace(/`/g, "``") + "`";
      const baseSql = `SELECT * FROM ${escapeTable(tableName)} LIMIT 100`;

      await databaseManager.setActiveDatabase(connectionName, databaseName);

      const connDir = provider.getConnectionFilesDirUri(connectionName);

      const appendToFile = async (uri: vscode.Uri) => {
        const ext = uri.fsPath.toLowerCase().endsWith(".jsql") ? "jsql" : "sql";
        if (ext === "jsql") {
          const nbOpen = vscode.workspace.notebookDocuments.find(
            (n) => n.uri.fsPath.toLowerCase() === uri.fsPath.toLowerCase()
          );
          if (nbOpen) {
            const edit = new vscode.WorkspaceEdit();
            const newCell = new vscode.NotebookCellData(
              vscode.NotebookCellKind.Code,
              baseSql,
              "sql"
            );
            edit.set(uri, [
              vscode.NotebookEdit.insertCells(nbOpen.cellCount, [newCell]),
              vscode.NotebookEdit.updateNotebookMetadata({
                ...nbOpen.metadata,
                datasource: connectionName,
                database: databaseName,
              }),
            ]);
            await vscode.workspace.applyEdit(edit);
            const lastIdx = nbOpen.cellCount - 1;
            await vscode.window.showNotebookDocument(nbOpen, {
              selections: [new vscode.NotebookRange(lastIdx, lastIdx + 1)],
              preview: false,
            });
            setTimeout(() => vscode.commands.executeCommand("notebook.cell.edit"), 100);
          } else {
            const buf = await vscode.workspace.fs.readFile(uri);
            const raw = JSON.parse(new TextDecoder().decode(buf)) as {
              datasource?: string;
              database?: string;
              cells?: { sql: string }[];
            };
            if (!raw.cells) raw.cells = [];
            raw.cells.push({ sql: baseSql });
            raw.datasource = connectionName;
            raw.database = databaseName;
            await vscode.workspace.fs.writeFile(
              uri,
              Buffer.from(JSON.stringify(raw, null, 2), "utf-8")
            );
            const nb = await vscode.workspace.openNotebookDocument(uri);
            const lastIdx = Math.max(0, nb.cellCount - 1);
            await vscode.window.showNotebookDocument(nb, {
              selections: [new vscode.NotebookRange(lastIdx, lastIdx + 1)],
              preview: false,
            });
            setTimeout(() => vscode.commands.executeCommand("notebook.cell.edit"), 150);
          }
        } else {
          const docOpen = vscode.workspace.textDocuments.find(
            (d) => d.uri.fsPath.toLowerCase() === uri.fsPath.toLowerCase()
          );
          if (docOpen) {
            const lastLine = Math.max(0, docOpen.lineCount - 1);
            const pos = new vscode.Position(lastLine, docOpen.lineAt(lastLine).text.length);
            const edit = new vscode.WorkspaceEdit();
            edit.insert(uri, pos, `\n\n${baseSql}\n`);
            await vscode.workspace.applyEdit(edit);
            const endLineIdx = docOpen.lineCount - 1;
            const endPos = new vscode.Position(
              endLineIdx,
              docOpen.lineAt(endLineIdx).text.length
            );
            const editor = await vscode.window.showTextDocument(docOpen, {
              viewColumn: vscode.ViewColumn.Active,
              selection: new vscode.Range(endPos, endPos),
            });
            editor.revealRange(new vscode.Range(endPos, endPos), vscode.TextEditorRevealType.InCenter);
          } else {
            const buf = await vscode.workspace.fs.readFile(uri);
            const text = new TextDecoder().decode(buf);
            const lines = text.split(/\r?\n/);
            const lastLine = Math.max(0, lines.length - 1);
            const lastLineLen = lines[lastLine]?.length ?? 0;
            const edit = new vscode.WorkspaceEdit();
            edit.insert(uri, new vscode.Position(lastLine, lastLineLen), `\n\n${baseSql}\n`);
            await vscode.workspace.applyEdit(edit);
            const doc = await vscode.workspace.openTextDocument(uri);
            const endLineIdx = doc.lineCount - 1;
            const endPos = new vscode.Position(endLineIdx, doc.lineAt(endLineIdx).text.length);
            const editor = await vscode.window.showTextDocument(doc, {
              viewColumn: vscode.ViewColumn.Active,
              selection: new vscode.Range(endPos, endPos),
            });
            editor.revealRange(new vscode.Range(endPos, endPos), vscode.TextEditorRevealType.InCenter);
          }
        }
      };

      let entries: [string, vscode.FileType][] = [];
      try {
        entries = await vscode.workspace.fs.readDirectory(connDir);
      } catch {
        await vscode.workspace.fs.createDirectory(connDir);
      }

      const allFiles = entries.filter(
        ([name]) =>
          name.toLowerCase().endsWith(".jsql") || name.toLowerCase().endsWith(".sql")
      );

      const queryFiles: { label: string; description: string; value: vscode.Uri }[] = [];
      for (const [name] of allFiles) {
        if (name.toLowerCase().endsWith(".jsql")) {
          try {
            const uri = vscode.Uri.joinPath(connDir, name);
            const buf = await vscode.workspace.fs.readFile(uri);
            const raw = JSON.parse(new TextDecoder().decode(buf)) as {
              datasource?: string;
              database?: string;
            };
            if (
              String(raw.datasource || "").trim() === connectionName &&
              String(raw.database || "").trim() === databaseName
            ) {
              queryFiles.push({
                label: `$(file-code) ${name}`,
                description: name,
                value: uri,
              });
            }
          } catch {
            // 解析失败则跳过
          }
        } else {
          queryFiles.push({
            label: `$(file-code) ${name}`,
            description: name,
            value: vscode.Uri.joinPath(connDir, name),
          });
        }
      }
      queryFiles.sort((a, b) => a.description.localeCompare(b.description));

      const newJsqlItem = {
        label: "$(add) 新建查询",
        description: "在本连接下新建 .jsql",
        value: "__new_jsql__" as const,
      };
      const newSqlItem = {
        label: "$(add) 新建 SQL 文件",
        description: "在本连接下新建 .sql",
        value: "__new_sql__" as const,
      };

      const items = [newJsqlItem, newSqlItem, ...queryFiles];

      const choice = await vscode.window.showQuickPick(items, {
        placeHolder: `选择要追加查询的文件（${connectionName} / ${databaseName}）`,
      });
      if (!choice) return;

      if (choice.value === "__new_jsql__") {
        const dayjs = require("dayjs");
        const filename = dayjs().format("YYYYMMDDHHmmss") + ".jsql";
        const uri = vscode.Uri.joinPath(connDir, filename);
        const content = JSON.stringify(
          {
            datasource: connectionName,
            database: databaseName,
            cells: [{ sql: baseSql }],
          },
          null,
          2
        );
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf-8"));
        const nb = await vscode.workspace.openNotebookDocument(uri);
        await vscode.window.showNotebookDocument(nb, {
          selections: [new vscode.NotebookRange(0, 1)],
          preview: false,
        });
        setTimeout(() => {
          vscode.commands.executeCommand("notebook.cell.edit");
        }, 200);
        provider.refresh();
      } else if (choice.value === "__new_sql__") {
        const dayjs = require("dayjs");
        const filename = dayjs().format("YYYYMMDDHHmmss") + ".sql";
        const uri = vscode.Uri.joinPath(connDir, filename);
        const content = `-- ${connectionName} / ${databaseName}\n${baseSql}\n`;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf-8"));
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        provider.refresh();
      } else {
        await appendToFile(choice.value as vscode.Uri);
      }
    }
  );

  vscode.commands.registerCommand("cadb.oss.download", async (args) => {
    const node = args as Datasource;
    const loader = node.dataloader as OssDataLoader | undefined;
    const info = getOssBucketAndKey(node);
    if (!loader || !info) {
      vscode.window.showWarningMessage("仅支持 OSS 节点下载");
      return;
    }
    const { bucket, key } = info;
    if (node.type === "folder") {
      let list = await loader.listObjectsWithPrefix(bucket, key);
      list = list.filter((o) => o.Key && o.Key !== key && !o.Key.endsWith("/"));
      if (list.length === 0) {
        vscode.window.showInformationMessage("该文件夹为空");
        return;
      }
      const dirUri = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        title: "选择保存目录",
      });
      if (!dirUri?.length) return;
      const baseDir = dirUri[0];
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "下载 OSS 文件夹",
          cancellable: false,
        },
        async () => {
          for (const obj of list) {
            if (!obj.Key) continue;
            const buf = await loader.getObject(bucket, obj.Key);
            const relPath = obj.Key.slice(key.length).replace(/^\/+/, "") || obj.Key.split("/").pop() || "file";
            const fileUri = vscode.Uri.joinPath(baseDir, relPath);
            const parts = relPath.split("/").filter(Boolean);
            if (parts.length > 1) {
              const dir = vscode.Uri.joinPath(baseDir, ...parts.slice(0, -1));
              try {
                await vscode.workspace.fs.createDirectory(dir);
              } catch {
                // 父目录可能已存在
              }
            }
            await vscode.workspace.fs.writeFile(fileUri, buf);
          }
        }
      );
      vscode.window.showInformationMessage(`已下载 ${list.length} 个文件`);
      return;
    }
    const defaultName = key.split("/").pop() || "download";
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(
        vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.env.HOME || ""),
        defaultName
      ),
      title: "保存 OSS 文件",
    });
    if (!uri) return;
    try {
      const buf = await loader.getObject(bucket, key);
      await vscode.workspace.fs.writeFile(uri, buf);
      vscode.window.showInformationMessage("下载完成");
    } catch (e) {
      vscode.window.showErrorMessage(
        `下载失败: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  });

  vscode.commands.registerCommand("cadb.oss.cache.clear", async () => {
    const cacheDir = vscode.Uri.joinPath(
      provider.context.globalStorageUri,
      "cadb-oss-preview"
    );
    try {
      await vscode.workspace.fs.delete(cacheDir, { recursive: true });
    } catch (e) {
      const err = e as { code?: string };
      if (err?.code !== "FileNotFound" && err?.code !== "ENOENT") {
        vscode.window.showErrorMessage(
          `清除失败: ${e instanceof Error ? e.message : String(e)}`
        );
        return;
      }
    }
    vscode.window.showInformationMessage("OSS 临时缓存已清除");
  });

  vscode.commands.registerCommand("cadb.redis.pubsub", async (args) => {
    const item = args as Datasource;
    await openRedisPubsubView(item, provider);
  });

  // 注册打开 SQL 文件命令
  vscode.commands.registerCommand("cadb.file.open", async (args) => {
    const fileItem = args as Datasource;
    if (!fileItem || !fileItem.parent || !fileItem.parent.label) {
      vscode.window.showErrorMessage("无法打开文件：缺少必要信息");
      return;
    }

    // 构建文件路径（随数据源保存位置：工作区 .cadb/连接名 或 globalStorage/连接名）
    const fileName = fileItem.label?.toString() || "";
    const connDir = provider.getConnectionFilesDirUri(
      fileItem.parent.label?.toString() || ""
    );
    const dsPath = vscode.Uri.joinPath(connDir, fileName);

    try {
      // 判断文件扩展名是否为 .jsql
      if (fileName.toLowerCase().endsWith(".jsql")) {
        // 查找文件所属的数据库节点
        // 文件结构: datasource -> datasourceType -> collection -> collectionType -> fileType -> file
        // 或: datasource -> datasourceType -> collection -> fileType -> file
        const databaseNode =
          fileItem.parent && findAncestorByType(fileItem.parent, "collection");

        // 使用 SQL Notebook 方式打开
        const notebookDocument = await vscode.workspace.openNotebookDocument(
          dsPath
        );
        await vscode.window.showNotebookDocument(notebookDocument, {
          preview: false,
          viewColumn: vscode.ViewColumn.Active,
        });

        // 如果找到了数据库节点，自动设置数据库（静默模式）
        if (databaseNode && databaseManager) {
          databaseManager.setCurrentDatabase(databaseNode, true);
        }
      } else {
        // 使用普通文本编辑器打开
        const doc = await vscode.workspace.openTextDocument(dsPath);
        await vscode.window.showTextDocument(doc, {
          preview: false,
          viewColumn: vscode.ViewColumn.Active,
        });
      }
    } catch (error) {
      vscode.window.showErrorMessage(`打开文件失败: ${error}`);
    }
  });

  // 注册重命名 SQL 文件命令
  vscode.commands.registerCommand("cadb.file.rename", async (args) => {
    const filePath = validateAndGetFilePath(args, "重命名");
    if (!filePath) {
      return;
    }
    const fileItem = args as Datasource;

    try {
      const currentName = fileItem.label?.toString() || "";
      const newName = await vscode.window.showInputBox({
        prompt: "输入新文件名",
        value: currentName,
        validateInput: (value) => {
          if (!value || value.trim() === "") {
            return "文件名不能为空";
          }
          if (value.includes("/") || value.includes("\\")) {
            return "文件名不能包含路径分隔符";
          }
          return null;
        },
      });

      if (!newName || newName === currentName) {
        return; // 用户取消或未修改
      }

      // 原文件后缀；若用户输入未带后缀则自动补上
      const originalExt = path.extname(currentName) || path.extname(filePath);
      const trimmedNew = newName.trim();
      const finalName = path.extname(trimmedNew) ? trimmedNew : trimmedNew + (originalExt ? (trimmedNew.endsWith(".") ? originalExt.slice(1) : originalExt) : "");

      const fileUri = vscode.Uri.file(filePath);
      const dirUri = vscode.Uri.file(path.dirname(filePath));
      const newFileUri = vscode.Uri.joinPath(dirUri, finalName);

      // 检查新文件名是否已存在
      try {
        await vscode.workspace.fs.stat(newFileUri);
        vscode.window.showErrorMessage(`文件 "${finalName}" 已存在`);
        return;
      } catch (e) {
        // 文件不存在，可以重命名
      }

      // 重命名文件
      await vscode.workspace.fs.rename(fileUri, newFileUri, {
        overwrite: false,
      });

      vscode.window.showInformationMessage(`文件已重命名为 "${finalName}"`);

      // 刷新父节点以更新文件列表
      if (fileItem.parent) {
        provider.refresh(fileItem.parent);
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `重命名文件失败: ${error instanceof Error ? error.message : String(error)
        }`
      );
    }
  });

  // 注册删除 SQL 文件命令
  vscode.commands.registerCommand("cadb.file.delete", async (args) => {
    const filePath = validateAndGetFilePath(args, "删除");
    if (!filePath) {
      return;
    }
    const fileItem = args as Datasource;

    const fileName = fileItem.label?.toString() || "";
    const confirm = await vscode.window.showWarningMessage(
      `确定要删除文件 "${fileName}" 吗？此操作无法撤销。`,
      { modal: true },
      "删除",
      "取消"
    );

    if (confirm !== "删除") {
      return; // 用户取消
    }

    try {
      const fileUri = vscode.Uri.file(filePath);
      await vscode.workspace.fs.delete(fileUri, {
        recursive: false,
        useTrash: true,
      });

      vscode.window.showInformationMessage(`文件 "${fileName}" 已删除`);

      // 刷新父节点以更新文件列表
      if (fileItem.parent) {
        provider.refresh(fileItem.parent);
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `删除文件失败: ${error instanceof Error ? error.message : String(error)
        }`
      );
    }
  });

  // 注册执行 SQL 文件命令
  vscode.commands.registerCommand("cadb.file.execute", async (args) => {
    const filePath = validateAndGetFilePath(args, "执行");
    if (!filePath) {
      return;
    }
    const fileItem = args as Datasource;

    try {
      // 步骤 1: 读取 SQL 文件内容
      const fileUri = vscode.Uri.file(filePath);
      const fileContent = await vscode.workspace.fs.readFile(fileUri);
      const sqlContent = Buffer.from(fileContent).toString("utf-8");

      if (!sqlContent.trim()) {
        vscode.window.showWarningMessage("SQL 文件为空");
        return;
      }

      // 步骤 2: 选择数据源和数据库
      const selectedConnection = await databaseManager.selectConnection();
      if (!selectedConnection) {
        return; // 用户取消
      }

      const selectedDatabase =
        await databaseManager.selectDatabaseFromConnection(selectedConnection);
      if (!selectedDatabase) {
        return; // 用户取消
      }

      // 步骤 3: 执行 SQL（带事务）
      await executeSqlFileWithTransaction(
        sqlContent,
        selectedConnection,
        selectedDatabase,
        outputChannel,
        provider
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `执行 SQL 文件失败: ${error instanceof Error ? error.message : String(error)
        }`
      );
    }
  });
}

/**
 * 执行 SQL 文件（带事务支持）
 */
async function executeSqlFileWithTransaction(
  sqlContent: string,
  connection: Datasource,
  database: Datasource,
  outputChannel: vscode.OutputChannel,
  provider: DataSourceProvider
): Promise<void> {
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "正在执行 SQL 文件...",
      cancellable: false,
    },
    async () => {
      // 创建数据源实例
      const connectionData = provider
        .getConnections()
        .find((ds) => ds.name === connection.label?.toString());
      if (!connectionData) {
        throw new Error("数据源不存在");
      }

      const datasource = await Datasource.createInstance(
        provider.getConnections(),
        provider.context,
        connectionData,
        false
      );

      if (!datasource.dataloader) {
        throw new Error("无法创建数据库连接");
      }

      // 获取连接
      let connectionObj = datasource.dataloader.getConnection();
      if (!connectionObj) {
        await datasource.dataloader.connect();
        connectionObj = datasource.dataloader.getConnection();
        if (!connectionObj) {
          throw new Error("无法获取数据库连接");
        }
      }

      const databaseName = database.label?.toString() || "";
      const timestamp = formatTimestamp(new Date());

      // 切换到指定数据库
      await new Promise<void>((resolve, reject) => {
        connectionObj.changeUser({ database: databaseName }, (err: any) => {
          if (err) {
            const errorMsg = `[${timestamp} ${databaseName}, ERROR] ${err.message}`;
            outputChannel.appendLine(errorMsg);
            outputChannel.show(true);
            return reject(err);
          }
          resolve();
        });
      });

      // 分割 SQL 语句（按分号分割，但要注意字符串中的分号）
      const sqlStatements = splitSqlStatements(sqlContent);

      // 开始事务
      outputChannel.appendLine(`[${timestamp} ${databaseName}] 开始事务`);
      outputChannel.show(true);

      await new Promise<void>((resolve, reject) => {
        connectionObj.query("START TRANSACTION", (err: any) => {
          if (err) {
            const errorMsg = `[${timestamp} ${databaseName}, ERROR] 开始事务失败: ${err.message}`;
            outputChannel.appendLine(errorMsg);
            outputChannel.show(true);
            return reject(err);
          }
          resolve();
        });
      });

      let executedCount = 0;
      let errorOccurred = false;
      let errorMessage = "";

      const cadbCfg = vscode.workspace.getConfiguration("cadb");
      const autoLimit = cadbCfg.get<boolean>("query.autoAppendSelectLimit", true);
      const limitRows = cadbCfg.get<number>("grid.pageSize", 2000);

      // 执行每个 SQL 语句
      for (const sql of sqlStatements) {
        const trimmedSql = sql.trim();
        if (!trimmedSql) {
          continue; // 跳过空语句
        }

        const toRun = autoLimit ? ensureSelectRowLimit(trimmedSql, limitRows) : trimmedSql;

        const statementTimestamp = formatTimestamp(new Date());
        const startTime = Date.now();

        // 显示正在执行的语句
        const sqlOneLine = toRun.replace(/\s+/g, " ").trim();
        outputChannel.appendLine(
          `[${statementTimestamp} ${databaseName}] 执行: ${sqlOneLine}`
        );
        outputChannel.show(true);

        try {
          await new Promise<void>((resolve, reject) => {
            connectionObj.query(toRun, (error: any, results: any) => {
              const executionTime = (Date.now() - startTime) / 1000;
              const spendTime =
                executionTime < 0.001
                  ? "<0.001s"
                  : `${executionTime.toFixed(3)}s`;

              if (error) {
                const errorMsg = `[${statementTimestamp} ${databaseName}, ERROR] ${error.message} - ${sqlOneLine}`;
                outputChannel.appendLine(errorMsg);
                outputChannel.show(true);
                errorOccurred = true;
                errorMessage = error.message;
                return reject(error);
              }

              // 成功日志
              const rowCount = Array.isArray(results)
                ? results.length
                : results.affectedRows || 0;
              const logMsg = `[${statementTimestamp} ${databaseName}, ${spendTime}] (${rowCount} rows) ${sqlOneLine}`;
              outputChannel.appendLine(logMsg);
              outputChannel.show(true);

              executedCount++;
              resolve();
            });
          });
        } catch (error) {
          // 发生错误，跳出循环
          break;
        }
      }

      // 根据执行结果提交或回滚
      const finalTimestamp = formatTimestamp(new Date());
      if (errorOccurred) {
        // 回滚事务
        outputChannel.appendLine(
          `[${finalTimestamp} ${databaseName}] 发生错误，回滚事务`
        );
        outputChannel.show(true);

        await new Promise<void>((resolve, reject) => {
          connectionObj.query("ROLLBACK", (err: any) => {
            if (err) {
              const errorMsg = `[${finalTimestamp} ${databaseName}, ERROR] 回滚失败: ${err.message}`;
              outputChannel.appendLine(errorMsg);
              outputChannel.show(true);
              return reject(err);
            }
            const rollbackMsg = `[${finalTimestamp} ${databaseName}] 事务已回滚`;
            outputChannel.appendLine(rollbackMsg);
            outputChannel.show(true);
            resolve();
          });
        });

        vscode.window.showErrorMessage(
          `SQL 执行失败: ${errorMessage}。已回滚所有更改。`
        );
      } else {
        // 提交事务
        outputChannel.appendLine(
          `[${finalTimestamp} ${databaseName}] 提交事务`
        );
        outputChannel.show(true);

        await new Promise<void>((resolve, reject) => {
          connectionObj.query("COMMIT", (err: any) => {
            if (err) {
              const errorMsg = `[${finalTimestamp} ${databaseName}, ERROR] 提交失败: ${err.message}`;
              outputChannel.appendLine(errorMsg);
              outputChannel.show(true);
              return reject(err);
            }
            const commitMsg = `[${finalTimestamp} ${databaseName}] 事务已提交 (共执行 ${executedCount} 条语句)`;
            outputChannel.appendLine(commitMsg);
            outputChannel.show(true);
            resolve();
          });
        });

        vscode.window.showInformationMessage(
          `SQL 执行成功！共执行 ${executedCount} 条语句。`
        );
      }
    }
  );
}

/**
 * 分割 SQL 语句（按分号分割，但忽略字符串中的分号）
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let currentStatement = "";
  let inString = false;
  let stringChar = "";
  let i = 0;

  while (i < sql.length) {
    const char = sql[i];
    const nextChar = i + 1 < sql.length ? sql[i + 1] : "";

    // 处理字符串
    if (!inString && (char === "'" || char === '"' || char === "`")) {
      inString = true;
      stringChar = char;
      currentStatement += char;
    } else if (inString && char === stringChar) {
      // 检查是否是转义的引号
      if (nextChar === stringChar) {
        currentStatement += char + nextChar;
        i++; // 跳过下一个字符
      } else {
        inString = false;
        stringChar = "";
        currentStatement += char;
      }
    } else if (char === ";" && !inString) {
      // 遇到分号且不在字符串中，结束当前语句
      statements.push(currentStatement.trim());
      currentStatement = "";
    } else {
      currentStatement += char;
    }
    i++;
  }

  // 添加最后一个语句（如果有）
  if (currentStatement.trim()) {
    statements.push(currentStatement.trim());
  }

  return statements.filter((stmt) => stmt.length > 0);
}

/**
 * 格式化时间戳
 */
function formatTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export function registerDatabaseCommands(databaseManager: DatabaseManager) {
  // 创建数据库选择器（不再显示状态栏）
  const databaseSelector = new DatabaseSelector(databaseManager);

  // 注册数据库选择命令（用于 Notebook 工具栏）
  vscode.commands.registerCommand("cadb.sql.selectDatabase", () =>
    databaseManager.selectDatabase()
  );

  // 返回 selector 以便在 extension.ts 中注册到 subscriptions
  return databaseSelector;
}

export function registerResultCommands(resultProvider: ResultWebviewProvider) {
  // 注册显示结果命令
  vscode.commands.registerCommand(
    "cadb.result.show",
    (result: any, sql: string) => resultProvider.showResult(result, sql)
  );

  // 注册显示错误命令
  vscode.commands.registerCommand(
    "cadb.result.showError",
    (error: string, sql: string) => resultProvider.showError(error, sql)
  );
}

/** 表数据网格：快捷键切换右侧字段侧栏（由 package.json 绑定 Cmd/Ctrl+F） */
export function registerGridSidePanelCommand(): vscode.Disposable {
  void vscode.commands.executeCommand("setContext", CONTEXT_DATASOURCE_TABLE_GRID_FOCUSED, false);

  return vscode.commands.registerCommand("cadb.grid.toggleSidePanel", () => {
    debugGridSidePanelShortcut("toggleSidePanel invoked");

    let p: vscode.WebviewPanel | undefined;
    for (const cand of openTablePanels.values()) {
      try {
        if (cand.active) {
          p = cand;
          break;
        }
      } catch (_e) {
        /* disposed */
      }
    }
    p ??= lastActiveDatasourceTablePanel;

    if (!p?.webview) {
      debugGridSidePanelShortcut("no target panel");
      return;
    }
    let stillOpen = false;
    for (const v of openTablePanels.values()) {
      if (v === p) {
        stillOpen = true;
        break;
      }
    }
    if (!stillOpen) {
      lastActiveDatasourceTablePanel = undefined;
      void vscode.commands.executeCommand("setContext", CONTEXT_DATASOURCE_TABLE_GRID_FOCUSED, false);
      return;
    }
    void p.webview.postMessage({ command: "toggleSidePanel" });
    debugGridSidePanelShortcut("postMessage toggleSidePanel");
  });
}

/**
 * 注册 Book (SQL Notebook) 面板命令
 */
