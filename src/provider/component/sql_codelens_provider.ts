import * as vscode from 'vscode';
import type { DatabaseManager } from './database_manager';

const QUERY_KEYWORDS = /^(SELECT|DESC|SHOW)\b/i;

export class SqlCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _databaseManager: DatabaseManager;
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

  constructor(databaseManager: DatabaseManager) {
    this._databaseManager = databaseManager;
  }

  provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
    const codeLenses: vscode.CodeLens[] = [];
    if (document.lineCount === 0) return codeLenses;
    if (document.uri.scheme === 'vscode-notebook-cell') return codeLenses;

    // 文件顶部：运行全部
    const topRange = document.lineAt(0).range;
    codeLenses.push(
      new vscode.CodeLens(topRange, {
        title: '$(play-circle) 运行全部',
        command: 'cadb.sql.runAll',
      })
    );

    // 每个非空非注释行：运行当前行
    for (let i = 0; i < document.lineCount; i++) {
      const lineObj = document.lineAt(i);
      const rawLine = lineObj.text;
      const trimmedLine = rawLine.trim();
      if (!trimmedLine || trimmedLine.startsWith('--') || trimmedLine.startsWith('#') || trimmedLine.startsWith('/*')) {
        continue;
      }

      const lineRange = lineObj.range;
      codeLenses.push(
        new vscode.CodeLens(lineRange, {
          title: '▶ 运行',
          command: 'cadb.sql.runLine',
          arguments: [document.uri.toString(), i],
        })
      );

      if (QUERY_KEYWORDS.test(trimmedLine)) {
        codeLenses.push(
          new vscode.CodeLens(lineRange, {
            title: '⚡ Explain',
            command: 'cadb.sql.explain',
            arguments: [document.uri.toString(), lineRange],
          })
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

