import * as vscode from "vscode";
import { DataSourceProvider } from "../database_provider";
import { Datasource } from "../entity/datasource";
import path from "path";
import { generateNonce } from "../utils";

interface NotebookData {
  datasource: string | null;
  database: string | null;
  cells: Array<{
    id: string;
    sql: string;
    result?: {
      columns: Array<{ name: string; type: number }>;
      data: any[];
      rowCount: number;
      executionTime: number;
    };
    error?: string;
  }>;
}

export class SqlNotebookProvider implements vscode.CustomTextEditorProvider {
  constructor(
    private context: vscode.ExtensionContext,
    private provider: DataSourceProvider
  ) {}

  public static register(
    context: vscode.ExtensionContext,
    provider: DataSourceProvider
  ): vscode.Disposable {
    const providerInstance = new SqlNotebookProvider(context, provider);
    return vscode.window.registerCustomEditorProvider(
      "cadb.sqlNotebook",
      providerInstance,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<void> {
    const resourcesUri = webviewPanel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "resources", "panels")
    );
    const nodeResourcesUri = webviewPanel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "node_modules")
    );
    const nonce = generateNonce();

    // 设置 webview 选项
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(
          this.context.extensionUri,
          "resources",
          "panels"
        ),
        vscode.Uri.joinPath(this.context.extensionUri, "node_modules"),
      ],
    };

    // 生成 HTML
    const html = this.getHtmlContent(
      webviewPanel.webview,
      resourcesUri,
      nodeResourcesUri,
      nonce
    );
    webviewPanel.webview.html = html;

    // 加载文件数据
    let notebookData: NotebookData = {
      datasource: null,
      database: null,
      cells: [],
    };

    try {
      const content = document.getText();
      if (content.trim()) {
        notebookData = JSON.parse(content);
      }
    } catch (error) {
      console.error("解析 notebook 文件失败:", error);
    }

    // 监听来自 webview 的消息
    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "ready":
          // 页面已准备好，发送数据源列表和配置
          const connections = this.provider.model.map((conn) => ({
            name: conn.name,
            label: conn.name,
          }));
          webviewPanel.webview.postMessage({
            command: "datasourcesList",
            datasources: connections,
          });
          // 发送编辑器配置
          const config = vscode.workspace.getConfiguration("cadb.sqlNotebook");
          const fontFamily = config.get<string>(
            "fontFamily",
            "Consolas, Monaco, 'Courier New', monospace"
          );
          const fontSize = config.get<number>("fontSize", 13);
          const lineHeight = config.get<number>("lineHeight", 1.5);
          webviewPanel.webview.postMessage({
            command: "editorConfig",
            config: {
              fontFamily: fontFamily,
              fontSize: fontSize,
              lineHeight: lineHeight,
            },
          });
          // 发送已加载的 notebook 数据
          webviewPanel.webview.postMessage({
            command: "loadNotebook",
            data: notebookData,
          });
          break;

        case "getDatasources":
          const datasources = this.provider.model.map((conn) => ({
            name: conn.name,
            label: conn.name,
          }));
          webviewPanel.webview.postMessage({
            command: "datasourcesList",
            datasources: datasources,
          });
          break;

        case "getDatabases":
          try {
            const datasourceName = message.datasource;
            const datasourceData = this.provider.model.find(
              (ds) => ds.name === datasourceName
            );
            if (!datasourceData) {
              webviewPanel.webview.postMessage({
                command: "databasesList",
                databases: [],
              });
              return;
            }

            const datasource = new Datasource(datasourceData);
            const objects = await datasource.expand(this.context);
            const datasourceTypeNode = objects.find(
              (obj) => obj.type === "datasourceType"
            );

            if (!datasourceTypeNode) {
              webviewPanel.webview.postMessage({
                command: "databasesList",
                databases: [],
              });
              return;
            }

            const databases = await datasourceTypeNode.expand(this.context);
            const databaseList = databases.map((db) => ({
              name: db.label?.toString() || "",
              label: db.label?.toString() || "",
            }));

            webviewPanel.webview.postMessage({
              command: "databasesList",
              databases: databaseList,
            });
          } catch (error) {
            webviewPanel.webview.postMessage({
              command: "databasesList",
              databases: [],
            });
          }
          break;

        case "getDatabaseSchema":
          try {
            const { datasource: dsName, database: dbName } = message;
            const datasourceData = this.provider.model.find(
              (ds) => ds.name === dsName
            );
            if (!datasourceData) {
              webviewPanel.webview.postMessage({
                command: "databaseSchema",
                schema: { tables: [], columns: [] },
              });
              return;
            }

            const datasource = new Datasource(datasourceData);
            const objects = await datasource.expand(this.context);
            const datasourceTypeNode = objects.find(
              (obj) => obj.type === "datasourceType"
            );

            if (!datasourceTypeNode) {
              webviewPanel.webview.postMessage({
                command: "databaseSchema",
                schema: { tables: [], columns: [] },
              });
              return;
            }

            const databases = await datasourceTypeNode.expand(this.context);
            const database = databases.find(
              (db) => db.label?.toString() === dbName
            );

            if (!database) {
              webviewPanel.webview.postMessage({
                command: "databaseSchema",
                schema: { tables: [], columns: [] },
              });
              return;
            }

            const dbObjects = await database.expand(this.context);
            const tableTypeNode = dbObjects.find(
              (obj) => obj.type === "collectionType"
            );

            const tables: any[] = [];
            const columns: any[] = [];

            if (tableTypeNode) {
              const tableList = await tableTypeNode.expand(this.context);
              tables.push(
                ...tableList.map((table) => ({
                  name: table.label?.toString() || "",
                }))
              );

              for (const table of tableList) {
                const tableObjects = await table.expand(this.context);
                const fieldTypeNode = tableObjects.find(
                  (obj) => obj.type === "fieldType"
                );

                if (fieldTypeNode) {
                  const fields = await fieldTypeNode.expand(this.context);
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

            webviewPanel.webview.postMessage({
              command: "databaseSchema",
              schema: { tables, columns },
            });
          } catch (error) {
            webviewPanel.webview.postMessage({
              command: "databaseSchema",
              schema: { tables: [], columns: [] },
            });
          }
          break;

        case "executeSql":
          try {
            const { cellId, sql, datasource: dsName, database: dbName } =
              message;

            const datasourceData = this.provider.model.find(
              (ds) => ds.name === dsName
            );
            if (!datasourceData) {
              webviewPanel.webview.postMessage({
                command: "queryError",
                cellId: cellId,
                error: "数据源不存在",
              });
              return;
            }

            const datasource = await Datasource.createInstance(
              this.provider.model,
              this.context,
              datasourceData,
              false
            );

            if (!datasource.dataloader) {
              webviewPanel.webview.postMessage({
                command: "queryError",
                cellId: cellId,
                error: "无法创建数据库连接",
              });
              return;
            }

            let connection = datasource.dataloader.getConnection();
            if (!connection) {
              await datasource.dataloader.connect();
              connection = datasource.dataloader.getConnection();
              if (!connection) {
                webviewPanel.webview.postMessage({
                  command: "queryError",
                  cellId: cellId,
                  error: "无法获取数据库连接",
                });
                return;
              }
            }

            const startTime = Date.now();
            connection.changeUser({ database: dbName }, (err: any) => {
              if (err) {
                webviewPanel.webview.postMessage({
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
                    webviewPanel.webview.postMessage({
                      command: "queryError",
                      cellId: cellId,
                      error: error.message,
                    });
                    return;
                  }

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

                  webviewPanel.webview.postMessage({
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
            webviewPanel.webview.postMessage({
              command: "queryError",
              cellId: message.cellId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          break;

        case "updateNotebook":
          // 更新 notebook 数据到文档（标记为已修改，但不自动保存文件）
          // 这样 Ctrl+S 可以正常工作，文件标题会显示 * 表示未保存
          try {
            const notebookData: NotebookData = message.data;
            const content = JSON.stringify(notebookData, null, 2);
            
            // 检查内容是否真的改变了
            const currentContent = document.getText();
            if (currentContent === content) {
              // 内容没有变化，不需要更新
              return;
            }
            
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
              document.uri,
              new vscode.Range(0, 0, document.lineCount, 0),
              content
            );
            const success = await vscode.workspace.applyEdit(edit);
            
            if (success) {
              // 标记文档为已修改（dirty），这样 Ctrl+S 可以保存
              // VSCode 会自动处理文档的 dirty 状态
            }
            // 不调用 document.save()，让用户通过 Ctrl+S 手动保存
          } catch (error) {
            console.error("更新 notebook 失败:", error);
          }
          break;
      }
    });

    // 监听配置变化
    const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("cadb.sqlNotebook")) {
        const config = vscode.workspace.getConfiguration("cadb.sqlNotebook");
        const fontFamily = config.get<string>(
          "fontFamily",
          "Consolas, Monaco, 'Courier New', monospace"
        );
        const fontSize = config.get<number>("fontSize", 13);
        const lineHeight = config.get<number>("lineHeight", 1.5);

        webviewPanel.webview.postMessage({
          command: "editorConfig",
          config: {
            fontFamily: fontFamily,
            fontSize: fontSize,
            lineHeight: lineHeight,
          },
        });
      }
    });

    // 监听文档变化（当文件被外部修改或保存时）
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(
      (e) => {
        if (
          e.document.uri.toString() === document.uri.toString() &&
          e.document === document
        ) {
          // 文件被外部修改，重新加载
          // 但需要检查是否是我们的更新导致的（避免循环）
          try {
            const content = e.document.getText();
            if (content.trim()) {
              const newData = JSON.parse(content);
              webviewPanel.webview.postMessage({
                command: "loadNotebook",
                data: newData,
              });
            }
          } catch (error) {
            console.error("重新加载 notebook 失败:", error);
          }
        }
      }
    );

    // 监听文档保存事件（当用户按 Ctrl+S 时）
    const saveDocumentSubscription = vscode.workspace.onDidSaveTextDocument(
      (savedDocument) => {
        if (savedDocument.uri.toString() === document.uri.toString()) {
          // 文件已保存，可以在这里做一些处理（如果需要）
          console.log("Notebook 文件已保存");
        }
      }
    );

    webviewPanel.onDidDispose(() => {
      configWatcher.dispose();
      changeDocumentSubscription.dispose();
      saveDocumentSubscription.dispose();
    });
  }

  private getHtmlContent(
    webview: vscode.Webview,
    resourcesUri: vscode.Uri,
    nodeResourcesUri: vscode.Uri,
    nonce: string
  ): string {
    const panel = {
      webview: {
        cspSource: webview.cspSource,
      },
    } as any;

    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SQL Notebook</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource} 'self' 'unsafe-eval'; connect-src ${webview.cspSource}; worker-src ${webview.cspSource} blob:;" />
    <script nonce="${nonce}" src="${nodeResourcesUri}/jquery/dist/jquery.min.js"></script>
    <script nonce="${nonce}" src="${nodeResourcesUri}/layui/dist/layui.js"></script>
    <link rel="stylesheet" href="${nodeResourcesUri}/layui/dist/css/layui.css" />
    <link rel="stylesheet" href="${resourcesUri}/common/layui-theme.css" />
    <link rel="stylesheet" href="${resourcesUri}/book/book.css" />
    <script nonce="${nonce}" src="${nodeResourcesUri}/monaco-editor/min/vs/loader.js"></script>
  </head>
  <body>
    <!-- 顶部工具栏 -->
    <div class="notebook-header">
      <div class="header-left">
        <h2 class="notebook-title">SQL Notebook</h2>
      </div>
      <div class="header-right">
        <div class="datasource-selector">
          <select id="datasourceSelect" class="native-select">
            <option value="">选择数据源</option>
          </select>
        </div>
        <div class="database-selector">
          <select id="databaseSelect" class="native-select" disabled>
            <option value="">选择数据库</option>
          </select>
        </div>
        <button id="btnAddCell" class="layui-btn layui-btn-sm">
          <i class="layui-icon layui-icon-add-1"></i> 添加 Cell
        </button>
        <button id="btnSave" class="layui-btn layui-btn-sm layui-btn-normal">
          <i class="layui-icon layui-icon-upload"></i> 保存
        </button>
      </div>
    </div>

    <!-- Notebook 内容区域 -->
    <div class="notebook-container" id="notebookContainer">
      <!-- SQL Cell 将动态添加到这里 -->
    </div>

    <script nonce="${nonce}">
      // 在页面加载时设置 Monaco Editor 路径
      window.MONACO_BASE_PATH = "${nodeResourcesUri}";
      
      // 屏蔽 VSCode 快捷键
      document.addEventListener('keydown', function(e) {
        // 屏蔽 F1 (命令面板)
        if (e.key === 'F1') {
          e.preventDefault();
          e.stopPropagation();
          return false;
        }
        // 屏蔽 Ctrl+Shift+P (命令面板)
        if (e.ctrlKey && e.shiftKey && e.key === 'P') {
          e.preventDefault();
          e.stopPropagation();
          return false;
        }
        // 屏蔽 Ctrl+K (快捷键命令)
        if (e.ctrlKey && e.key === 'k') {
          e.preventDefault();
          e.stopPropagation();
          return false;
        }
        // 屏蔽 Ctrl+Shift+E (资源管理器)
        if (e.ctrlKey && e.shiftKey && e.key === 'E') {
          e.preventDefault();
          e.stopPropagation();
          return false;
        }
        // 屏蔽 Ctrl+B (侧边栏切换)
        if (e.ctrlKey && e.key === 'b') {
          e.preventDefault();
          e.stopPropagation();
          return false;
        }
      }, true);
    </script>
    <script nonce="${nonce}" src="${resourcesUri}/book/book.js"></script>
  </body>
</html>`;

    return html;
  }
}

