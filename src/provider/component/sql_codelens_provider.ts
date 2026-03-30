import * as vscode from 'vscode';
import type { DatabaseManager } from './database_manager';

/** 显示「▶ 运行」：仅语句首行（trim 后以所列关键字开头，格式化后 FROM/WHERE 等行不显示） */
const RUN_STATEMENT_START =
  /^(SELECT|CREATE|DROP|UPDATE|ALTER|DELETE|SHOW|INSERT)\b/i;

/** 显示「Explain」：可与 EXPLAIN 配合的语句起始（含 DESC；CREATE/ALTER 等不显示） */
const EXPLAIN_STATEMENT_START =
  /^(SELECT|DESC|SHOW|INSERT|UPDATE|DELETE|REPLACE)\b/i;

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

    // 仅在语句起始关键字行显示「运行」；Explain 单独匹配（避免 CREATE/ALTER 等出现 Explain）
    for (let i = 0; i < document.lineCount; i++) {
      const lineObj = document.lineAt(i);
      const rawLine = lineObj.text;
      const trimmedLine = rawLine.trim();
      if (!trimmedLine || trimmedLine.startsWith('--') || trimmedLine.startsWith('#') || trimmedLine.startsWith('/*')) {
        continue;
      }

      const lineRange = lineObj.range;

      if (RUN_STATEMENT_START.test(trimmedLine)) {
        codeLenses.push(
          new vscode.CodeLens(lineRange, {
            title: '▶ 运行',
            command: 'cadb.sql.runLine',
            arguments: [document.uri.toString(), i],
          })
        );
      }

      if (EXPLAIN_STATEMENT_START.test(trimmedLine)) {
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

