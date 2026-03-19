// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { DataSourceProvider } from "./provider/database_provider";
import { Datasource } from "./provider/entity/datasource";
import { format as formatSql } from "sql-formatter";
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
import { SqlCodeLensProvider } from "./provider/component/sql_codelens_provider";
import { SqlHoverProvider, lastHoveredTableInfo } from "./provider/component/sql_hover_provider";
import { SqlExecutor } from "./provider/component/sql_executor";
import { DatabaseStatusBar } from "./provider/component/database_status_bar";
import {
  MySQLTableWorkspaceSymbolProvider,
  CadbTableDocumentContentProvider,
  resolveTableDatasource,
} from "./provider/workspace_symbol_provider";

class CadbColorDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    if (uri.scheme !== "cadb-color") {
      return;
    }
    const params = new URLSearchParams(uri.query);
    const color = params.get("color");
    if (!color) {
      return;
    }
    return new vscode.FileDecoration("●", undefined, new vscode.ThemeColor(color));
  }
}

class SqlDocumentFormattingProvider implements vscode.DocumentFormattingEditProvider {
  provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.TextEdit[]> {
    const text = document.getText();
    const formatted = formatSql(text, {
      language: "mysql",
      tabWidth: typeof options.tabSize === "number" ? options.tabSize : 2,
      useTabs: options.insertSpaces === false,
    });
    if (formatted === text) {
      return [];
    }
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(text.length)
    );
    return [vscode.TextEdit.replace(fullRange, formatted)];
  }
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // 创建输出通道用于显示 SQL 执行日志
  const outputChannel = vscode.window.createOutputChannel("CADB SQL");
  context.subscriptions.push(outputChannel);
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(new CadbColorDecorationProvider())
  );
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(
      [{ language: "sql" }],
      new SqlDocumentFormattingProvider()
    )
  );

  const provider = new DataSourceProvider(context);
  // 视图命令
  vscode.window.registerTreeDataProvider("datasource", provider);
  const treeView = vscode.window.createTreeView("datasource", {
    treeDataProvider: provider,
  });
  const datasourceCommands = registerDatasourceCommands(
    provider,
    treeView,
    outputChannel
  );
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
        const treeState = provider.getTreeState();
        if (treeState?.expandedNodes?.length) {
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
          const rootItems = provider.getConnections().map((e) => new Datasource(e));
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
  
  // 数据库管理器（替代 CaEditor，只保留数据库选择功能）
  const databaseManager = new DatabaseManager(provider);
  provider.setDatabaseManager(databaseManager);
  
  // 创建数据库状态栏管理器
  const databaseStatusBar = new DatabaseStatusBar(databaseManager);
  context.subscriptions.push(databaseStatusBar);

  const databaseSelector = registerDatabaseCommands(databaseManager);
  context.subscriptions.push(databaseSelector); // 注册数据库选择器

  // 注册选择数据库命令
  context.subscriptions.push(
    vscode.commands.registerCommand('cadb.selectDatabase', async () => {
      await databaseManager.selectDatabase();
    })
  );

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

  // 监听 Notebook 打开事件，自动设置数据库连接
  context.subscriptions.push(
    vscode.workspace.onDidOpenNotebookDocument(async (notebook) => {
      // 只处理 SQL Notebook
      if (notebook.notebookType !== 'cadb.sqlNotebook') {
        return;
      }

      // 读取 Notebook 元数据中的数据库连接信息
      const metadata = notebook.metadata;
      const datasourceName = metadata?.datasource;
      const databaseName = metadata?.database;

      if (datasourceName && databaseName) {
        await databaseManager.setActiveDatabase(datasourceName, databaseName);
        // 可选：后台尝试用完整节点更新（用于依赖树结构的逻辑）
        try {
          const connections = provider.getConnections();
          const connectionData = connections.find(
            (conn) => conn.name === datasourceName
          );
          if (connectionData) {
            const connection = new Datasource(connectionData);
            const objects = await connection.expand(context);
            const datasourceTypeNode = objects.find(
              (obj) => obj.type === 'datasourceType'
            );
            if (datasourceTypeNode) {
              const databases = await datasourceTypeNode.expand(context);
              const database = databases.find(
                (db) => db.label === databaseName
              );
              if (database) {
                databaseManager.setCurrentDatabase(database, true);
              }
            }
          }
        } catch (error) {
          console.error('[Notebook] 后台加载数据库节点失败:', error);
        }
      }
    })
  );

  // 已选择数据库时显示的按钮，点击可更换（同 selectDatabase）
  context.subscriptions.push(
    vscode.commands.registerCommand('cadb.notebook.currentDatabase', async () => {
      await databaseManager.selectDatabase();
    })
  );

  // Cell 底部执行栏（kernel 选择器左侧）：展示该 cell 的数据源/库，点击可设置或切换
  try {
    const registerFn = (vscode.notebooks as any).registerNotebookCellStatusBarItemProvider;
    if (typeof registerFn === 'function') {
      const Right = (vscode as any).NotebookCellStatusBarAlignment?.Right ?? 1;
      context.subscriptions.push(
        registerFn.call(vscode.notebooks, { viewType: 'cadb.sqlNotebook' }, {
          provideCellStatusBarItems: (cell: vscode.NotebookCell, _token: vscode.CancellationToken) => {
            const cadb = cell.metadata?.cadb as { datasource?: string; database?: string } | undefined;
            const ds = cadb?.datasource ?? '';
            const db = cadb?.database ?? '';
            const text = ds && db ? `${ds} / ${db}` : '$(database) 设置数据源';
            return [{
              text,
              alignment: Right,
              command: { command: 'cadb.notebook.setCellDatabase', arguments: [cell] },
              tooltip: ds && db ? `点击更换数据源：${ds} / ${db}` : '点击设置该 Cell 的数据源',
            }];
          },
        })
      );
    }
  } catch (e) {
    console.warn('[CADB] registerNotebookCellStatusBarItemProvider 不可用:', e);
  }

  // 为当前 Cell 单独设置数据库连接（保存到 cell.metadata）
  context.subscriptions.push(
    vscode.commands.registerCommand('cadb.notebook.setCellDatabase', async (cell?: vscode.NotebookCell) => {
      const editor = vscode.window.activeNotebookEditor;
      if (!editor || editor.notebook.notebookType !== 'cadb.sqlNotebook') return;
      let targetCell: vscode.NotebookCell | undefined = cell;
      if (!targetCell) {
        const sel = (editor as any).selection;
        if (sel && typeof sel.start === 'number') {
          targetCell = editor.notebook.cellAt(sel.start);
        }
        targetCell ??= editor.notebook.getCells()[0];
      }
      if (!targetCell || !targetCell.notebook) return;
      await databaseManager.selectDatabase();
      const conn = databaseManager.getCurrentConnection();
      const db = databaseManager.getCurrentDatabase();
      if (!conn || !db) return;
      const datasource = conn.label?.toString() ?? '';
      const database = db.label?.toString() ?? '';
      const edit = new vscode.WorkspaceEdit();
      const newMetadata = { ...targetCell.metadata, cadb: { datasource, database } };
      edit.set(targetCell.notebook.uri, [vscode.NotebookEdit.updateCellMetadata(targetCell.index, newMetadata)]);
      await vscode.workspace.applyEdit(edit);
      vscode.window.showInformationMessage(`已为 Cell 设置: ${datasource} / ${database}`);
    })
  );

  // 收起/展开全部结果：通过 createRendererMessaging 发到 renderer
  const rendererMessaging = vscode.notebooks.createRendererMessaging('cadb.sql-notebook-renderer');
  context.subscriptions.push(
    vscode.commands.registerCommand('cadb.notebook.collapseAllResults', () => {
      const editor = vscode.window.activeNotebookEditor;
      if (editor?.notebook?.notebookType !== 'cadb.sqlNotebook') return;
      void rendererMessaging.postMessage({ type: 'collapseAll' }, editor);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('cadb.notebook.expandAllResults', () => {
      const editor = vscode.window.activeNotebookEditor;
      if (editor?.notebook?.notebookType !== 'cadb.sqlNotebook') return;
      void rendererMessaging.postMessage({ type: 'expandAll' }, editor);
    })
  );

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

  // SQL CodeLens 提供者（在 SQL 语句上方显示 Run 和 Explain）
  const sqlCodeLensProvider = new SqlCodeLensProvider(databaseManager);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { language: "sql", scheme: "file" },
      sqlCodeLensProvider
    )
  );

  // SQL 悬浮提示（表名展示 DDL，字段名展示类型、备注等）
  const sqlHoverProvider = new SqlHoverProvider();
  sqlHoverProvider.setProvider(provider);
  sqlHoverProvider.setDatabaseManager(databaseManager);
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ language: "sql" }, sqlHoverProvider)
  );

  // 表名悬浮弹窗的快捷命令：进入表数据、表编辑
  // 使用无参 command 链接，点击时从 lastHoveredTableInfo 读取（hover 内传参在某些环境下不生效）
  const resolveTableFromArgs = (args: unknown): [string, string, string] | null => {
    if (Array.isArray(args) && args.length >= 3) {
      return [String(args[0]), String(args[1]), String(args[2])];
    }
    if (typeof args === "string") {
      try {
        const arr = JSON.parse(args);
        return Array.isArray(arr) && arr.length >= 3
          ? [String(arr[0]), String(arr[1]), String(arr[2])]
          : null;
      } catch {
        return null;
      }
    }
    const last = lastHoveredTableInfo;
    return last ? [last.conn, last.db, last.table] : null;
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("cadb.hover.openTableData", async (args: unknown) => {
      const parsed = resolveTableFromArgs(args);
      if (!parsed) return;
      const [conn, db, table] = parsed;
      const ds = await resolveTableDatasource(provider, context, conn, db, table);
      if (ds) await vscode.commands.executeCommand("cadb.item.showData", ds);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("cadb.hover.editTable", async (args: unknown) => {
      const parsed = resolveTableFromArgs(args);
      if (!parsed) return;
      const [conn, db, table] = parsed;
      const ds = await resolveTableDatasource(provider, context, conn, db, table);
      if (ds) await vscode.commands.executeCommand("cadb.datasource.edit", ds);
    })
  );

  // 工作区符号：将 MySQL 数据表加入「转到工作区中的符号」(Ctrl/Cmd+T)，选择表可快速打开表数据
  const mysqlTableSymbolProvider = new MySQLTableWorkspaceSymbolProvider(
    provider,
    context
  );
  context.subscriptions.push(
    vscode.languages.registerWorkspaceSymbolProvider(mysqlTableSymbolProvider)
  );

  // cadb:// 虚拟文档：从工作区符号打开表时，提供占位内容并触发「查看数据」打开表面板
  const cadbTableContentProvider = new CadbTableDocumentContentProvider(
    provider,
    context
  );
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      "cadb",
      cadbTableContentProvider
    )
  );

  // SQL 执行器
  const sqlExecutor = new SqlExecutor(provider, databaseManager, resultProvider, outputChannel);
  context.subscriptions.push(sqlExecutor);

  // 注册 SQL 执行命令
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cadb.sql.run",
      async (uri: string, range: vscode.Range) => {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
        const sql = document.getText(range).trim();
        if (sql) {
          // 检查是否选择了数据库
          const currentConnection = databaseManager.getCurrentConnection();
          const currentDatabase = databaseManager.getCurrentDatabase();

          if (!currentConnection || !currentDatabase) {
            // 如果没有选择数据库，提示用户选择
            const choice = await vscode.window.showWarningMessage(
              '没有选择数据库连接，请先选择数据库连接',
              { modal: true },
              '选择数据库', '取消'
            );

            if (choice === '选择数据库') {
              await databaseManager.selectDatabase();
              
              // 再次检查是否选择了数据库
              const newConnection = databaseManager.getCurrentConnection();
              const newDatabase = databaseManager.getCurrentDatabase();
              
              if (!newConnection || !newDatabase) {
                vscode.window.showErrorMessage('未选择数据库连接，无法执行SQL');
                return;
              }
            } else {
              return; // 用户取消执行
            }
          }

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
      async (uri: string, range: vscode.Range) => {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
        const sql = document.getText(range).trim();
        if (sql) {
          // 检查是否选择了数据库
          const currentConnection = databaseManager.getCurrentConnection();
          const currentDatabase = databaseManager.getCurrentDatabase();

          if (!currentConnection || !currentDatabase) {
            // 如果没有选择数据库，提示用户选择
            const choice = await vscode.window.showWarningMessage(
              '没有选择数据库连接，请先选择数据库连接',
              { modal: true },
              '选择数据库', '取消'
            );

            if (choice === '选择数据库') {
              await databaseManager.selectDatabase();
              
              // 再次检查是否选择了数据库
              const newConnection = databaseManager.getCurrentConnection();
              const newDatabase = databaseManager.getCurrentDatabase();
              
              if (!newConnection || !newDatabase) {
                vscode.window.showErrorMessage('未选择数据库连接，无法执行SQL');
                return;
              }
            } else {
              return; // 用户取消执行
            }
          }

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
