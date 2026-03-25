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
  registerGridSidePanelCommand,
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
import { registerBuiltinDatabaseDrivers } from "./provider/drivers/builtin_drivers";
import { getMysqlPoolRegistry } from "./provider/mysql/pool_registry";
import { format as formatSql } from "sql-formatter";

interface SqlStatementSpan {
  start: number;
  end: number;
}

interface SqlFileDatabaseBinding {
  datasource: string;
  database: string;
  updatedAt: number;
}

const SQL_FILE_DATABASE_STATE_KEY = "cadb.sqlFileDatabaseBindings";

function parseSqlStatementSpans(text: string): SqlStatementSpan[] {
  const spans: SqlStatementSpan[] = [];
  let start = 0;
  let i = 0;
  let inString = false;
  let stringChar = "";
  let inLineComment = false;
  let inBlockComment = false;

  while (i < text.length) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : "";

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (!inString && (ch === "-" && next === "-" || ch === "#")) {
      inLineComment = true;
      i += ch === "-" ? 2 : 1;
      continue;
    }
    if (!inString && ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      if (!inString) {
        inString = true;
        stringChar = ch;
      } else if (stringChar === ch) {
        const escaped = text[i - 1] === "\\" || next === ch;
        if (!escaped) {
          inString = false;
          stringChar = "";
        } else if (next === ch) {
          i++;
        }
      }
      i++;
      continue;
    }

    if (!inString && ch === ";") {
      spans.push({ start, end: i + 1 });
      start = i + 1;
    }
    i++;
  }

  if (start < text.length) {
    spans.push({ start, end: text.length });
  }
  return spans;
}

function splitSqlStatements(text: string): string[] {
  return parseSqlStatementSpans(text)
    .map(span => text.slice(span.start, span.end).trim())
    .filter(Boolean);
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  registerBuiltinDatabaseDrivers();

  // 创建输出通道用于显示 SQL 执行日志
  const outputChannel = vscode.window.createOutputChannel("CADB SQL");
  context.subscriptions.push(outputChannel);

  const provider = new DataSourceProvider(context);
  const treeView = vscode.window.createTreeView("cadb-datasource-tree", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);
  treeView.onDidExpandElement((e) => provider.addExpandedNode(e.element));
  treeView.onDidCollapseElement((e) => provider.removeExpandedNode(e.element));

  const datasourceCommands = registerDatasourceCommands(
    provider,
    treeView,
    outputChannel
  );
  datasourceCommands.forEach((cmd) => context.subscriptions.push(cmd));

  // 恢复展开状态（延迟执行，等待树视图初始化完成）
  setTimeout(() => {
    (async () => {
      try {
        const treeState = provider.getTreeState();
        if (treeState?.expandedNodes?.length) {
          const restoreExpandedState = async (
            element: Datasource,
            expandedNodes: string[]
          ): Promise<void> => {
            const nodePath = provider.getNodePath(element);
            if (expandedNodes.includes(nodePath)) {
              try {
                await treeView.reveal(element, { expand: true });
                await new Promise((resolve) => setTimeout(resolve, 100));
              } catch (_e) {
                /* 节点可能尚未加载 */
              }
            }
            if (element.children && element.children.length > 0) {
              for (const child of element.children) {
                await restoreExpandedState(child, expandedNodes);
              }
            }
          };
          const rootItems = provider.getRootNodes();
          for (const rootItem of rootItems) {
            await restoreExpandedState(rootItem, treeState.expandedNodes);
          }
        }
      } catch (error) {
        console.error("恢复展开状态失败:", error);
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

  const getSqlFileKey = (document: vscode.TextDocument): string | undefined => {
    if (document.languageId !== "sql") return undefined;
    return document.uri.toString();
  };

  const getSqlFileBindings = (): Record<string, SqlFileDatabaseBinding> => {
    return context.workspaceState.get<Record<string, SqlFileDatabaseBinding>>(
      SQL_FILE_DATABASE_STATE_KEY,
      {}
    );
  };

  const persistSelectionForDocument = async (document: vscode.TextDocument): Promise<void> => {
    const key = getSqlFileKey(document);
    if (!key) return;
    const connection = databaseManager.getCurrentConnection();
    const database = databaseManager.getCurrentDatabase();
    if (!connection || !database) return;
    const datasource = connection.label?.toString() ?? "";
    const databaseName = database.label?.toString() ?? "";
    if (!datasource || !databaseName) return;

    const bindings = getSqlFileBindings();
    bindings[key] = {
      datasource,
      database: databaseName,
      updatedAt: Date.now(),
    };
    await context.workspaceState.update(SQL_FILE_DATABASE_STATE_KEY, bindings);
  };

  const persistSelectionForActiveSqlEditor = async (): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    await persistSelectionForDocument(editor.document);
  };

  const applyStoredSelectionForDocument = async (document: vscode.TextDocument): Promise<boolean> => {
    const key = getSqlFileKey(document);
    if (!key) return false;
    const bindings = getSqlFileBindings();
    const saved = bindings[key];
    if (!saved?.datasource || !saved?.database) return false;

    const currentConnection = databaseManager.getCurrentConnection();
    const currentDatabase = databaseManager.getCurrentDatabase();
    const sameAsCurrent =
      currentConnection?.label?.toString() === saved.datasource &&
      currentDatabase?.label?.toString() === saved.database;
    if (sameAsCurrent) return true;

    const ok = await databaseManager.setActiveDatabase(saved.datasource, saved.database);
    if (!ok) {
      delete bindings[key];
      await context.workspaceState.update(SQL_FILE_DATABASE_STATE_KEY, bindings);
      return false;
    }
    return true;
  };
  
  // 创建数据库状态栏管理器
  const databaseStatusBar = new DatabaseStatusBar(databaseManager);
  context.subscriptions.push(databaseStatusBar);

  const databaseSelector = registerDatabaseCommands(databaseManager);
  context.subscriptions.push(databaseSelector); // 注册数据库选择器

  // 注册选择数据库命令
  context.subscriptions.push(
    vscode.commands.registerCommand('cadb.selectDatabase', async () => {
      await databaseManager.selectDatabase();
      await persistSelectionForActiveSqlEditor();
    })
  );

  // 数据库切换后，如果当前是 SQL 文件则自动记忆到该文件
  context.subscriptions.push(
    databaseManager.onDidChangeDatabase(() => {
      void persistSelectionForActiveSqlEditor();
    })
  );

  // 切换到 SQL 文件时自动恢复该文件上次使用的数据源
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.languageId === "sql") {
        void applyStoredSelectionForDocument(editor.document);
      }
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
  context.subscriptions.push(registerGridSidePanelCommand());

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
        console.log(`[Notebook] 检测到连接信息: ${datasourceName} / ${databaseName}`);
        // 立即设置数据库状态，确保顶部工具栏/状态栏能回显（不依赖后续展开）
        const ok = await databaseManager.setActiveDatabase(datasourceName, databaseName);
        if (ok) {
          console.log(`[Notebook] 已回显数据库: ${datasourceName} / ${databaseName}`);
        }
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
      { language: "sql" },
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
  context.subscriptions.push(
    new vscode.Disposable(() => sqlHoverProvider.dispose())
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

  const getActiveSqlEditor = (): vscode.TextEditor | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    if (editor.document.languageId !== "sql") return undefined;
    return editor;
  };

  const executeSqlStatements = async (document: vscode.TextDocument, sqlText: string): Promise<void> => {
    await applyStoredSelectionForDocument(document);
    const statements = splitSqlStatements(sqlText);
    if (statements.length === 0) {
      vscode.window.showWarningMessage("没有可执行的 SQL 语句");
      return;
    }
    for (const stmt of statements) {
      await sqlExecutor.executeSql(stmt, document);
    }
    await persistSelectionForDocument(document);
    sqlCodeLensProvider.refresh();
  };

  // 运行当前语句（按分号拆分，取光标所在语句）
  context.subscriptions.push(
    vscode.commands.registerCommand("cadb.sql.runCurrent", async () => {
      const editor = getActiveSqlEditor();
      if (!editor) return;
      await applyStoredSelectionForDocument(editor.document);
      const text = editor.document.getText();
      const spans = parseSqlStatementSpans(text);
      if (spans.length === 0) {
        vscode.window.showWarningMessage("没有可执行的 SQL 语句");
        return;
      }
      const cursorOffset = editor.document.offsetAt(editor.selection.active);
      const currentSpan =
        spans.find(s => cursorOffset >= s.start && cursorOffset <= s.end) ??
        spans.find(s => text.slice(s.start, s.end).trim().length > 0);
      if (!currentSpan) {
        vscode.window.showWarningMessage("没有可执行的 SQL 语句");
        return;
      }
      const sql = text.slice(currentSpan.start, currentSpan.end).trim();
      if (!sql) {
        vscode.window.showWarningMessage("当前语句为空");
        return;
      }
      await sqlExecutor.executeSql(sql, editor.document);
      await persistSelectionForDocument(editor.document);
      sqlCodeLensProvider.refresh();
    })
  );

  // 运行当前行
  context.subscriptions.push(
    vscode.commands.registerCommand("cadb.sql.runLine", async (uri?: string, line?: number) => {
      const editor = vscode.window.activeTextEditor;
      const targetUri =
        typeof uri === "string" && uri.length > 0
          ? vscode.Uri.parse(uri)
          : editor?.document.uri;
      if (!targetUri) return;

      const document = await vscode.workspace.openTextDocument(targetUri);
      await applyStoredSelectionForDocument(document);
      const targetLine =
        typeof line === "number" ? line : editor?.document.uri.toString() === targetUri.toString()
          ? editor.selection.active.line
          : 0;
      if (targetLine < 0 || targetLine >= document.lineCount) {
        vscode.window.showWarningMessage("当前行无效");
        return;
      }
      const sql = document.lineAt(targetLine).text.trim();
      if (!sql || sql.startsWith("--") || sql.startsWith("/*")) {
        vscode.window.showWarningMessage("当前行没有可执行 SQL");
        return;
      }
      await sqlExecutor.executeSql(sql, document);
      await persistSelectionForDocument(document);
      sqlCodeLensProvider.refresh();
    })
  );

  // 运行选中 SQL（支持多条）
  context.subscriptions.push(
    vscode.commands.registerCommand("cadb.sql.runSelection", async () => {
      const editor = getActiveSqlEditor();
      if (!editor) return;
      const selected = editor.document.getText(editor.selection).trim();
      if (!selected) {
        vscode.window.showWarningMessage("请先选中要执行的 SQL");
        return;
      }
      await executeSqlStatements(editor.document, selected);
    })
  );

  // 运行全文 SQL（支持多条）
  context.subscriptions.push(
    vscode.commands.registerCommand("cadb.sql.runAll", async () => {
      const editor = getActiveSqlEditor();
      if (!editor) return;
      await executeSqlStatements(editor.document, editor.document.getText());
    })
  );

  // SQL 文档格式化（file/untitled）
  const sqlFormatterProvider: vscode.DocumentFormattingEditProvider = {
    provideDocumentFormattingEdits(document, options) {
      try {
        const formatted = formatSql(document.getText(), {
          language: "mysql",
          tabWidth: Number(options.tabSize) || 2,
          useTabs: !options.insertSpaces,
          keywordCase: "upper",
        } as any);
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length)
        );
        return [vscode.TextEdit.replace(fullRange, formatted)];
      } catch (error) {
        vscode.window.showErrorMessage(
          `SQL 格式化失败: ${error instanceof Error ? error.message : String(error)}`
        );
        return [];
      }
    },
  };
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(
      [{ language: "sql", scheme: "file" }, { language: "sql", scheme: "untitled" }],
      sqlFormatterProvider
    )
  );

  // 注册 SQL 执行命令
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "cadb.sql.run",
      async (uri: string, range: vscode.Range) => {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
        await applyStoredSelectionForDocument(document);
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
          await persistSelectionForDocument(document);
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
        await applyStoredSelectionForDocument(document);
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
          await persistSelectionForDocument(document);
          // 刷新 CodeLens
          sqlCodeLensProvider.refresh();
        }
      }
    )
  );
}

// This method is called when your extension is deactivated
export function deactivate() {
  getMysqlPoolRegistry().dispose();
}
