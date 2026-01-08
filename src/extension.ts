// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { DataSourceProvider } from "./provider/database_provider";
import { Datasource } from "./provider/entity/datasource";
import {
  registerDatasourceCommands,
  registerDatasourceItemCommands,
  registerDatabaseCommands,
  registerResultCommands,
} from "./provider/component/commands";
import { SqlNotebookSerializer } from "./provider/component/sql_notebook_serializer";
import { SqlNotebookController } from "./provider/component/sql_notebook_controller";
import { SqlNotebookRenderer } from "./provider/component/sql_notebook_renderer";
import { DatabaseManager } from "./provider/component/database_manager";
import { ResultWebviewProvider } from "./provider/result_provider";
import { CaCompletionItemProvider } from "./provider/completion_item_provider";
import { SqlEditorProvider } from "./provider/component/sql_editor_provider";
import { SqlCodeLensProvider } from "./provider/component/sql_codelens_provider";
import { SqlExecutor } from "./provider/component/sql_executor";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // 清除数据
  // context.globalState.update("cadb.connections", undefined);

  // 创建输出通道用于显示 SQL 执行日志
  const outputChannel = vscode.window.createOutputChannel("CADB SQL");
  context.subscriptions.push(outputChannel);

  const provider = new DataSourceProvider(context);
  // 视图命令
  vscode.window.registerTreeDataProvider("datasource", provider);
  const treeView = vscode.window.createTreeView("datasource", {
    treeDataProvider: provider,
  });
  const datasourceCommands = registerDatasourceCommands(provider, treeView);
  datasourceCommands.forEach(cmd => context.subscriptions.push(cmd));
  
  // 监听 TreeView 展开/收起事件，保存状态
  treeView.onDidExpandElement((e) => {
    provider.addExpandedNode(e.element);
  });
  
  treeView.onDidCollapseElement((e) => {
    provider.removeExpandedNode(e.element);
  });
  
  // 恢复展开状态（延迟执行，等待树视图初始化完成）
  setTimeout(() => {
    (async () => {
      try {
        const treeState = (provider as any).treeState;
        if (treeState && treeState.expandedNodes && treeState.expandedNodes.length > 0) {
          // 递归恢复展开状态
          const restoreExpandedState = async (
            element: Datasource,
            expandedNodes: string[],
            treeView: vscode.TreeView<Datasource>,
            provider: DataSourceProvider
          ): Promise<void> => {
            const nodePath = provider.getNodePath(element);
            if (expandedNodes.includes(nodePath)) {
              try {
                await treeView.reveal(element, { expand: true });
                // 等待展开完成后再处理子节点
                await new Promise(resolve => setTimeout(resolve, 100));
              } catch (e) {
                // 忽略错误，节点可能还未加载
              }
            }
            
            // 递归处理子节点
            if (element.children && element.children.length > 0) {
              for (const child of element.children) {
                await restoreExpandedState(child, expandedNodes, treeView, provider);
              }
            }
          };
          
          // 从根节点开始恢复
          const rootItems = provider.model.map((e) => new Datasource(e));
          for (const rootItem of rootItems) {
            await restoreExpandedState(rootItem, treeState.expandedNodes, treeView, provider);
          }
        }
      } catch (error) {
        console.error('恢复展开状态失败:', error);
      }
    })();
  }, 1000);
  
  treeView.onDidChangeVisibility((e) => {
    if (e.visible) {
      provider.refresh();
    }
  });
  
  // 监听 TreeView 选择变化，当选择 datasource 节点时触发完整加载
  treeView.onDidChangeSelection(async (e) => {
    if (e.selection && e.selection.length > 0) {
      const selectedItem = e.selection[0];
      if (selectedItem.type === 'datasource') {
        // 先尝试从缓存加载
        const cached = await provider.loadCachedTreeData(selectedItem);
        if (!cached) {
          // 如果缓存不存在，则完整加载
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `正在加载 ${selectedItem.label}...`,
              cancellable: false
            },
            async (progress) => {
              await provider.loadAllChildren(selectedItem, progress);
              provider.refresh();
            }
          );
        } else {
          // 如果从缓存加载成功，刷新视图
          provider.refresh();
        }
      }
    }
  });
  // 数据库管理器（替代 CaEditor，只保留数据库选择功能）
  const databaseManager = new DatabaseManager(provider);
  provider.setDatabaseManager(databaseManager);
  const databaseSelector = registerDatabaseCommands(databaseManager);
  context.subscriptions.push(databaseSelector); // 注册数据库选择器

  // 数据项命令
  registerDatasourceItemCommands(provider, outputChannel, databaseManager);

  // 查询结果 Webview（底部面板）
  const resultProvider = new ResultWebviewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("query", resultProvider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    })
  );
  registerResultCommands(resultProvider);


  // SQL Notebook API（用于打开 .jsql 文件）
  const notebookSerializer = new SqlNotebookSerializer();
  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer('cadb.sqlNotebook', notebookSerializer)
  );

  // SQL Notebook 控制器（执行 SQL 代码单元格）
  const notebookController = new SqlNotebookController(
    'cadb.sql-notebook-controller',
    'cadb.sqlNotebook',
    'SQL Notebook',
    provider,
    context,
    databaseManager  // 传入 databaseManager 以获取当前选择的数据库
  );
  context.subscriptions.push(notebookController);

  // SQL Notebook 渲染器（渲染查询结果和错误）
  const notebookRenderer = new SqlNotebookRenderer(context);
  context.subscriptions.push(notebookRenderer);

  // 注册 Notebook 数据库状态显示命令（用于工具栏显示）
  context.subscriptions.push(
    vscode.commands.registerCommand('cadb.notebook.showDatabaseStatus', () => {
      const connection = databaseManager.getCurrentConnection();
      const database = databaseManager.getCurrentDatabase();
      
      if (connection && database) {
        vscode.window.showInformationMessage(
          `当前数据库: ${connection.label} / ${database.label}`
        );
      } else if (connection) {
        vscode.window.showWarningMessage(
          `已选择连接: ${connection.label}，但未选择数据库`
        );
      } else {
        vscode.window.showWarningMessage('未选择数据库连接');
      }
    })
  );

  // 注册 Notebook 相关命令
  context.subscriptions.push(
    vscode.commands.registerCommand('cadb.notebook.new', async () => {
      // 创建新的 .jsql 文件
      const uri = await vscode.window.showSaveDialog({
        filters: {
          'SQL Notebook': ['jsql']
        },
        defaultUri: vscode.Uri.file('untitled.jsql')
      });

      if (uri) {
        // 创建空的 notebook 内容
        const emptyNotebook = {
          datasource: null,
          database: null,
          cells: []
        };
        const content = JSON.stringify(emptyNotebook, null, 2);
        
        // 写入文件
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
        
        // 打开文件
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showNotebookDocument(
          await vscode.workspace.openNotebookDocument(uri)
        );
      }
    })
  );

  // SQL 自动补全（仅支持 Notebook）
  const completionProvider = new CaCompletionItemProvider();
  completionProvider.setProvider(provider);
  completionProvider.setDatabaseManager(databaseManager);
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { notebookType: "cadb.sqlNotebook" },
      completionProvider,
      ".", // 触发字符：点号用于 table.column
      " " // 触发字符：空格用于关键字后
    )
  );

  // SQL 自定义编辑器（用于 .sql 文件）
  const sqlEditorProvider = new SqlEditorProvider();
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      "cadb.sqlEditor",
      sqlEditorProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );

  // SQL CodeLens 提供者（在 SQL 语句上方显示 Run 和 Explain）
  const sqlCodeLensProvider = new SqlCodeLensProvider(databaseManager);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { language: "sql", scheme: "file" },
      sqlCodeLensProvider
    )
  );

  // SQL 执行器
  const sqlExecutor = new SqlExecutor(provider, databaseManager, resultProvider);
  context.subscriptions.push(sqlExecutor);

  // 注册 SQL 执行命令
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cadb.sql.run",
      async (document: vscode.TextDocument, range: vscode.Range) => {
        const sql = document.getText(range).trim();
        if (sql) {
          await sqlExecutor.executeSql(sql, document);
          // 刷新 CodeLens
          sqlCodeLensProvider.refresh();
        }
      }
    )
  );

  // 注册 SQL Explain 命令
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cadb.sql.explain",
      async (document: vscode.TextDocument, range: vscode.Range) => {
        const sql = document.getText(range).trim();
        if (sql) {
          await sqlExecutor.explainSql(sql, document);
          // 刷新 CodeLens
          sqlCodeLensProvider.refresh();
        }
      }
    )
  );
}

// This method is called when your extension is deactivated
export function deactivate() {}
