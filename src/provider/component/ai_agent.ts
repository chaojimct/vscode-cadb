import { z } from "zod";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createAgent, tool } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import type { DatasourceInputData } from "../entity/datasource";
import { withMysqlSession } from "../mysql/pool_registry";

/** Agent 执行配置 */
export interface AgentRunConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  connData: DatasourceInputData;
  connName: string;
  databaseName: string;
  tableNames: string[];
  /** true：单次 function calling，仅强制调用 execute_sql 一次，不走多步 ReAct */
  quickSqlMode?: boolean;
}

/** 流式回调 */
export interface AgentStreamCallbacks {
  onToken: (token: string) => void;
  onToolStart: (toolName: string, input: string) => void;
  onToolEnd: (toolName: string, output: string) => void;
  onError: (err: string) => void;
  onEnd: () => void;
}

function querySql(
  connData: DatasourceInputData,
  databaseName: string,
  sql: string,
): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
  return withMysqlSession(connData, databaseName, async (conn) => {
    return new Promise((resolve, reject) => {
      conn.query(sql, (err: unknown, results: unknown) => {
        if (err) return reject(err);
        if (Array.isArray(results)) {
          const rows = results.slice(0, 50) as Record<string, unknown>[];
          return resolve({ rows, rowCount: results.length });
        }
        const r = results as Record<string, unknown>;
        return resolve({
          rows: [],
          rowCount:
            typeof r?.affectedRows === "number" ? r.affectedRows : 0,
        });
      });
    });
  });
}

/** 将值格式化为可读字符串（处理 Date、Buffer 等特殊类型） */
function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Date) {
    const y = v.getFullYear();
    const mo = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    const h = v.getHours(), mi = v.getMinutes(), s = v.getSeconds();
    if (h === 0 && mi === 0 && s === 0) return `${y}-${mo}-${d}`;
    return `${y}-${mo}-${d} ${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  if (Buffer.isBuffer(v)) {
    if (v.length <= 8) return "0x" + v.toString("hex");
    return `<BLOB ${v.length} bytes>`;
  }
  const s = String(v);
  return s.length > 100 ? s.slice(0, 100) + "…" : s;
}

/** 将行数据格式化为 Markdown 表格 */
function toMarkdownTable(
  rows: Record<string, unknown>[],
  totalCount: number,
  maxRows: number,
): string {
  if (rows.length === 0) return "(空结果集)";
  const cols = Object.keys(rows[0]);
  const display = rows.slice(0, maxRows);
  const header = "| " + cols.join(" | ") + " |";
  const sep = "| " + cols.map(() => "---").join(" | ") + " |";
  const body = display
    .map((r) => "| " + cols.map((c) => formatValue(r[c])).join(" | ") + " |")
    .join("\n");
  let result = header + "\n" + sep + "\n" + body;
  if (totalCount > maxRows) {
    result += `\n\n共 ${totalCount} 行，已显示前 ${maxRows} 行。`;
  } else {
    result += `\n\n共 ${totalCount} 行。`;
  }
  return result;
}

function buildTools(connData: DatasourceInputData, databaseName: string) {
  const executeSql = tool(
    async ({ sql }) => {
      try {
        const { rows, rowCount } = await querySql(
          connData,
          databaseName,
          sql,
        );
        if (rows.length > 0) {
          return toMarkdownTable(rows, rowCount, 30);
        }
        return `执行成功，影响 ${rowCount} 行。`;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return `SQL 执行失败: ${msg}`;
      }
    },
    {
      name: "execute_sql",
      description:
        "在当前 MySQL 数据库上执行 SQL 语句并返回 Markdown 表格格式的结果。可以执行 SELECT、INSERT、UPDATE、DELETE、CREATE 等任意 SQL。",
      schema: z.object({
        sql: z.string().describe("要执行的 SQL 语句"),
      }),
    },
  );

  const listTables = tool(
    async () => {
      try {
        const { rows } = await querySql(
          connData,
          databaseName,
          `SELECT TABLE_NAME AS \`表名\`, TABLE_COMMENT AS \`备注\`, TABLE_ROWS AS \`行数(估)\`
           FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = '${databaseName}'
           ORDER BY TABLE_NAME`,
        );
        if (rows.length === 0) return "当前数据库没有表。";
        return toMarkdownTable(rows, rows.length, 200);
      } catch (err: unknown) {
        return `查询失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: "list_tables",
      description:
        "列出当前数据库中的所有表名、备注和大致行数，返回 Markdown 表格。",
      schema: z.object({}),
    },
  );

  const describeTable = tool(
    async ({ table_name }) => {
      try {
        const { rows } = await querySql(
          connData,
          databaseName,
          `SELECT COLUMN_NAME AS \`列名\`, COLUMN_TYPE AS \`类型\`, IS_NULLABLE AS \`可空\`,
                  COLUMN_KEY AS \`键\`, COLUMN_DEFAULT AS \`默认值\`, COLUMN_COMMENT AS \`备注\`
           FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = '${databaseName}' AND TABLE_NAME = '${table_name}'
           ORDER BY ORDINAL_POSITION`,
        );
        if (rows.length === 0) return `表 \`${table_name}\` 不存在或没有字段。`;
        return toMarkdownTable(rows, rows.length, 200);
      } catch (err: unknown) {
        return `查询失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: "describe_table",
      description:
        "查看指定表的字段结构（列名、类型、是否可空、主键、默认值、注释），返回 Markdown 表格。",
      schema: z.object({
        table_name: z.string().describe("表名"),
      }),
    },
  );

  return [executeSql, listTables, describeTable];
}

function buildQuickSqlSystemPrompt(cfg: AgentRunConfig): string {
  let prompt =
    "你是 MySQL 数据库助手，处于「快速查询」模式。\n" +
    "当前连接信息：\n" +
    `- 连接: ${cfg.connName}\n` +
    `- 数据库: ${cfg.databaseName}\n`;

  if (cfg.tableNames.length > 0) {
    prompt += `- 当前库中的表名（不完整时仍可用 information_schema 推断）: ${cfg.tableNames.join(", ")}\n`;
  }

  prompt +=
    "\n**本模式下你必须遵守：**\n" +
    "1. 你将通过接口「function calling」被强制调用唯一工具 execute_sql 恰好一次。\n" +
    "2. 这一次调用里的 `sql` 必须是能直接回答用户问题的**最终可执行语句**（以 SELECT 为主；若用户明确要求写操作且安全，也可用 INSERT/UPDATE/DELETE）。\n" +
    "3. 禁止依赖多步探索：不要假设还能再次 describe 或列表；请根据已知表名、常见业务字段与 information_schema 一次性写对或写保守（不确定时加 LIMIT、避免危险更新）。\n" +
    "4. SELECT 默认带 LIMIT 100（若用户已指定 LIMIT 则尊重用户）。\n" +
    "5. 不要输出自然语言解释，只产生工具调用所需的参数。\n";

  return prompt;
}

function buildSystemPrompt(cfg: AgentRunConfig): string {
  let prompt =
    "你是一个专业的数据库 AI 助手，可以直接在用户的 MySQL 数据库上执行 SQL。\n" +
    "当前连接信息：\n" +
    `- 连接: ${cfg.connName}\n` +
    `- 数据库: ${cfg.databaseName}\n`;

  if (cfg.tableNames.length > 0) {
    prompt += `- 已知表: ${cfg.tableNames.join(", ")}\n`;
  }

  prompt +=
    "\n你可以使用以下工具：\n" +
    "- execute_sql: 执行任意 SQL（返回 Markdown 表格）\n" +
    "- list_tables: 列出所有表\n" +
    "- describe_table: 查看表结构\n" +
    "\n**回复格式规范：**\n" +
    "1. 如果用户要求查询数据，先用 list_tables / describe_table 了解表结构，再写 SQL\n" +
    "2. SELECT 查询默认加 LIMIT 100 避免返回过多数据\n" +
    "3. 对于 INSERT/UPDATE/DELETE 等写操作，先确认用户意图\n" +
    "4. 展示你执行的 SQL 时用 ```sql 代码块\n" +
    "5. 工具返回的 Markdown 表格中通常已带有「共 N 行」等说明。**不要在正文里再逐行复述、讲解表格内容**（不要列举各行列值、不要长篇描述「结果如下几人」），表格本身就是数据结论。\n" +
    "6. 对于回答用户问题的**最后一次 execute_sql**（多为最终 SELECT）：正文用一两句话收尾即可，例如点明执行了哪类查询、空集时说明无数据；**禁止**再用大段文字重复概括表格里已有信息。\n" +
    "7. 中间步骤（describe_table、list_tables、为确认字段而执行的 SQL）：正文最多一两句说明意图或下一步即可，同样避免把整张中间表用文字复述一遍。\n" +
    "8. 若要在回复中展示数据集，直接使用与工具一致的 Markdown 表格，不要凭记忆编造行数据；**表格首行前必须有空行**（「共 N 行。」单独一行，下一行再起表头），不要把句号与 `|` 表头写在同一行，否则无法渲染为表格。\n" +
    "9. 用中文回复\n";

  return prompt;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function historyToLcMessages(
  systemText: string,
  history: ChatMessage[],
): (SystemMessage | HumanMessage | AIMessage)[] {
  const msgs: (SystemMessage | HumanMessage | AIMessage)[] = [
    new SystemMessage(systemText),
  ];
  for (const m of history) {
    if (m.role === "system") continue;
    if (m.role === "user") msgs.push(new HumanMessage(m.content));
    else if (m.role === "assistant") msgs.push(new AIMessage(m.content));
  }
  return msgs;
}

/** 快速查询：OpenAI 兼容 function calling，强制单次 execute_sql */
async function runQuickSqlFunctionCalling(
  cfg: AgentRunConfig,
  history: ChatMessage[],
  callbacks: AgentStreamCallbacks,
): Promise<void> {
  const llm = new ChatOpenAI({
    apiKey: cfg.apiKey,
    configuration: { baseURL: cfg.baseUrl.replace(/\/+$/, "") },
    model: cfg.model,
    streaming: false,
  });

  const allTools = buildTools(cfg.connData, cfg.databaseName);
  const executeSqlTool = allTools[0];
  const runExecuteSql = executeSqlTool as {
    invoke: (input: { sql: string }) => Promise<string>;
  };
  const systemPrompt = buildQuickSqlSystemPrompt(cfg);
  const messages = historyToLcMessages(systemPrompt, history);

  const aiMsg = await llm.invoke(messages, {
    tools: [executeSqlTool],
    tool_choice: "required",
    parallel_tool_calls: false,
  });

  if (!(aiMsg instanceof AIMessage)) {
    callbacks.onError("模型响应异常");
    callbacks.onEnd();
    return;
  }

  const calls = aiMsg.tool_calls;
  if (!calls?.length) {
    callbacks.onError("快速查询模式下模型未返回 SQL 工具调用");
    callbacks.onEnd();
    return;
  }

  const first = calls[0];
  if (first.name !== "execute_sql") {
    callbacks.onError(`快速查询仅支持 execute_sql，收到: ${first.name}`);
    callbacks.onEnd();
    return;
  }
  const args = first.args as { sql?: string };
  const sql = typeof args?.sql === "string" ? args.sql.trim() : "";
  if (!sql) {
    callbacks.onError("模型返回的 SQL 为空");
    callbacks.onEnd();
    return;
  }

  let toolOutput: string;
  try {
    toolOutput = await runExecuteSql.invoke({ sql });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    toolOutput = `SQL 执行失败: ${msg}`;
  }

  const assistantMd =
    "（快速查询：已一次性生成并执行 SQL）\n\n" +
    "```sql\n" +
    sql +
    "\n```\n\n" +
    toolOutput;

  callbacks.onToken(assistantMd);
  callbacks.onEnd();
}

export async function runAgent(
  cfg: AgentRunConfig,
  history: ChatMessage[],
  callbacks: AgentStreamCallbacks,
): Promise<void> {
  try {
    if (cfg.quickSqlMode) {
      await runQuickSqlFunctionCalling(cfg, history, callbacks);
      return;
    }

    const llm = new ChatOpenAI({
      apiKey: cfg.apiKey,
      configuration: { baseURL: cfg.baseUrl.replace(/\/+$/, "") },
      model: cfg.model,
      streaming: true,
    });

    const tools = buildTools(cfg.connData, cfg.databaseName);

    const agent = createAgent({
      model: llm,
      tools,
    });

    const systemPrompt = buildSystemPrompt(cfg);

    const messages: { role: string; content: string }[] = [
      { role: "system", content: systemPrompt },
      ...history.filter((m) => m.role !== "system"),
    ];

    const stream = await agent.stream(
      { messages },
      { streamMode: ["updates", "messages"] },
    );

    for await (const chunk of stream) {
      const [mode, data] = chunk as [string, unknown];

      if (mode === "messages") {
        const [msg] = data as [{ content?: string | unknown[] }];
        if (msg && typeof msg.content === "string" && msg.content) {
          callbacks.onToken(msg.content);
        } else if (Array.isArray(msg?.content)) {
          for (const block of msg.content) {
            if (
              block &&
              typeof block === "object" &&
              "type" in block &&
              (block as Record<string, unknown>).type === "text"
            ) {
              const text = (block as { text?: string }).text;
              if (text) callbacks.onToken(text);
            }
          }
        }
      }

      if (mode === "updates") {
        const upd = data as Record<
          string,
          { messages?: unknown[] } | undefined
        >;
        const toolsNode = upd?.tools;
        if (toolsNode?.messages) {
          for (const tmsg of toolsNode.messages) {
            const tm = tmsg as {
              name?: string;
              content?: string;
            };
            if (tm.name && tm.content !== undefined) {
              callbacks.onToolEnd(
                tm.name,
                typeof tm.content === "string"
                  ? tm.content.slice(0, 2000)
                  : JSON.stringify(tm.content).slice(0, 2000),
              );
            }
          }
        }

        const modelNode = upd?.model;
        if (modelNode?.messages) {
          for (const mmsg of modelNode.messages) {
            const am = mmsg as {
              tool_calls?: { name: string; args: unknown }[];
            };
            if (am.tool_calls) {
              for (const tc of am.tool_calls) {
                callbacks.onToolStart(
                  tc.name,
                  typeof tc.args === "string"
                    ? tc.args
                    : JSON.stringify(tc.args),
                );
              }
            }
          }
        }
      }
    }

    callbacks.onEnd();
  } catch (err: unknown) {
    callbacks.onError(
      err instanceof Error ? err.message : String(err),
    );
  }
}
