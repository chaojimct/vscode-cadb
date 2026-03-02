import * as vscode from "vscode";
import { DataSourceProvider } from "../database_provider";
import { Datasource } from "../entity/datasource";
import path from "path";
import { FormResult } from "../entity/dataloader";
import { MySQLDataloader } from "../entity/mysql_dataloader";
import { DatabaseManager } from "./database_manager";
import { ResultWebviewProvider } from "../result_provider";
import { DatabaseSelector } from "./database_selector";
import { createWebview } from "../webview_helper";

/**
 * 将 unknown 错误转换为可展示的消息文本
 */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 模糊匹配：pattern 的字符按顺序出现在 text 中即视为匹配（忽略大小写）
 */
function fuzzyMatch(pattern: string, text: string): boolean {
  if (!pattern.trim()) return true;
  const p = pattern.toLowerCase().trim();
  const t = text.toLowerCase();
  let i = 0;
  for (let j = 0; j < t.length && i < p.length; j++) {
    if (t[j] === p[i]) i++;
  }
  return i === p.length;
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
  await Datasource.createInstance(
    provider.getConnections(),
    provider.context,
    payload,
    true
  );
}

/**
 * 编辑数据源时的保存入口（按 dbType 分发）
 */
async function saveDatasourceConfigForEdit(
  provider: DataSourceProvider,
  item: Datasource,
  payload: any
): Promise<void> {
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
    if (dbType !== "mysql") {
      vscode.window.showWarningMessage("当前仅支持 MySQL 数据库编辑");
      return;
    }
    panel = createWebview(provider, "settings", `【${item.label}】编辑`);
    configType = "database";
  } else if (
    item.type === "document" ||
    item.type === "field" ||
    item.type === "index"
  ) {
    const tableEditPanel = createWebview(
      provider,
      "tableEdit",
      `【${item.label}】编辑`
    );
    // tableEdit: 先注册消息监听，等 webview 发 ready 后再加载表结构
    tableEditPanel.webview.onDidReceiveMessage(async (message) => {
      const tableNode =
        item.type === "document"
          ? item
          : findAncestorByType(item, "document");
      if (!tableNode?.dataloader) {
        tableEditPanel.webview.postMessage({
          command: "status",
          success: false,
          message: "无法获取表结构",
        });
        return;
      }

      if (message.command === "ready") {
        try {
          const data = await tableNode.dataloader.descTable(tableNode);
          tableEditPanel.webview.postMessage({
            command: "load",
            configType: "",
            data: data,
          });
        } catch (error) {
          console.error("加载表结构失败:", error);
          tableEditPanel.webview.postMessage({
            command: "status",
            success: false,
            message: `加载失败: ${
              error instanceof Error ? error.message : String(error)
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
      `加载编辑数据失败: ${
        error instanceof Error ? error.message : String(error)
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
  const connections = provider.getConnections();
  const index = connections.findIndex(
    (conn) => conn.name === item.label?.toString()
  );

  if (index === -1) {
    throw new Error("未找到要更新的连接配置");
  }

  // 更新配置数据
  connections[index] = {
    type: "datasource",
    name: payload.name,
    tooltip: `${payload.dbType}://${payload.host}:${payload.port}`,
    dbType: payload.dbType,
    host: payload.host,
    port: payload.port,
    username: payload.username,
    password: payload.password,
    database: payload.database,
  };

  // 保存到全局状态
  await provider.context.globalState.update("cadb.connections", connections);

  // 刷新视图
  provider.refresh();
}

async function saveOssDatasourceConfig(
  provider: DataSourceProvider,
  payload: any,
  options: { originalName?: string }
): Promise<void> {
  console.log(payload);
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

async function addEntry(item: any, provider: DataSourceProvider) {
  if (item && item.type === "datasourceType") {
    const dataloader = (item as Datasource).dataloader;
    if (!dataloader) {
      return;
    }

    const collations = await dataloader.listCollations(item);
    const options = collations.map((c) => ({
      label: c.label?.toString() || "",
      value: c.label?.toString() || "",
    }));

    const panel = createWebview(provider, "settings", "创建数据库");

    // 直接发送初始化数据（页面加载时会自动处理）
    panel.webview.postMessage({
      command: "load",
      configType: "database",
      data: {}, // 新建数据库，使用空数据
      options: { collation: options },
    });

    // 监听来自 webview 的消息
    panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "save":
          try {
            const databaseName = message.payload.name;
            await dataloader.createDatabase(message.payload);
            panel.webview.postMessage({
              command: "status",
              success: true,
              message: "✔️ 数据库创建成功",
            });
            setTimeout(() => panel.dispose(), 1000);

            // 刷新数据库列表
            provider.refresh(item);

            // 等待刷新完成后，找到新创建的数据库节点并加载其子节点
            setTimeout(async () => {
              try {
                // 重新展开 datasourceType 节点以获取最新的数据库列表
                const databases = await item.expand(provider.context);
                item.children = databases || [];

                // 找到新创建的数据库节点
                const newDatabase = item.children.find(
                  (db: Datasource) => db.label?.toString() === databaseName
                );

                if (newDatabase && newDatabase.type === "collection") {
                  // 加载新数据库的子节点（表），这会更新 description 为表数量
                  await provider.loadCollectionChildren(newDatabase);
                }
              } catch (err) {
                // 忽略错误，不影响主流程
                console.error("加载新数据库子节点失败:", err);
              }
            }, 500);
          } catch (error) {
            panel.webview.postMessage({
              command: "status",
              success: false,
              message: `❗ 创建失败: ${
                error instanceof Error ? error.message : String(error)
              }`,
            });
          }
          break;
        case "cancel":
          panel.dispose();
          break;
      }
    });
    return;
  }

  if (item instanceof Datasource) {
    await item.create(provider.context, provider.databaseManager);
    provider.refresh();
  } else {
    const panel = createWebview(provider, "settings", "数据库连接配置");
    // 发送初始化消息，指定为 datasource 类型的新建模式
    panel.webview.postMessage({
      command: "load",
      configType: "datasource",
      data: null,
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
  }
}

export function registerDatasourceCommands(
  provider: DataSourceProvider,
  treeView: vscode.TreeView<Datasource>,
  outputChannel: vscode.OutputChannel
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // 注册刷新命令，支持完整加载
  disposables.push(
    vscode.commands.registerCommand(
      "cadb.datasource.refresh",
      async (item?: Datasource) => {
        console.log(item?.type);
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
      try {
        await addEntry(item, provider);
      } catch (error) {
        console.error("addEntry 执行失败:", error);
        vscode.window.showErrorMessage(
          `添加数据源失败: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    })
  );

  disposables.push(
    vscode.commands.registerCommand("cadb.datasource.edit", (item) =>
      editEntry(provider, item, outputChannel)
    )
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
        // TODO: 实现具体的删除逻辑
        vscode.window.showInformationMessage(
          `TODO: 删除 "${item.label}" 的逻辑待实现`
        );
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
            `选择列表项失败: ${
              error instanceof Error ? error.message : String(error)
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
            `切换数据库失败: ${
              error instanceof Error ? error.message : String(error)
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
            `复制失败: ${
              error instanceof Error ? error.message : String(error)
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
            `复制失败: ${
              error instanceof Error ? error.message : String(error)
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
            jdbcUrl = `jdbc:mysql://${host}:${port}${
              database ? `/${database}` : ""
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
            jdbcUrl = `${dbType}://${host}:${port}${
              database ? `/${database}` : ""
            }`;
          }

          await vscode.env.clipboard.writeText(jdbcUrl);
          vscode.window.showInformationMessage("已复制完整连接地址");
        } catch (error) {
          vscode.window.showErrorMessage(
            `复制失败: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    )
  );

  return disposables;
}

/** 已打开的表格数据面板：key = connectionName|databaseName|tableName，同一表只保留一个 */
const openTablePanels = new Map<string, vscode.WebviewPanel>();

async function sqlResultView(
  datasource: Datasource,
  provider: DataSourceProvider
) {
  const data = await datasource.listData();
  const tableName = datasource.label?.toString() || "";
  const databaseName = datasource.parent?.parent?.label?.toString() || "";
  const connectionName =
    datasource.dataloader?.rootNode().label?.toString() || "";
  const panelKey = `${connectionName}|${databaseName}|${tableName}`;

  const existing = openTablePanels.get(panelKey);
  if (existing) {
    existing.reveal();
    // 优先由 webview 在 visibilitychange 时发 ready 触发加载；延迟再发一次 load 作为兜底（部分环境下 visibility 可能不触发）
    setTimeout(() => {
      existing.webview.postMessage({ command: "load", data: data });
    }, 150);
    return;
  }

  const panel = createWebview(
    provider,
    "datasourceTable",
    data?.title || "未命名页"
  );
  openTablePanels.set(panelKey, panel);
  panel.onDidDispose(() => openTablePanels.delete(panelKey));

  panel.webview.onDidReceiveMessage(async (message) => {
    if (message.command === "ready") {
      // 每次 ready 都拉取最新数据，保证首次打开与再次切回该面板时都能正确加载
      const freshData = await datasource.listData();
      panel.webview.postMessage({
        command: "load",
        data: freshData,
      });
      return;
    }
    switch (message.command) {
      case "save":
        try {
          if (
            !message.data ||
            !Array.isArray(message.data) ||
            message.data.length === 0
          ) {
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

          // 获取主键字段名
          const primaryKeyField =
            data?.columnDefs?.find((col: any) => col.key === "PRI")?.field ||
            "id";

          // 使用 dataloader 的 saveData 方法
          const saveResult = await dsInstance.dataloader.saveData({
            tableName: tableName,
            databaseName: databaseName,
            primaryKeyField: primaryKeyField,
            rows: message.data,
          });

          // 发送结果
          if (saveResult.errorCount === 0) {
            panel.webview.postMessage({
              command: "status",
              success: true,
              message: `成功更新 ${saveResult.successCount} 行`,
            });
            // 刷新表格数据（第一页）
            const refreshedData = await datasource.listData();
            panel.webview.postMessage({
              command: "load",
              data: refreshedData,
            });
          } else {
            panel.webview.postMessage({
              command: "status",
              success: false,
              message: `更新完成：成功 ${saveResult.successCount} 行，失败 ${
                saveResult.errorCount
              } 行。${
                saveResult.errors.length > 0 ? saveResult.errors[0] : ""
              }`,
            });
          }
        } catch (error) {
          console.error("保存失败:", error);
          panel.webview.postMessage({
            command: "status",
            success: false,
            message: `保存失败: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
        break;
      case "refresh": {
        const data = await datasource.listData();
        panel.webview.postMessage({
          command: "load",
          data: data,
        });
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
  panel.onDidDispose(() => openTablePanels.delete(panelKey));

  panel.webview.onDidReceiveMessage(async (message) => {
    if (message.command === "ready") {
      const freshData = await datasource.listData();
      if (freshData) {
        panel.webview.postMessage({ command: "load", data: freshData });
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
      case "save":
        panel.webview.postMessage({
          command: "status",
          success: false,
          message: "Redis 键值数据不支持编辑保存",
        });
        break;
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
      await sqlResultView(datasource, provider);
    } else if (dbType === "redis") {
      await keyValueResultView(datasource, provider);
    } else {
      vscode.window.showWarningMessage(`${dbType} 数据源查看数据功能待实现`);
    }
  });

  // 注册打开 SQL 文件命令
  vscode.commands.registerCommand("cadb.file.open", async (args) => {
    const fileItem = args as Datasource;
    if (!fileItem || !fileItem.parent || !fileItem.parent.label) {
      vscode.window.showErrorMessage("无法打开文件：缺少必要信息");
      return;
    }

    // 构建文件路径
    const fileName = fileItem.label?.toString() || "";
    const dsPath = vscode.Uri.joinPath(
      provider.context.globalStorageUri,
      fileItem.parent.label.toString(),
      fileName
    );

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
          console.log(`[File Open] 自动设置数据库: ${databaseNode.label}`);
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

      const fileUri = vscode.Uri.file(filePath);
      const dirUri = vscode.Uri.file(path.dirname(filePath));
      const newFileUri = vscode.Uri.joinPath(dirUri, newName);

      // 检查新文件名是否已存在
      try {
        await vscode.workspace.fs.stat(newFileUri);
        vscode.window.showErrorMessage(`文件 "${newName}" 已存在`);
        return;
      } catch (e) {
        // 文件不存在，可以重命名
      }

      // 重命名文件
      await vscode.workspace.fs.rename(fileUri, newFileUri, {
        overwrite: false,
      });

      vscode.window.showInformationMessage(`文件已重命名为 "${newName}"`);

      // 刷新父节点以更新文件列表
      if (fileItem.parent) {
        provider.refresh(fileItem.parent);
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `重命名文件失败: ${
          error instanceof Error ? error.message : String(error)
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
        `删除文件失败: ${
          error instanceof Error ? error.message : String(error)
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
        `执行 SQL 文件失败: ${
          error instanceof Error ? error.message : String(error)
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

      // 执行每个 SQL 语句
      for (const sql of sqlStatements) {
        const trimmedSql = sql.trim();
        if (!trimmedSql) {
          continue; // 跳过空语句
        }

        const statementTimestamp = formatTimestamp(new Date());
        const startTime = Date.now();

        // 显示正在执行的语句
        const sqlOneLine = trimmedSql.replace(/\s+/g, " ").trim();
        outputChannel.appendLine(
          `[${statementTimestamp} ${databaseName}] 执行: ${sqlOneLine}`
        );
        outputChannel.show(true);

        try {
          await new Promise<void>((resolve, reject) => {
            connectionObj.query(trimmedSql, (error: any, results: any) => {
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

/**
 * 注册 Book (SQL Notebook) 面板命令
 */
