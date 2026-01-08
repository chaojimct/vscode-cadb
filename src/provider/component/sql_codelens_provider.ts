import * as vscode from 'vscode';
import type { DatabaseManager } from './database_manager';

/**
 * SQL CodeLens 提供者
 * 在 SQL 语句上方显示 "Run" 和 "Explain" 命令
 */
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

    // 正则表达式匹配 SQL 语句
    // 匹配 SELECT 语句（包括 SELECT ... FROM）
    const selectRegex = /^\s*SELECT\s+/i;
    // 匹配其他 SQL 语句（INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, etc.）
    const otherSqlRegex = /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|REPLACE|MERGE)\s+/i;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // 跳过空行和注释
      if (!trimmedLine || trimmedLine.startsWith('--') || trimmedLine.startsWith('/*')) {
        continue;
      }

      // 检测 SELECT 语句
      if (selectRegex.test(trimmedLine)) {
        // 找到 SELECT 语句的结束位置（可能是多行）
        const sqlRange = this._findSqlStatementRange(document, i, lines);
        
        if (sqlRange) {
          // 为 SELECT 语句添加 "Run" 和 "Explain" 命令
          const runCommand: vscode.CodeLens = new vscode.CodeLens(sqlRange, {
            title: '$(play) Run',
            command: 'cadb.sql.run',
            arguments: [document, sqlRange],
          });

          const explainCommand: vscode.CodeLens = new vscode.CodeLens(sqlRange, {
            title: '$(search) Explain',
            command: 'cadb.sql.explain',
            arguments: [document, sqlRange],
          });

          codeLenses.push(runCommand, explainCommand);
        }
      }
      // 检测其他 SQL 语句
      else if (otherSqlRegex.test(trimmedLine)) {
        // 找到 SQL 语句的结束位置
        const sqlRange = this._findSqlStatementRange(document, i, lines);
        
        if (sqlRange) {
          // 为其他语句只添加 "Run" 命令
          const runCommand: vscode.CodeLens = new vscode.CodeLens(sqlRange, {
            title: '$(play) Run',
            command: 'cadb.sql.run',
            arguments: [document, sqlRange],
          });

          codeLenses.push(runCommand);
        }
      }
    }

    return codeLenses;
  }

  /**
   * 查找 SQL 语句的范围（可能跨多行）
   */
  private _findSqlStatementRange(
    document: vscode.TextDocument,
    startLine: number,
    lines: string[]
  ): vscode.Range | null {
    let endLine = startLine;
    let inString = false;
    let stringChar = '';
    let inComment = false;
    let commentType: 'single' | 'multi' | null = null;

    // 从起始行开始查找，直到找到语句结束（分号或文件结束）
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i];
      
      for (let j = 0; j < line.length; j++) {
        const char = line[j];
        const nextChar = j < line.length - 1 ? line[j + 1] : '';

        // 处理字符串
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

        // 处理注释
        if (!inString) {
          if (!inComment && char === '-' && nextChar === '-') {
            // 单行注释，该行剩余部分都是注释
            break;
          } else if (!inComment && char === '/' && nextChar === '*') {
            inComment = true;
            commentType = 'multi';
            j++; // 跳过下一个字符
            continue;
          } else if (inComment && commentType === 'multi' && char === '*' && nextChar === '/') {
            inComment = false;
            commentType = null;
            j++; // 跳过下一个字符
            continue;
          }
        }

        // 如果不在字符串和注释中，检查分号
        if (!inString && !inComment && char === ';') {
          // 找到分号，语句结束
          const startPos = new vscode.Position(startLine, 0);
          const endPos = new vscode.Position(i, j + 1);
          return new vscode.Range(startPos, endPos);
        }
      }

      // 如果当前行不在字符串或注释中，且下一行不是 SQL 语句的延续（简单的启发式判断）
      if (!inString && !inComment && i > startLine) {
        const nextLine = i < lines.length - 1 ? lines[i + 1] : '';
        const trimmedNextLine = nextLine.trim();
        
        // 如果下一行是新的 SQL 语句（以关键字开头），则当前语句结束
        if (trimmedNextLine && /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|REPLACE|MERGE)\s+/i.test(trimmedNextLine)) {
          const startPos = new vscode.Position(startLine, 0);
          const endPos = new vscode.Position(i, lines[i].length);
          return new vscode.Range(startPos, endPos);
        }
      }

      endLine = i;
    }

    // 如果没有找到分号，返回到文件末尾的范围
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

