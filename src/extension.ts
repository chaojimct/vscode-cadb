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
  registerBookCommands,
} from "./provider/component/commands";
import { SqlNotebookProvider } from "./provider/component/sql_notebook_provider";
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
          const { Datasource: DatasourceClass } = await import('./provider/entity/datasource');
          const rootItems = (provider as any).model.map((e: any) => 
            new DatasourceClass(e)
          );
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

  // SQL Notebook (Book) 面板
  const bookCommand = registerBookCommands(provider, editor);
  context.subscriptions.push(bookCommand);

  // SQL Notebook 自定义编辑器（用于打开 .jsql 文件）
  const notebookProvider = SqlNotebookProvider.register(context, provider);
  context.subscriptions.push(notebookProvider);

  // SQL 自动补全
  const completionProvider = new CaCompletionItemProvider();
  completionProvider.setEditor(editor);
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      "sql",
      completionProvider,
      ".", // 触发字符：点号用于 table.column
      " " // 触发字符：空格用于关键字后
    )
  );
}

// This method is called when your extension is deactivated
export function deactivate() {}
