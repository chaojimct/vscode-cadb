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

function createWebview(
  provider: DataSourceProvider,
  viewType: "settings" | "datasourceTable" | "tableEdit",
  title: string
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    viewType,
    title,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(
          path.join(provider.context.extensionPath, "resources", "panels")
        ),
        vscode.Uri.file(
          path.join(provider.context.extensionPath, "node_modules")
        ),
      ],
    }
  );

  const resourcesUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(provider.context.extensionUri, "resources", "panels")
  );
  const nodeResourcesUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(provider.context.extensionUri, "node_modules")
  );
  const nonce = generateNonce();
  panel.webview.html = provider.panels[viewType]
    .replace(
      /{{csp}}/g,
      `
    default-src 'none';
		font-src ${panel.webview.cspSource};
    style-src ${panel.webview.cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}';
    connect-src ${panel.webview.cspSource};
  `.trim()
    )
    .replace(/{{node-resources-uri}}/g, nodeResourcesUri.toString())
    .replace(/{{resources-uri}}/g, resourcesUri.toString())
    .replace(/{{resource-nonce}}/g, nonce);
  panel.iconPath = vscode.Uri.file(
    path.join(
      provider.context.extensionPath,
      "resources",
      "panels",
      "favicon.ico"
    )
  );
  return panel;
}

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
	console.log(data);
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
  if (item.dataloder) {
    // TODO: 实现用户信息的数据库更新逻辑
    // 这需要在 dataloader 中添加 updateUser 方法
    console.log("更新用户信息:", payload);
    vscode.window.showInformationMessage("用户信息已更新（需要实现数据库更新逻辑）");
  } else {
    throw new Error("无法获取数据库连接");
  }
}

async function addEntry(item: any, provider: DataSourceProvider) {
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
    await addEntry(item, provider);
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

export function registerDatasourceItemCommands(provider: DataSourceProvider) {
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
          console.log(message.data);
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
