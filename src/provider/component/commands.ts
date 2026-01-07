import * as vscode from "vscode";
import { DataSourceProvider } from "../database_provider";
import { Datasource } from "../entity/datasource";
import path from "path";
import { FormResult } from "../entity/dataloader";
import { SQLCodeLensProvider } from "../sql_provider";
import { generateNonce } from "../utils";
import { CaEditor } from "./editor";
import { ResultWebviewProvider } from "../result_provider";
import { DatabaseSelector } from "./database_selector";
import { createWebview } from "../webview_helper";

async function editEntry(provider: DataSourceProvider, item: Datasource) {
  let panel = null;
  let configType = "";
  
  if (item.type === "datasource") {
    panel = createWebview(
      provider,
      "settings",
      `【${item.label}】编辑`
    );
    configType = "datasource";
  } else if (item.type === "user") {
    panel = createWebview(provider, "settings", `【${item.label}】编辑`);
    configType = "user";
  } else if (
    item.type === "document" ||
    item.type === "field" ||
    item.type === "index"
  ) {
    panel = createWebview(provider, "tableEdit", `【${item.label}】编辑`);
  } else {
    return;
  }
  
  const data: FormResult | undefined = await item.edit();
  panel.webview.postMessage({
    command: "load",
    configType: configType,
    data: data,
  });
  
  panel.webview.onDidReceiveMessage(async (message) => {
    switch (message.command) {
      case "save":
        try {
          if (item.type === "datasource") {
            // 更新数据库连接配置
            await updateDatasourceConfig(provider, item, message.payload);
            panel.webview.postMessage({
              command: "status",
              success: true,
              message: "✔️ 连接配置更新成功",
            });
          } else if (item.type === "user") {
            // 更新用户信息
            await updateUserInfo(provider, item, message.payload);
            panel.webview.postMessage({
              command: "status",
              success: true,
              message: "✔️ 用户信息更新成功",
            });
          }
        } catch (error) {
          console.error("保存失败:", error);
          panel.webview.postMessage({
            command: "status",
            success: false,
            message: `❗ 保存失败: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        break;
      case "test":
        // 测试连接（仅用于数据库连接配置）
        if (item.type === "datasource") {
          try {
            const db = await Datasource.createInstance(
              provider.model,
              provider.context,
              message.payload
            );
            const res = await db.test();
            if (res.success) {
              panel.webview.postMessage({
                command: "status",
                success: true,
                message: "✔️ 连接测试成功",
              });
            } else {
              panel.webview.postMessage({
                command: "status",
                success: false,
                message: `❗ ${res.message}`,
              });
            }
          } catch (error) {
            panel.webview.postMessage({
              command: "status",
              success: false,
              message: `❗ 测试失败: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
        break;
    }
  });
}

/**
 * 更新数据库连接配置
 */
async function updateDatasourceConfig(
  provider: DataSourceProvider,
  item: Datasource,
  payload: any
): Promise<void> {
  // 查找并更新 model 中的配置
  const index = provider.model.findIndex(
    (conn) => conn.name === item.label?.toString()
  );
  
  if (index === -1) {
    throw new Error("未找到要更新的连接配置");
  }
  
  // 更新配置数据
  provider.model[index] = {
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
  await provider.context.globalState.update("cadb.connections", provider.model);
  
  // 刷新视图
  provider.refresh();
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
    vscode.window.showInformationMessage("用户信息已更新（需要实现数据库更新逻辑）");
  } else {
    throw new Error("无法获取数据库连接");
  }
}

async function addEntry(item: any, provider: DataSourceProvider) {
  if (item && item.type === "datasourceType") {
    const dataloader = (item as Datasource).dataloader;
    if (!dataloader) {
      return;
    }

    const collations = await dataloader.listCollations();
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
                
                if (newDatabase && newDatabase.type === 'collection') {
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

  if (item) {
    await (item as Datasource).create(provider.context, provider.editor);
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
            await Datasource.createInstance(
              provider.model,
              provider.context,
              message.payload,
              true
            );
            provider.refresh();
            panel.webview.postMessage({
              command: "status",
              success: true,
              message: "✔️保存成功",
            });
          }
          return;
        case "test":
          {
            const db = await Datasource.createInstance(
              provider.model,
              provider.context,
              message.payload
            );
            const res = await db.test();
            if (res.success) {
              panel.webview.postMessage({
                command: "status",
                success: res.success,
                message: "✔️连接成功",
              });
            } else {
              panel.webview.postMessage({
                command: "status",
                success: res.success,
                message: `❗${res.message}`,
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
  treeView: vscode.TreeView<Datasource>
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  
  // 注册刷新命令，支持完整加载
  disposables.push(vscode.commands.registerCommand("cadb.datasource.refresh", async (item?: Datasource) => {
    if (item && item.type === 'datasource') {
      // 如果指定了数据源，则完整加载该数据源
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `正在刷新 ${item.label}...`,
          cancellable: false
        },
        async (progress) => {
          // 清除缓存
          provider.clearCachedTreeData(item.label?.toString() || '');
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
  }));
  
  disposables.push(vscode.commands.registerCommand("cadb.datasource.add", async (item) => {
    try {
      await addEntry(item, provider);
    } catch (error) {
      console.error("addEntry 执行失败:", error);
      vscode.window.showErrorMessage(`添加数据源失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  
  disposables.push(vscode.commands.registerCommand("cadb.datasource.edit", (item) =>
    editEntry(provider, item)
  ));
  
  disposables.push(vscode.commands.registerCommand("cadb.datasource.expand", async (item) => {
    const children = await (item as Datasource).expand(provider.context);
    provider.createChildren(item as Datasource, children);
    treeView.reveal(item as Datasource, { expand: true });
  }));
  
  // 注册选择数据库命令
  disposables.push(vscode.commands.registerCommand("cadb.datasource.selectDatabases", async (item: Datasource) => {
    try {
      // 确保 item 是 datasourceType 节点
      if (item.type !== 'datasourceType') {
        vscode.window.showWarningMessage('请在数据库列表节点上执行此操作');
        return;
      }
      
      // 获取父节点（连接节点）
      const connectionNode = item.parent;
      if (!connectionNode || !connectionNode.label) {
        vscode.window.showWarningMessage('无法找到连接信息');
        return;
      }
      
      const connectionName = connectionNode.label.toString();
      // 显示加载提示
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "正在加载数据库列表...",
          cancellable: false
        },
        async () => {
          // 获取所有数据库
          const allDatabases = await item.expand(provider.context);
          
          if (allDatabases.length === 0) {
            vscode.window.showWarningMessage('该连接没有可用的数据库');
            return;
          }
          // 获取当前已选择的数据库
          const currentSelected = provider.getSelectedDatabases(connectionName);
          // 创建 QuickPick 项
          interface DatabaseQuickPickItem extends vscode.QuickPickItem {
            database: string;
          }
          
          const quickPickItems: DatabaseQuickPickItem[] = allDatabases.map(db => ({
            label: db.label?.toString() || '',
            description: db.description ? (typeof db.description === 'string' ? db.description : db.description.toString()) : undefined,
            database: db.label?.toString() || '',
            picked: currentSelected.includes(db.label?.toString() || '')
          }));
          
          // 显示多选 QuickPick
          const selected = await vscode.window.showQuickPick(quickPickItems, {
            placeHolder: `选择要显示的数据库（当前连接: ${connectionName}）`,
            canPickMany: true,
            matchOnDescription: true
          });
          
          if (selected) {
            const selectedDbs = selected.map(item => item.database);
            // 保存选择
            provider.setSelectedDatabases(connectionName, selectedDbs);
            
            // 清空 datasourceType 节点的子节点缓存，强制重新加载
            item.children = [];
            
            // 刷新 TreeView
            provider.refresh();
            
            // 等待刷新完成后，从缓存恢复描述
            setTimeout(async () => {
              if (connectionNode && provider.context) {
                const cached = await provider.loadCachedTreeData(connectionNode);
                if (cached) {
                  provider.refresh();
                }
              }
            }, 100);
            
            vscode.window.showInformationMessage(
              `已选择 ${selectedDbs.length} 个数据库${selectedDbs.length === 0 ? '（将显示全部）' : ''}`
            );
          }
        }
      );
    } catch (error) {
      console.error('[SelectDatabases] 错误:', error);
      vscode.window.showErrorMessage(
        `选择数据库失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }));

  // 注册使用数据库命令（从 TreeView collection 节点）
  disposables.push(vscode.commands.registerCommand("cadb.collection.useDatabase", (item: Datasource) => {
    try {
      // 确保 item 是 collection 节点
      if (item.type !== 'collection') {
        vscode.window.showWarningMessage('请在数据库节点上执行此操作');
        return;
      }
      
      // 通过 editor 设置当前数据库
      if (provider.editor) {
        provider.editor.setCurrentDatabase(item);
      } else {
        vscode.window.showErrorMessage('编辑器未初始化');
      }
    } catch (error) {
      console.error('[UseDatabase] 错误:', error);
      vscode.window.showErrorMessage(
        `切换数据库失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }));

  // 注册复制连接地址命令（仅连接地址：host:port）
  disposables.push(vscode.commands.registerCommand("cadb.datasource.copyConnectionAddress", async (item: Datasource) => {
    try {
      if (item.type !== 'datasource' || !item.data) {
        vscode.window.showWarningMessage('请在数据源节点上执行此操作');
        return;
      }

      const host = item.data.host || 'localhost';
      const port = item.data.port || 3306;
      const address = `${host}:${port}`;
      
      await vscode.env.clipboard.writeText(address);
      vscode.window.showInformationMessage(`已复制连接地址: ${address}`);
    } catch (error) {
      vscode.window.showErrorMessage(
        `复制失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }));

  // 注册复制用户名密码命令（仅用户名密码：username@password）
  disposables.push(vscode.commands.registerCommand("cadb.datasource.copyCredentials", async (item: Datasource) => {
    try {
      if (item.type !== 'datasource' || !item.data) {
        vscode.window.showWarningMessage('请在数据源节点上执行此操作');
        return;
      }

      const username = item.data.username || '';
      const password = item.data.password || '';
      const credentials = `${username}@${password}`;
      
      await vscode.env.clipboard.writeText(credentials);
      vscode.window.showInformationMessage('已复制用户名密码');
    } catch (error) {
      vscode.window.showErrorMessage(
        `复制失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }));

  // 注册复制完整连接命令（JDBC URL）
  disposables.push(vscode.commands.registerCommand("cadb.datasource.copyFullConnection", async (item: Datasource) => {
    try {
      if (item.type !== 'datasource' || !item.data) {
        vscode.window.showWarningMessage('请在数据源节点上执行此操作');
        return;
      }

      const dbType = item.data.dbType || 'mysql';
      const host = item.data.host || 'localhost';
      const port = item.data.port || 3306;
      const username = item.data.username || '';
      const password = item.data.password || '';
      const database = item.data.database || '';

      let jdbcUrl = '';
      
      if (dbType === 'mysql') {
        // MySQL JDBC URL: jdbc:mysql://host:port/database?user=username&password=password
        const params = new URLSearchParams();
        if (username) {
					params.append('user', username);
				}
        if (password) {
					params.append('password', password);
				}
        const queryString = params.toString();
        jdbcUrl = `jdbc:mysql://${host}:${port}${database ? `/${database}` : ''}${queryString ? `?${queryString}` : ''}`;
      } else if (dbType === 'redis') {
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
        jdbcUrl = `${dbType}://${host}:${port}${database ? `/${database}` : ''}`;
      }
      
      await vscode.env.clipboard.writeText(jdbcUrl);
      vscode.window.showInformationMessage('已复制完整连接地址');
    } catch (error) {
      vscode.window.showErrorMessage(
        `复制失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }));
  
  return disposables;
}

export function registerDatasourceItemCommands(
  provider: DataSourceProvider,
  outputChannel: vscode.OutputChannel,
  editor: CaEditor
) {
  vscode.commands.registerCommand("cadb.item.showData", async (args) => {
    const datasource = args as Datasource;
    const data = await datasource.listData();
    const panel = createWebview(
      provider,
      "datasourceTable",
      data?.title || "未命名页"
    );
    panel.webview.postMessage({
      command: "load",
      data: data,
    });
    panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "save":
          break;
      }
    });
  });

  // 注册打开 SQL 文件命令
  vscode.commands.registerCommand("cadb.file.open", async (args) => {
    const fileItem = args as Datasource;
    if (!fileItem || !fileItem.parent || !fileItem.parent.label) {
      vscode.window.showErrorMessage("无法打开文件：缺少必要信息");
      return;
    }

    // 构建文件路径
    const dsPath = vscode.Uri.joinPath(
      provider.context.globalStorageUri,
      fileItem.parent.label.toString(),
      fileItem.label?.toString() || ""
    );

    try {
      // 打开文件
      const doc = await vscode.workspace.openTextDocument(dsPath);
      await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: vscode.ViewColumn.Active,
      });
    } catch (error) {
      vscode.window.showErrorMessage(`打开文件失败: ${error}`);
    }
  });

  // 注册执行 SQL 文件命令
  vscode.commands.registerCommand("cadb.file.execute", async (args) => {
    const fileItem = args as Datasource;
    if (!fileItem || fileItem.type !== "file") {
      vscode.window.showErrorMessage("无法执行：不是有效的文件项");
      return;
    }

    // 获取文件路径（从 tooltip 获取完整路径）
    const filePath =
      typeof fileItem.tooltip === "string"
        ? fileItem.tooltip
        : fileItem.tooltip?.value || "";
    if (!filePath) {
      vscode.window.showErrorMessage("无法获取文件路径");
      return;
    }

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
      const selectedConnection = await editor.selectConnection();
      if (!selectedConnection) {
        return; // 用户取消
      }

      const selectedDatabase = await editor.selectDatabaseFromConnection(
        selectedConnection
      );
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
      const connectionData = provider.model.find(
        (ds) => ds.name === connection.label?.toString()
      );
      if (!connectionData) {
        throw new Error("数据源不存在");
      }

      const datasource = await Datasource.createInstance(
        provider.model,
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
      outputChannel.appendLine(
        `[${timestamp} ${databaseName}] 开始事务`
      );
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

export function registerCodeLensCommands(provider: SQLCodeLensProvider) {
  vscode.commands.registerCommand(
    "cadb.sql.explain",
    (sql: string, startLine: number, endLine: number) =>
      provider.explainSql(sql, startLine, endLine)
  );
  vscode.commands.registerCommand(
    "cadb.sql.run",
    (sql: string, startLine: number, endLine: number) =>
      provider.runSql(sql, startLine, endLine)
  );
}

export function registerEditorCommands(editor: CaEditor) {
  // 创建数据库选择器
  const databaseSelector = new DatabaseSelector(editor);

  // 设置数据库变化回调
  editor.setOnDatabaseChangedCallback(() => {
    databaseSelector.updateStatusBar();
  });

  // 注册数据库选择命令
  vscode.commands.registerCommand("cadb.sql.selectDatabase", () =>
    editor.selectDatabase()
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
export function registerBookCommands(
  provider: DataSourceProvider,
  editor: CaEditor
): vscode.Disposable {
  let bookPanel: vscode.WebviewPanel | undefined = undefined;

  // 打开 Book 面板命令
  const openBookCommand = vscode.commands.registerCommand(
    "cadb.book.open",
    async () => {
      if (bookPanel) {
        bookPanel.reveal();
        return;
      }

      bookPanel = createWebview(provider, "book", "SQL Notebook");

      // 监听来自 webview 的消息
      bookPanel.webview.onDidReceiveMessage(async (message) => {
        switch (message.command) {
          case "ready":
            // 页面已准备好，发送数据源列表和配置
            const connections = provider.model.map((conn) => ({
              name: conn.name,
              label: conn.name,
            }));
            bookPanel?.webview.postMessage({
              command: "datasourcesList",
              datasources: connections,
            });
            // 发送编辑器配置
            const config = vscode.workspace.getConfiguration("cadb.sqlNotebook");
            const fontFamily = config.get<string>("fontFamily", "Consolas, Monaco, 'Courier New', monospace");
            const fontSize = config.get<number>("fontSize", 13);
            const lineHeight = config.get<number>("lineHeight", 1.5);
            bookPanel?.webview.postMessage({
              command: "editorConfig",
              config: {
                fontFamily: fontFamily,
                fontSize: fontSize,
                lineHeight: lineHeight
              }
            });
            break;

          case "getDatasources":
            // 获取数据源列表
            const datasources = provider.model.map((conn) => ({
              name: conn.name,
              label: conn.name,
            }));
            bookPanel?.webview.postMessage({
              command: "datasourcesList",
              datasources: datasources,
            });
            break;

          case "getDatabases":
            // 获取数据库列表
            try {
              const datasourceName = message.datasource;
              const datasourceData = provider.model.find(
                (ds) => ds.name === datasourceName
              );
              if (!datasourceData) {
                bookPanel?.webview.postMessage({
                  command: "databasesList",
                  databases: [],
                });
                return;
              }

              const datasource = new Datasource(datasourceData);
              const objects = await datasource.expand(provider.context);
              const datasourceTypeNode = objects.find(
                (obj) => obj.type === "datasourceType"
              );

              if (!datasourceTypeNode) {
                bookPanel?.webview.postMessage({
                  command: "databasesList",
                  databases: [],
                });
                return;
              }

              const databases = await datasourceTypeNode.expand(
                provider.context
              );
              const databaseList = databases.map((db) => ({
                name: db.label?.toString() || "",
                label: db.label?.toString() || "",
              }));

              bookPanel?.webview.postMessage({
                command: "databasesList",
                databases: databaseList,
              });
            } catch (error) {
              bookPanel?.webview.postMessage({
                command: "databasesList",
                databases: [],
              });
            }
            break;

          case "getDatabaseSchema":
            // 获取数据库的表和字段信息
            try {
              const { datasource: dsName, database: dbName } = message;
              const datasourceData = provider.model.find(
                (ds) => ds.name === dsName
              );
              if (!datasourceData) {
                bookPanel?.webview.postMessage({
                  command: "databaseSchema",
                  schema: { tables: [], columns: [] },
                });
                return;
              }

              const datasource = new Datasource(datasourceData);
              const objects = await datasource.expand(provider.context);
              const datasourceTypeNode = objects.find(
                (obj) => obj.type === "datasourceType"
              );

              if (!datasourceTypeNode) {
                bookPanel?.webview.postMessage({
                  command: "databaseSchema",
                  schema: { tables: [], columns: [] },
                });
                return;
              }

              const databases = await datasourceTypeNode.expand(
                provider.context
              );
              const database = databases.find(
                (db) => db.label?.toString() === dbName
              );

              if (!database) {
                bookPanel?.webview.postMessage({
                  command: "databaseSchema",
                  schema: { tables: [], columns: [] },
                });
                return;
              }

              // 获取数据库下的对象
              const dbObjects = await database.expand(provider.context);
              const tableTypeNode = dbObjects.find(
                (obj) => obj.type === "collectionType"
              );

              const tables: any[] = [];
              const columns: any[] = [];

              if (tableTypeNode) {
                const tableList = await tableTypeNode.expand(
                  provider.context
                );
                tables.push(
                  ...tableList.map((table) => ({
                    name: table.label?.toString() || "",
                  }))
                );

                // 获取每个表的字段
                for (const table of tableList) {
                  const tableObjects = await table.expand(provider.context);
                  const fieldTypeNode = tableObjects.find(
                    (obj) => obj.type === "fieldType"
                  );

                  if (fieldTypeNode) {
                    const fields = await fieldTypeNode.expand(
                      provider.context
                    );
                    fields.forEach((field) => {
                      columns.push({
                        table: table.label?.toString() || "",
                        column: field.label?.toString() || "",
                        type: field.description?.toString() || "",
                      });
                    });
                  }
                }
              }

              bookPanel?.webview.postMessage({
                command: "databaseSchema",
                schema: { tables, columns },
              });
            } catch (error) {
              bookPanel?.webview.postMessage({
                command: "databaseSchema",
                schema: { tables: [], columns: [] },
              });
            }
            break;

          case "executeSql":
            // 执行 SQL
            try {
              const { cellId, sql, datasource: dsName, database: dbName } =
                message;

              // 查找数据源
              const datasourceData = provider.model.find(
                (ds) => ds.name === dsName
              );
              if (!datasourceData) {
                bookPanel?.webview.postMessage({
                  command: "queryError",
                  cellId: cellId,
                  error: "数据源不存在",
                });
                return;
              }

              // 创建数据源实例
              const datasource = await Datasource.createInstance(
                provider.model,
                provider.context,
                datasourceData,
                false
              );

              if (!datasource.dataloader) {
                bookPanel?.webview.postMessage({
                  command: "queryError",
                  cellId: cellId,
                  error: "无法创建数据库连接",
                });
                return;
              }

              // 获取连接
              let connection = datasource.dataloader.getConnection();
              if (!connection) {
                await datasource.dataloader.connect();
                connection = datasource.dataloader.getConnection();
                if (!connection) {
                  bookPanel?.webview.postMessage({
                    command: "queryError",
                    cellId: cellId,
                    error: "无法获取数据库连接",
                  });
                  return;
                }
              }

              // 执行 SQL
              const startTime = Date.now();
              connection.changeUser({ database: dbName }, (err: any) => {
                if (err) {
                  bookPanel?.webview.postMessage({
                    command: "queryError",
                    cellId: cellId,
                    error: err.message,
                  });
                  return;
                }

                connection.query(
                  sql,
                  (error: any, results: any, fields: any) => {
                    const executionTime = (Date.now() - startTime) / 1000;

                    if (error) {
                      bookPanel?.webview.postMessage({
                        command: "queryError",
                        cellId: cellId,
                        error: error.message,
                      });
                      return;
                    }

                    // 格式化结果
                    const columns = fields
                      ? fields.map((f: any) => ({
                          name: f.name,
                          type: f.type,
                        }))
                      : [];
                    const data = Array.isArray(results)
                      ? results
                      : results.affectedRows !== undefined
                      ? []
                      : [];

                    bookPanel?.webview.postMessage({
                      command: "queryResult",
                      cellId: cellId,
                      result: {
                        columns: columns,
                        data: data,
                        rowCount: Array.isArray(results)
                          ? results.length
                          : results.affectedRows || 0,
                        executionTime: executionTime,
                      },
                    });
                  }
                );
              });
            } catch (error) {
              bookPanel?.webview.postMessage({
                command: "queryError",
                cellId: message.cellId,
                error:
                  error instanceof Error ? error.message : String(error),
              });
            }
            break;

          case "saveNotebookAs":
            // 从 WebviewPanel 保存 notebook 为新文件
            try {
              const notebookData = message.data;
              const content = JSON.stringify(notebookData, null, 2);
              
              console.log("收到 saveNotebookAs 请求", notebookData);
              
              // 显示保存对话框
              const uri = await vscode.window.showSaveDialog({
                filters: {
                  'SQL Notebook': ['jsql']
                },
                defaultUri: vscode.Uri.file('untitled.jsql')
              });
              
              if (uri) {
                // 写入文件
                await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
                
                console.log("文件已保存到:", uri.fsPath);
                
                // 通知保存成功
                bookPanel?.webview.postMessage({
                  command: "saveNotebookSuccess",
                });
                
                // 提示用户是否要在编辑器中打开
                const action = await vscode.window.showInformationMessage(
                  '文件已保存。是否在编辑器中打开？',
                  '打开', '取消'
                );
                
                if (action === '打开') {
                  // 关闭当前 panel
                  bookPanel?.dispose();
                  bookPanel = undefined;
                  
                  // 打开文件（会自动使用 CustomTextEditor）
                  const document = await vscode.workspace.openTextDocument(uri);
                  await vscode.window.showTextDocument(document);
                }
              } else {
                console.log("用户取消了保存");
              }
            } catch (error) {
              console.error("保存 notebook 失败:", error);
              bookPanel?.webview.postMessage({
                command: "saveNotebookError",
                error: error instanceof Error ? error.message : String(error),
              });
            }
            break;
        }
      });

      // 监听配置变化
      const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("cadb.sqlNotebook") && bookPanel) {
          const config = vscode.workspace.getConfiguration("cadb.sqlNotebook");
          const fontFamily = config.get<string>("fontFamily", "Consolas, Monaco, 'Courier New', monospace");
          const fontSize = config.get<number>("fontSize", 13);
          const lineHeight = config.get<number>("lineHeight", 1.5);
          
          bookPanel.webview.postMessage({
            command: "editorConfig",
            config: {
              fontFamily: fontFamily,
              fontSize: fontSize,
              lineHeight: lineHeight
            }
          });
        }
      });

      // 监听面板关闭
      bookPanel.onDidDispose(() => {
        bookPanel = undefined;
        configWatcher.dispose();
      });
    }
  );

  return openBookCommand;
}
