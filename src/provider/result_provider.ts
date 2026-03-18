import * as vscode from "vscode";
import path from "path";
import { readFileSync } from "fs";
import { generateNonce } from "./utils";

const MAX_HISTORY_TABS = 30;
const MAX_ROWS_PER_HISTORY = 200;

/**
 * 查询结果 Webview Provider
 * 显示在 VSCode 底部面板（与终端、输出等一起）
 * 支持历史记录保存与 Tab 切换
 */
export class ResultWebviewProvider implements vscode.WebviewViewProvider {
  private webviewView?: vscode.WebviewView;
  private context: vscode.ExtensionContext;
  private htmlTemplate: string;
  private isWebviewReady: boolean = false;
  private pendingMessages: any[] = [];
  private resultCounter: number = 0; // 查询结果编号计数器
  private historyTabs: any[] = [];

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.htmlTemplate = readFileSync(
      path.join(
        this.context.extensionPath,
        "resources",
        "panels",
        "result.html"
      ),
      "utf-8"
    );
  }

  /**
   * 实现 WebviewViewProvider 接口
   * VSCode 调用此方法来解析 webview view
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ): void | Thenable<void> {
    this.webviewView = webviewView;
    this.isWebviewReady = false;
    this.pendingMessages = [];

    // 配置 webview 选项
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(
          path.join(this.context.extensionPath, "resources", "panels")
        ),
        vscode.Uri.file(path.join(this.context.extensionPath, "node_modules")),
      ],
    };

    // 设置 HTML 内容
    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // 监听来自 webview 的消息
    webviewView.webview.onDidReceiveMessage((message) => {
      if (message.command === "ready") {
        this.isWebviewReady = true;

        // 先恢复历史记录
        this.restoreHistory();

        // 发送所有待处理的消息
        this.pendingMessages.forEach((msg) => {
          this.webviewView?.webview.postMessage(msg);
        });
        this.pendingMessages = [];
      } else if (message.command === "saveHistory") {
        this.saveHistoryTab(message);
      } else if (message.command === "clearHistory") {
        this.historyTabs = [];
        this.context.globalState.update("cadb.queryHistory", undefined);
      }
    });

    // 监听 webview 可见性变化
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this.pendingMessages.length > 0) {
        // 如果 webview 变为可见且有待处理的消息，尝试发送
        if (this.isWebviewReady) {
          this.pendingMessages.forEach((msg) => {
            this.webviewView?.webview.postMessage(msg);
          });
          this.pendingMessages = [];
        }
      }
    });

    // 监听 webview 释放
    webviewView.onDidDispose(() => {
      this.webviewView = undefined;
      this.isWebviewReady = false;
      this.pendingMessages = [];
    });
  }

  /**
   * 显示查询结果
   */
  public showResult(result: any, sql: string): void {
    // 准备结果消息
    const message = this.prepareResultMessage(result, sql);

    // 如果 webview 已就绪，立即发送；否则加入队列
    if (this.webviewView && this.isWebviewReady) {
      this.webviewView.webview.postMessage(message);
      // 显示面板
      this.revealView();
    } else {
      this.pendingMessages.push(message);
      // 尝试显示面板（会触发 resolveWebviewView）
      this.revealView();
    }
  }

  /**
   * 显示错误消息
   */
  public showError(error: string, sql: string): void {
    // 准备错误消息
    const message = {
      command: "showMessage",
      title: "执行失败",
      text: error,
      type: "error",
      id: `error-${Date.now()}`,
      pinned: false,
    };

    // 如果 webview 已就绪，立即发送；否则加入队列
    if (this.webviewView && this.isWebviewReady) {
      this.webviewView.webview.postMessage(message);
      // 显示面板
      this.revealView();
    } else {
      this.pendingMessages.push(message);
      // 尝试显示面板（会触发 resolveWebviewView）
      this.revealView();
    }
  }

  /**
   * 显示 webview 面板
   */
  private revealView(): void {
    // 显示底部面板（如果已创建）
    if (this.webviewView) {
      this.webviewView.show?.(true); // true 表示保留焦点在编辑器
    } else {
      // 如果 webview 尚未创建，通过命令显示面板
      vscode.commands.executeCommand("query.focus");
    }
  }

  /**
   * 准备结果消息
   */
  private prepareResultMessage(result: any, sql: string): any {
    // 提取列定义
    const columns =
      result.fields?.map((field: any) => ({
        field: field.name,
        type: field.type,
      })) || [];

    // 提取数据
    const data = Array.isArray(result.results) ? result.results : [];

    // 获取执行时间（秒）
    const executionTime = result.executionTime || 0;
    const timeDisplay = executionTime < 0.01 
      ? '<0.01s' 
      : `${executionTime.toFixed(2)}s`;

    // 递增结果编号
    this.resultCounter++;

    // 生成标签标题（包含编号）
    const title = `结果 #${this.resultCounter} (${timeDisplay})`;

    return {
      command: "showResult",
      title: title,
      columns: columns,
      data: data,
      executionTime: executionTime,
      rowCount: data.length,
      id: `result-${Date.now()}`,
      pinned: false,
    };
  }

  /**
   * 保存单个标签到历史（供下次恢复）
   */
  private saveHistoryTab(msg: any): void {
    const tab: any = { id: msg.tabId, pinned: msg.pinned || false };
    if (msg.columns && msg.data) {
      tab.type = "result";
      tab.title = msg.title;
      tab.columns = msg.columns;
      tab.data = Array.isArray(msg.data)
        ? msg.data.slice(0, MAX_ROWS_PER_HISTORY)
        : [];
    } else if (msg.text !== undefined) {
      tab.type = "message";
      tab.title = msg.title;
      tab.text = msg.text;
      tab.messageType = msg.type || "info";
    } else {
      return;
    }
    this.historyTabs = this.historyTabs.filter((t) => t.id !== tab.id);
    this.historyTabs.push(tab);
    if (this.historyTabs.length > MAX_HISTORY_TABS) {
      this.historyTabs = this.historyTabs.slice(-MAX_HISTORY_TABS);
    }
    this.context.globalState.update("cadb.queryHistory", this.historyTabs);
  }

  /**
   * 恢复历史记录到 webview
   */
  private restoreHistory(): void {
    const saved = this.context.globalState.get<any[]>("cadb.queryHistory");
    if (saved && saved.length > 0) {
      this.historyTabs = saved;
      this.webviewView?.webview.postMessage({
        command: "restoreHistory",
        tabs: this.historyTabs,
      });
    }
  }

  /**
   * 获取 HTML 内容
   */
  private getHtmlContent(webview: vscode.Webview): string {
    const resourcesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "resources", "panels")
    );
    const nodeResourcesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "node_modules")
    );
    const nonce = generateNonce();

    return this.htmlTemplate
      .replace(
        /{{csp}}/g,
        `
    default-src 'none';
    img-src ${webview.cspSource} data:;
    font-src ${webview.cspSource};
    style-src ${webview.cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}';
    connect-src ${webview.cspSource};
  `.trim()
      )
      .replace(/{{node-resources-uri}}/g, nodeResourcesUri.toString())
      .replace(/{{resources-uri}}/g, resourcesUri.toString())
      .replace(/{{resource-nonce}}/g, nonce);
  }
}
