import * as vscode from "vscode";

/** 显示「Explain」：可与 EXPLAIN 配合的语句起始（含 DESC；CREATE/ALTER 等不显示） */
const EXPLAIN_STATEMENT_START =
  /^(SELECT|DESC|SHOW|INSERT|UPDATE|DELETE|REPLACE)\b/i;

export class SqlCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> =
    new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> =
    this._onDidChangeCodeLenses.event;

  provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
    const codeLenses: vscode.CodeLens[] = [];
    if (document.lineCount === 0) return codeLenses;
    if (document.uri.scheme === "vscode-notebook-cell") return codeLenses;

    // 不展示逐行「运行」CodeLens（避免格式化多行 SQL 时界面杂乱）；请用快捷键或命令面板执行语句
    for (let i = 0; i < document.lineCount; i++) {
      const lineObj = document.lineAt(i);
      const rawLine = lineObj.text;
      const trimmedLine = rawLine.trim();
      if (
        !trimmedLine ||
        trimmedLine.startsWith("--") ||
        trimmedLine.startsWith("#") ||
        trimmedLine.startsWith("/*")
      ) {
        continue;
      }

      const lineRange = lineObj.range;

      if (EXPLAIN_STATEMENT_START.test(trimmedLine)) {
        codeLenses.push(
          new vscode.CodeLens(lineRange, {
            title: "⚡ Explain",
            command: "cadb.sql.explain",
            arguments: [document.uri.toString(), lineRange],
          }),
        );
      }
    }

    return codeLenses;
  }

  /**
   * 刷新 CodeLens
   */
  public refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }
}
