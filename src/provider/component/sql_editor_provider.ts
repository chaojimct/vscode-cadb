import * as vscode from 'vscode';

/**
 * SQL 自定义编辑器提供者
 * 用于打开和编辑 .sql 文件
 * 实际上使用文本编辑器，但通过注册自定义编辑器确保 .sql 文件使用我们的编辑器
 */
export class SqlEditorProvider implements vscode.CustomTextEditorProvider {
  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    // 设置 webview 选项
    webviewPanel.webview.options = {
      enableScripts: true,
    };

    // 创建简单的 HTML 内容，显示 SQL 文本
    // 但实际上，我们更倾向于使用文本编辑器
    // 这里提供一个基本的 webview 实现
    const updateWebview = () => {
      const sql = document.getText();
      webviewPanel.webview.html = this._getHtmlContent(sql);
    };

    // 监听文档变化
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        updateWebview();
      }
    });

    // 监听 webview 释放
    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
    });

    // 初始更新
    updateWebview();
  }

  private _getHtmlContent(sql: string): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SQL Editor</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 20px;
      margin: 0;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
  </style>
</head>
<body>
  <pre>${this._escapeHtml(sql)}</pre>
</body>
</html>`;
  }

  private _escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

