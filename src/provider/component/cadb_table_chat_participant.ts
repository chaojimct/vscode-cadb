import * as vscode from "vscode";
import { driverSupportsSqlExecution } from "../drivers/registry";
import { Datasource } from "../entity/datasource";
import type { DatabaseManager } from "./database_manager";

const PARTICIPANT_ID = "codingsoul.vscode-cadb.tables";
const MAX_TABLES = 45;
const MAX_SCHEMA_CHARS = 32000;

function chatDebug(
  channel: vscode.OutputChannel | undefined,
  message: string,
  data?: unknown
): void {
  const ts = new Date().toISOString();
  let line = `[CADB CHAT][${ts}] ${message}`;
  if (data !== undefined) {
    try {
      line += ` ${JSON.stringify(data)}`;
    } catch {
      line += ` ${String(data)}`;
    }
  }
  console.log(line);
  channel?.appendLine(line);
}

/**
 * 从当前 DatabaseManager 状态解析「真实」的数据库树节点（含 dataloader），
 * 避免 setActiveDatabase 构造的临时节点无法 expand。
 */
async function resolveActiveDatabaseDatasource(
  databaseManager: DatabaseManager,
  context: vscode.ExtensionContext,
  logChannel: vscode.OutputChannel | undefined
): Promise<Datasource | undefined> {
  const connection = databaseManager.getCurrentConnection();
  const currentDb = databaseManager.getCurrentDatabase();
  if (!connection || !currentDb) {
    chatDebug(logChannel, "resolveActiveDatabase: 无当前连接或数据库", {
      hasConnection: !!connection,
      hasDatabase: !!currentDb,
    });
    return undefined;
  }
  const targetName = currentDb.label?.toString() || "";
  if (!targetName) {
    chatDebug(logChannel, "resolveActiveDatabase: 数据库名为空");
    return undefined;
  }

  if (currentDb.dataloader) {
    chatDebug(logChannel, "resolveActiveDatabase: 使用当前库节点（含 dataloader）", {
      targetName,
    });
    return currentDb;
  }

  try {
    chatDebug(logChannel, "resolveActiveDatabase: 从连接重新解析库节点", {
      targetName,
      connLabel: connection.label?.toString(),
    });
    const objects = await connection.expand(context);
    const datasourceTypeNode = objects.find((o) => o.type === "datasourceType");
    if (!datasourceTypeNode) {
      chatDebug(logChannel, "resolveActiveDatabase: 未找到 datasourceType 子节点");
      return undefined;
    }
    const databases = await datasourceTypeNode.expand(context);
    const found = databases.find((d) => (d.label?.toString() || "") === targetName);
    if (!found) {
      chatDebug(logChannel, "resolveActiveDatabase: 库名在连接下未匹配", {
        targetName,
        candidates: databases.slice(0, 20).map((d) => d.label?.toString()),
      });
    }
    return found;
  } catch (e) {
    chatDebug(logChannel, "resolveActiveDatabase: expand 异常", {
      err: e instanceof Error ? e.message : String(e),
    });
    return undefined;
  }
}

/**
 * 构建当前库下表与字段的纯文本摘要，供 LLM 或 /schema 使用。
 */
async function buildCurrentDatabaseSchemaText(
  databaseManager: DatabaseManager,
  context: vscode.ExtensionContext,
  token: vscode.CancellationToken,
  logChannel: vscode.OutputChannel | undefined
): Promise<{ text: string; connectionLabel: string; databaseLabel: string } | undefined> {
  const connection = databaseManager.getCurrentConnection();
  const database = await resolveActiveDatabaseDatasource(
    databaseManager,
    context,
    logChannel
  );
  if (!connection || !database) {
    return undefined;
  }
  if (token.isCancellationRequested) {
    return undefined;
  }

  const connData = connection.data;
  if (!driverSupportsSqlExecution(connData.dbType)) {
    return {
      text: `当前连接类型为「${connData.dbType}」，本助手仅对支持 SQL 执行的连接注入表结构。`,
      connectionLabel: connection.label?.toString() || connData.name || "",
      databaseLabel: database.label?.toString() || "",
    };
  }

  const connectionLabel = connection.label?.toString() || connData.name || "";
  const databaseLabel = database.label?.toString() || "";

  const dbObjects = await database.expand(context);
  if (token.isCancellationRequested) {
    return undefined;
  }
  const tableTypeNode = dbObjects.find((o) => o.type === "collectionType");
  if (!tableTypeNode) {
    return {
      text: "未找到「表」节点，无法读取表列表。",
      connectionLabel,
      databaseLabel,
    };
  }

  const tables = (await tableTypeNode.expand(context)) || [];
  if (token.isCancellationRequested) {
    return undefined;
  }

  const lines: string[] = [
    `连接: ${connectionLabel}`,
    `数据库: ${databaseLabel}`,
    `以下列出至多 ${MAX_TABLES} 张表的字段（来自 information_schema）。`,
    "",
  ];

  let n = 0;
  for (const table of tables) {
    if (token.isCancellationRequested) {
      break;
    }
    if (n >= MAX_TABLES) {
      lines.push(`… 另有 ${tables.length - MAX_TABLES} 张表未展开（已达上限）。`);
      break;
    }
    const tableName = table.label?.toString() || "";
    if (!tableName) {
      continue;
    }
    const sub = await table.expand(context);
    if (token.isCancellationRequested) {
      break;
    }
    const fieldType = sub.find((o) => o.type === "fieldType");
    if (!fieldType) {
      lines.push(`### ${tableName}`, "(无字段节点)", "");
      n++;
      continue;
    }
    const columns = await fieldType.expand(context);
    if (token.isCancellationRequested) {
      break;
    }
    const comment =
      typeof table.tooltip === "string" && table.tooltip.trim()
        ? ` — ${table.tooltip.trim()}`
        : "";
    lines.push(`### ${tableName}${comment}`);
    for (const col of columns || []) {
      const cn = col.label?.toString() || "";
      const ctype = (col as Datasource).data?.extra || "";
      const nullable = (col as Datasource).data?.nullable === true ? " NULL" : "";
      const cct =
        typeof col.tooltip === "string" && col.tooltip.trim()
          ? `  // ${String(col.tooltip).trim()}`
          : "";
      lines.push(`- \`${cn}\` ${ctype}${nullable}${cct}`);
    }
    lines.push("");
    n++;
  }

  let text = lines.join("\n");
  if (text.length > MAX_SCHEMA_CHARS) {
    text = text.slice(0, MAX_SCHEMA_CHARS) + "\n\n… 上下文过长已截断。";
  }

  chatDebug(logChannel, "buildSchema: 完成", {
    connectionLabel,
    databaseLabel,
    tableCount: n,
    textLength: text.length,
  });

  return { text, connectionLabel, databaseLabel };
}

function formatSchemaMarkdown(
  connectionLabel: string,
  databaseLabel: string,
  body: string
): string {
  return (
    `**连接** \`${connectionLabel}\` · **数据库** \`${databaseLabel}\`\n\n` +
    "```text\n" +
    body.replace(/```/g, "``\\`") +
    "\n```\n"
  );
}

/**
 * 注册「数据表」Chat Participant：把当前选中库的表结构注入对话，结合用户所选语言模型回答问题。
 * @see https://code.visualstudio.com/api/extension-guides/ai/chat
 */
export function registerCadbTableChatParticipant(
  context: vscode.ExtensionContext,
  databaseManager: DatabaseManager,
  logChannel?: vscode.OutputChannel
): void {
  chatDebug(logChannel, "registerCadbTableChatParticipant: 开始", {
    vscodeVersion: vscode.version,
    hasChatNamespace: typeof vscode.chat !== "undefined",
    hasCreateChatParticipant:
      typeof vscode.chat?.createChatParticipant === "function",
    participantId: PARTICIPANT_ID,
  });

  if (typeof vscode.chat?.createChatParticipant !== "function") {
    chatDebug(
      logChannel,
      "未注册 Chat Participant：当前环境无 vscode.chat.createChatParticipant。请升级 VS Code 至官方文档要求版本，并确认已启用「聊天」相关功能；日志同时输出在「开发人员工具」控制台。"
    );
    return;
  }

  const handler: vscode.ChatRequestHandler = async (request, _ctx, stream, token) => {
    chatDebug(logChannel, "handler: 收到请求", {
      command: request.command ?? null,
      promptLength: request.prompt?.length ?? 0,
      promptPreview: (request.prompt || "").slice(0, 120),
      referenceCount: request.references?.length ?? 0,
      modelId: request.model?.id,
      modelName: request.model?.name,
      modelVendor: request.model?.vendor,
    });

    stream.progress("正在读取当前库的表结构…");
    const built = await buildCurrentDatabaseSchemaText(
      databaseManager,
      context,
      token,
      logChannel
    );
    if (!built) {
      chatDebug(logChannel, "handler: 无法构建 schema（未选库或解析失败），将返回提示文案");
      stream.markdown(
        "未检测到**当前选中的数据库**。请先在状态栏或 SQL 编辑器中通过 CADB 选择**连接**与**数据库**，再使用 `@cadb-tables`。\n\n" +
          "也可使用命令 **CADB: 选择数据库**（`cadb.selectDatabase`）。"
      );
      return;
    }

    const { text: schemaBody, connectionLabel, databaseLabel } = built;

    if (request.command === "schema") {
      chatDebug(logChannel, "handler: /schema，仅输出 Markdown");
      stream.markdown(formatSchemaMarkdown(connectionLabel, databaseLabel, schemaBody));
      return;
    }

    if (!request.prompt.trim()) {
      chatDebug(logChannel, "handler: prompt 为空，跳过模型");
      stream.markdown("请输入问题，或尝试 `/schema` 仅查看表结构摘要。");
      return;
    }

    try {
      chatDebug(logChannel, "handler: 调用 request.model.sendRequest");
      stream.progress("正在请求语言模型…");
      const systemPreamble =
        "你是 CADB（VS Code 数据库扩展）助手。下列「当前库表结构」来自用户已在 IDE 中选择的连接与数据库（由扩展从 information_schema 读取）。\n" +
        "请基于这些表名与字段回答：SQL 编写、查询思路、建模与索引建议等。信息不足时请说明假设或请用户补充。\n" +
        "用户使用中文时优先用中文回答。\n\n" +
        "### 当前库表结构\n\n" +
        schemaBody;

      const messages = [
        vscode.LanguageModelChatMessage.User(systemPreamble),
        vscode.LanguageModelChatMessage.User(request.prompt),
      ];

      const response = await request.model.sendRequest(
        messages,
        {
          justification:
            "CADB @cadb-tables：根据当前选中数据库的表结构，协助回答 SQL 与 schema 相关问题。",
        },
        token
      );

      let streamedChars = 0;
      for await (const fragment of response.text) {
        if (token.isCancellationRequested) {
          chatDebug(logChannel, "handler: 用户取消，停止写入 stream");
          break;
        }
        stream.markdown(fragment);
        streamedChars += typeof fragment === "string" ? fragment.length : 0;
      }
      chatDebug(logChannel, "handler: sendRequest 流结束", {
        streamedChars,
        cancelled: token.isCancellationRequested,
      });
    } catch (e) {
      chatDebug(logChannel, "handler: sendRequest 异常", {
        err: e instanceof Error ? e.message : String(e),
        languageModelError:
          e instanceof vscode.LanguageModelError
            ? { code: e.code, name: e.name }
            : null,
      });
      if (e instanceof vscode.LanguageModelError && e.code === "NoPermissions") {
        stream.markdown(
          "无法使用当前语言模型：可能尚未授权扩展访问 AI，或聊天中未选择可用模型。请在聊天面板选择模型后重试，并允许 CADB 访问语言模型。"
        );
        return;
      }
      stream.markdown(
        `请求语言模型失败：${e instanceof Error ? e.message : String(e)}\n\n` +
          "若未安装或未登录 GitHub Copilot 等提供模型的扩展，将无法使用本参与者生成回答；你仍可使用 `/schema` 查看表结构。"
      );
    }
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "logo.png");
  context.subscriptions.push(participant);
  chatDebug(
    logChannel,
    "已注册 Chat Participant，可在「输出」面板选择「CADB SQL」查看 [CADB CHAT] 日志；@cadb-tables 发起对话时应出现 handler 日志"
  );
}
