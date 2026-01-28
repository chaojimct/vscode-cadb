import * as vscode from "vscode";
import { DataSourceProvider } from "./database_provider";
import path from "path";
import { generateNonce } from "./utils";

export function createWebview(
  provider: DataSourceProvider,
  viewType: "settings" | "datasourceTable" | "tableEdit" | "items",
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
		font-src ${panel.webview.cspSource} data:;
    style-src ${panel.webview.cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}' ${panel.webview.cspSource} 'self' 'unsafe-eval';
    connect-src ${panel.webview.cspSource};
    worker-src ${panel.webview.cspSource} blob:;
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
