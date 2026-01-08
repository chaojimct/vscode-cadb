// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { DataSourceProvider } from "./provider/database_provider";
import { Datasource } from "./provider/entity/datasource";
import {
	registerCodeLensCommands,
  registerDatasourceCommands,
  registerDatasourceItemCommands,
  registerEditorCommands,
  registerResultCommands,
} from "./provider/component/commands";
import { SqlNotebookSerializer } from "./provider/component/sql_notebook_serializer";
import { SqlNotebookController } from "./provider/component/sql_notebook_controller";
import { SqlNotebookRenderer } from "./provider/component/sql_notebook_renderer";
import { SQLCodeLensProvider } from "./provider/sql_provider";
import { CaEditor } from "./provider/component/editor";
import { ResultWebviewProvider } from "./provider/result_provider";
import { CaCompletionItemProvider } from "./provider/completion_item_provider";

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
  // SQL 编辑器（带数据库选择器）
  const editor = new CaEditor(provider);
  provider.setEditor(editor);
  const databaseSelector = registerEditorCommands(editor);
  context.subscriptions.push(editor);
  context.subscriptions.push(databaseSelector); // 注册数据库选择器

  // 数据项命令
  registerDatasourceItemCommands(provider, outputChannel, editor);

  // CodeLens
  const sqlCodeLens = new SQLCodeLensProvider(outputChannel);
  vscode.languages.registerCodeLensProvider("sql", sqlCodeLens);
	registerCodeLensCommands(sqlCodeLens);

  // SQL 执行器需要 editor 引用
  sqlCodeLens.setEditor(editor);

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
    context
  );
  context.subscriptions.push(notebookController);

  // SQL Notebook 渲染器（渲染查询结果和错误）
  const notebookRenderer = new SqlNotebookRenderer(context);
  context.subscriptions.push(notebookRenderer);

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

  context.subscriptions.push(
    vscode.commands.registerCommand('cadb.notebook.selectConnection', async (notebook?: vscode.NotebookDocument) => {
      // 如果没有传入 notebook，尝试获取当前活动的 notebook
      let targetNotebook = notebook;
      if (!targetNotebook) {
        const activeEditor = vscode.window.activeNotebookEditor;
        if (activeEditor && activeEditor.notebook.notebookType === 'cadb.sqlNotebook') {
          targetNotebook = activeEditor.notebook;
        } else {
          vscode.window.showWarningMessage('请先打开一个 SQL Notebook 文件');
          return;
        }
      }

      if (!targetNotebook) {
        return;
      }

      // 选择数据源
      const datasources = provider.model.map(ds => {
        const host = (ds as any).data?.host || (ds as any).host || '';
        const port = (ds as any).data?.port || (ds as any).port || '';
        return {
          label: ds.name,
          description: `${host}:${port}`,
          datasource: ds
        };
      });

      if (datasources.length === 0) {
        vscode.window.showWarningMessage('没有可用的数据源，请先添加数据源');
        return;
      }

      const selectedDatasource = await vscode.window.showQuickPick(datasources, {
        placeHolder: '选择数据源'
      });

      if (!selectedDatasource) {
        return;
      }

      // 选择数据库
      try {
        const datasource = new Datasource(selectedDatasource.datasource);
        const objects = await datasource.expand(context);
        const datasourceTypeNode = objects.find(obj => obj.type === 'datasourceType');

        if (!datasourceTypeNode) {
          vscode.window.showWarningMessage('无法获取数据库列表');
          return;
        }

        const databases = await datasourceTypeNode.expand(context);
        const databaseItems = databases.map(db => ({
          label: db.label?.toString() || '',
          description: db.description?.toString() || '',
          database: db.label?.toString() || ''
        }));

        if (databaseItems.length === 0) {
          vscode.window.showWarningMessage('该数据源没有可用的数据库');
          return;
        }

        const selectedDatabase = await vscode.window.showQuickPick(databaseItems, {
          placeHolder: '选择数据库'
        });

        if (!selectedDatabase) {
          return;
        }

        // 更新 notebook metadata
        const edit = new vscode.WorkspaceEdit();
        const notebookEdit = vscode.NotebookEdit.updateNotebookMetadata({
          datasource: selectedDatasource.label,
          database: selectedDatabase.database
        });
        edit.set(targetNotebook.uri, [notebookEdit]);
        
        const success = await vscode.workspace.applyEdit(edit);
        if (success) {
          // 更新控制器描述以显示当前选择的数据源
          notebookController.updateDescription(targetNotebook);
          
          vscode.window.showInformationMessage(
            `已设置数据源: ${selectedDatasource.label}, 数据库: ${selectedDatabase.database}`
          );
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `选择数据库失败: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })
  );

  // SQL 自动补全（支持普通 SQL 文件和 Notebook）
  const completionProvider = new CaCompletionItemProvider();
  completionProvider.setEditor(editor);
  completionProvider.setProvider(provider);
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: "sql", notebookType: "cadb.sqlNotebook" },
      completionProvider,
      ".", // 触发字符：点号用于 table.column
      " " // 触发字符：空格用于关键字后
    )
  );
}

// This method is called when your extension is deactivated
export function deactivate() {}
