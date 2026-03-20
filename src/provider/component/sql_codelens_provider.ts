import * as vscode from 'vscode';
import type { DatabaseManager } from './database_manager';

/** 可执行 SQL 语句的关键字（行首、词边界匹配，用于 CodeLens） */
const SQL_STATEMENT_KEYWORDS =
  'SELECT|CREATE|DROP|UPDATE|ALTER|DESC|SHOW|INSERT|DELETE|TRUNCATE|REPLACE|MERGE';
/** 支持 Explain 的语句（查询类） */
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
    const text = document.getText();
    const lines = text.split('\n');

    // 行首匹配任意可执行语句关键字（\b 保证 "select" 单独一行也匹配）
    const statementRegex = new RegExp(`^\\s*(${SQL_STATEMENT_KEYWORDS})\\b`, 'i');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      if (!trimmedLine || trimmedLine.startsWith('--') || trimmedLine.startsWith('/*')) {
        continue;
      }

      const match = trimmedLine.match(statementRegex);
      if (!match) continue;

      const sqlRange = this._findSqlStatementRange(document, i, lines);
      if (!sqlRange) continue;

      const runCommand: vscode.CodeLens = new vscode.CodeLens(sqlRange, {
        title: '$(play) Run',
        command: 'cadb.sql.run',
        arguments: [document.uri.toString(), sqlRange],
      });
      codeLenses.push(runCommand);

      if (QUERY_KEYWORDS.test(match[1])) {
        codeLenses.push(
          new vscode.CodeLens(sqlRange, {
            title: '$(search) Explain',
            command: 'cadb.sql.explain',
            arguments: [document.uri.toString(), sqlRange],
          })
        );
      }
    }

    return codeLenses;
  }

  /**
   * 从文档开头到 (line, 0) 的括号深度（忽略字符串与注释）
   */
  private _parenDepthBefore(lines: string[], line: number): number {
    let depth = 0;
    let inString = false;
    let stringChar = '';
    let inComment = false;
    let commentType: 'single' | 'multi' | null = null;
    for (let i = 0; i < line && i < lines.length; i++) {
      const lineStr = lines[i];
      for (let j = 0; j < lineStr.length; j++) {
        const char = lineStr[j];
        const nextChar = j < lineStr.length - 1 ? lineStr[j + 1] : '';
        if (!inComment) {
          if ((char === '"' || char === "'" || char === '`') && (j === 0 || lineStr[j - 1] !== '\\')) {
            if (!inString) {
              inString = true;
              stringChar = char;
            } else if (char === stringChar) {
              inString = false;
              stringChar = '';
            }
            continue;
          }
        }
        if (!inString) {
          if (!inComment && char === '-' && nextChar === '-') break;
          if (!inComment && char === '/' && nextChar === '*') {
            inComment = true;
            commentType = 'multi';
            j++;
            continue;
          }
          if (inComment && commentType === 'multi' && char === '*' && nextChar === '/') {
            inComment = false;
            commentType = null;
            j++;
            continue;
          }
        }
        if (!inString && !inComment) {
          if (char === '(') depth++;
          else if (char === ')') depth--;
        }
      }
    }
    return depth;
  }

  /**
   * 查找 SQL 语句的范围（可能跨多行）；对嵌套子查询用括号深度区分，避免多个 SELECT 共用一个范围
   */
  private _findSqlStatementRange(
    document: vscode.TextDocument,
    startLine: number,
    lines: string[]
  ): vscode.Range | null {
    const startParenDepth = this._parenDepthBefore(lines, startLine);
    let endLine = startLine;
    let inString = false;
    let stringChar = '';
    let inComment = false;
    let commentType: 'single' | 'multi' | null = null;
    let depth = startParenDepth;

    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i];

      for (let j = 0; j < line.length; j++) {
        const char = line[j];
        const nextChar = j < line.length - 1 ? line[j + 1] : '';

        if (!inComment) {
          if ((char === '"' || char === "'" || char === '`') && (j === 0 || line[j - 1] !== '\\')) {
            if (!inString) {
              inString = true;
              stringChar = char;
            } else if (char === stringChar) {
              inString = false;
              stringChar = '';
            }
            continue;
          }
        }

        if (!inString) {
          if (!inComment && char === '-' && nextChar === '-') {
            break;
          }
          if (!inComment && char === '/' && nextChar === '*') {
            inComment = true;
            commentType = 'multi';
            j++;
            continue;
          }
          if (inComment && commentType === 'multi' && char === '*' && nextChar === '/') {
            inComment = false;
            commentType = null;
            j++;
            continue;
          }
        }

        if (!inString && !inComment) {
          if (char === '(') depth++;
          else if (char === ')') {
            depth--;
            // 子查询：当前语句在括号内开始时，在匹配的 ) 处结束
            if (depth === startParenDepth - 1) {
              const startPos = new vscode.Position(startLine, 0);
              const endPos = new vscode.Position(i, j + 1);
              return new vscode.Range(startPos, endPos);
            }
          }
        }

        if (!inString && !inComment && char === ';') {
          const startPos = new vscode.Position(startLine, 0);
          const endPos = new vscode.Position(i, j + 1);
          return new vscode.Range(startPos, endPos);
        }
      }

      // 仅顶层：下一行为同级新语句时在此行末结束
      if (!inString && !inComment && i > startLine && startParenDepth === 0 && depth === 0) {
        const nextLine = i < lines.length - 1 ? lines[i + 1] : '';
        const trimmedNext = nextLine.trim();
        if (trimmedNext && new RegExp(`^\\s*(${SQL_STATEMENT_KEYWORDS})\\b`, 'i').test(trimmedNext)) {
          const startPos = new vscode.Position(startLine, 0);
          const endPos = new vscode.Position(i, lines[i].length);
          return new vscode.Range(startPos, endPos);
        }
      }

      endLine = i;
    }

    if (endLine >= startLine) {
      const startPos = new vscode.Position(startLine, 0);
      const endPos = new vscode.Position(endLine, lines[endLine].length);
      return new vscode.Range(startPos, endPos);
    }
    return null;
  }

  /**
   * 刷新 CodeLens
   */
  public refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }
}

