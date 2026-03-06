import * as vscode from "vscode";
import * as fs from "fs/promises";
import { Connection, createConnection } from "mysql2";
import {
  ColDef,
  Dataloader,
  FormResult,
  PromiseResult,
  SaveDataParams,
  SaveResult,
  TableResult,
} from "./dataloader";
import { Datasource, DatasourceInputData } from "./datasource";
import { readdirSync } from "fs";
import path from "path";

export class MySQLDataloader implements Dataloader {
  private conn: Connection;
  private ds: Datasource;
  private connectionConfig: any;

  constructor(ds: Datasource, input: DatasourceInputData) {
    this.ds = ds;
    this.connectionConfig = {
      host: input.host,
      port: input.port,
      user: input.username,
      password: input.password,
      database: input.database,
      connectTimeout: 2000, // 连接超时缩短到 2 秒
      enableKeepAlive: true, // 启用 TCP keep-alive
      keepAliveInitialDelay: 10000, // keep-alive 初始延迟 10 秒
    };
    this.conn = createConnection(this.connectionConfig);
  }
	rootNode(): Datasource {
		return this.ds;
	}
	dbType(): string {
		return this.ds.data.dbType || "mysql";
	}
	listCollations(_: Datasource): Promise<Datasource[]> {
		return new Promise((resolve) => {
			this.ensureConnection().then(() => {
				this.conn.query("SHOW COLLATION", (err, results: any[]) => {
					if (err) {
						resolve([]);
						return;
					}
					const collations = results.map((row) => new Datasource({
						name: row.Collation,
						type: 'item',
						tooltip: row.Charset,
						extra: row.Id
					}, this.ds.dataloader, this.ds));
					resolve(collations);
				});
			}).catch(() => resolve([]));
		});
	}

  async createDatabase(params: any): Promise<void> {
    return new Promise((resolve, reject) => {
      const { name, collation } = params;
      if (!name) {
        reject(new Error("Database name is required"));
        return;
      }
      let sql = `CREATE DATABASE \`${name}\``;
      if (collation) {
        sql += ` COLLATE ${collation}`;
      }
      this.ensureConnection().then(() => {
        this.conn.query(sql, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      }).catch(reject);
    });
  }

	listFolders(ds: Datasource): Promise<Datasource[]> {
		return Promise.resolve([]);
	}

  /**
   * 确保连接可用，如果断开则重新连接
   */
  private async ensureConnection(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // 设置 ping 超时
      const pingTimeout = setTimeout(() => {
        this.reconnect().then(resolve).catch(reject);
      }, 1000); // 1 秒超时
      
      // 使用 ping 检查连接是否活跃
      this.conn.ping((err) => {
        clearTimeout(pingTimeout);
        
        if (err) {
          this.reconnect().then(resolve).catch(reject);
        } else {
          // 连接正常
          resolve();
        }
      });
    });
  }
  
  /**
   * 重新连接到数据库
   */
  private async reconnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // 销毁旧连接
      try {
        this.conn.destroy();
      } catch (e) {
        // 忽略销毁错误
      }
      
      // 创建新连接
      this.conn = createConnection(this.connectionConfig);
      
      // 设置连接超时
      const connectTimeout = setTimeout(() => {
        this.conn.destroy();
        reject(new Error('连接超时'));
      }, 2000); // 2 秒超时
      
      this.conn.connect((connectErr) => {
        clearTimeout(connectTimeout);
        
        if (connectErr) {
          console.error('重新连接失败:', connectErr.message);
          reject(connectErr);
        } else {
          resolve();
        }
      });
    });
  }
  descStructure(): string[] {
    return ["Field", "Type", "Null", "Key", "Default", "Extra"];
  }
  descDatasource(ds: Datasource): Promise<FormResult | undefined> {
    return Promise.resolve({
      rowData: [ds.data],
    });
  }
  descUser(ds: Datasource): Promise<FormResult | undefined> {
    return new Promise<FormResult | undefined>((resolve) => {
			const label = ds.label ? ds.label.toString() : "";
			const [user, host] = label.split("@");
      this.conn.query(`SELECT * FROM mysql.user WHERE HOST = '${host}' AND USER = '${user}'`, (err, results) => {
        if (err) {
          vscode.window.showErrorMessage(err.message);
          return resolve(undefined);
        }
        return resolve({
          rowData: results as Record<string, any>[],
        });
      });
    });
  }
  async descDatabase(ds: Datasource): Promise<FormResult | undefined> {
    const databaseName = ds.label?.toString() || ds.data?.name;
    if (!databaseName) {
      return undefined;
    }

    try {
      await this.ensureConnection();
    } catch (error) {
      vscode.window.showErrorMessage(
        `连接数据库失败：${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }

    return new Promise<FormResult | undefined>((resolve) => {
      this.conn.query(
        "SELECT DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
        [databaseName],
        (err, results: any[]) => {
          if (err) {
            vscode.window.showErrorMessage(err.message);
            return resolve(undefined);
          }
          const collation = results?.[0]?.collation ?? "";
          return resolve({
            rowData: [{ name: databaseName, collation }],
          });
        }
      );
    });
  }
  descTable(ds: Datasource): Promise<FormResult | undefined> {
    if (!ds.dataloader || !ds.parent || !ds.parent.parent) {
      return Promise.resolve(undefined);
    }
    const table = (ds.label?.toString() ?? "").trim();
    const database = (ds.parent.parent.label?.toString() ?? "").trim();
    return new Promise<FormResult | undefined>((resolve) => {
      // 使用 SHOW FULL COLUMNS 而不是 DESC，可以获取字段注释
      this.conn.query(
        `SHOW FULL COLUMNS FROM \`${database}\`.\`${table}\``,
        async (err, results) => {
          if (err) {
            vscode.window.showErrorMessage(err.message);
            return resolve(undefined);
          }
          const rowData = results as Record<string, any>[];
          let indexes: Array<{ id: string; name: string; type: string; fields: string[]; unique: boolean }> = [];
          try {
            indexes = await this.getTableIndexesForEdit(database, table);
          } catch {
            // 降级：从 rowData 的 Key 列推导索引（可能不准确）
          }
          return resolve({
            rowData,
            indexes: indexes.length > 0 ? indexes : undefined,
          } as FormResult & { indexes?: typeof indexes });
        }
      );
    });
  }

  /**
   * 获取表索引列表（供编辑面板使用，使用真实索引名）
   */
  private getTableIndexesForEdit(
    databaseName: string,
    tableName: string
  ): Promise<
    Array<{ id: string; name: string; type: string; fields: string[]; unique: boolean }>
  > {
    return new Promise((resolve, reject) => {
      this.conn.query(
        `
SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE, INDEX_TYPE
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
ORDER BY INDEX_NAME, SEQ_IN_INDEX
`,
        [databaseName, tableName],
        (err, results) => {
          if (err) return reject(err);
          const rows = results as any[];
          const byName = new Map<
            string,
            { type: string; unique: boolean; fields: string[] }
          >();
          for (const r of rows) {
            const name = r.INDEX_NAME;
            if (!byName.has(name)) {
              const isUnique = r.NON_UNIQUE === 0;
              const t =
                name === "PRIMARY"
                  ? "primary"
                  : r.INDEX_TYPE === "FULLTEXT"
                    ? "fulltext"
                    : isUnique
                      ? "unique"
                      : "index";
              byName.set(name, {
                type: t,
                unique: isUnique,
                fields: [],
              });
            }
            byName.get(name)!.fields.push(r.COLUMN_NAME);
          }
          const list = Array.from(byName.entries()).map(([name, v]) => ({
            id: `index-${name}`,
            name,
            type: v.type,
            fields: v.fields,
            unique: v.unique,
          }));
          resolve(list);
        }
      );
    });
  }
  descColumn(ds: Datasource): Promise<FormResult | undefined> {
    return new Promise<FormResult | undefined>((resolve) => {
      this.conn.query(``, (err, results) => {
        if (err) {
          vscode.window.showErrorMessage(err.message);
          return resolve(undefined);
        }
      });
    });
  }
  descIndex(ds: Datasource): Promise<FormResult | undefined> {
    return new Promise<FormResult | undefined>((resolve) => {
      this.conn.query(``, (err, results) => {
        if (err) {
          vscode.window.showErrorMessage(err.message);
          return resolve(undefined);
        }
      });
    });
  }

  getConnection(): Connection {
    return this.conn;
  }

  test(): Promise<PromiseResult> {
    return new Promise<PromiseResult>((resolve) => {
      // 设置测试超时时间为 3 秒
      const timeout = setTimeout(() => {
        this.conn?.destroy();
        resolve({
          success: false,
          message: '连接超时（3秒）',
        });
      }, 3000);
      
      this.conn?.connect((err) => {
        clearTimeout(timeout);
        if (err) {
          resolve({
            success: false,
            message: err.message,
          });
        } else {
          resolve({
            success: true,
          });
        }
      });
    });
  }

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // 设置总超时时间为 3 秒
      const timeout = setTimeout(() => {
        reject(new Error('连接超时（3秒）'));
      }, 3000);
      
      if (this.conn.authorized) {
        this.conn.ping((err) => {
          clearTimeout(timeout);
          if (err) {
            vscode.window.showErrorMessage(err.message);
            reject(err);
          } else {
            resolve();
          }
        });
      } else {
        this.conn.connect((err) => {
          if (err) {
            clearTimeout(timeout);
            vscode.window.showErrorMessage(`连接失败：${err.message}`);
            reject(err);
            return;
          }
          this.conn.ping((err) => {
            clearTimeout(timeout);
            if (err) {
              vscode.window.showErrorMessage(err.message);
              reject(err);
            } else {
              resolve();
            }
          });
        });
      }
    });
  }
  async listAllUsers(ds: Datasource): Promise<Datasource[]> {
    try {
      await this.ensureConnection();
      
      return new Promise<Datasource[]>((resolve) => {
        this.conn.query(`SELECT * FROM mysql.user;`, (err, results) => {
          if (err) {
            vscode.window.showErrorMessage(`查询数据库失败：${err.message}`);
            return resolve([]);
          }
          ds.children = (results as any[]).map(
            (row) =>
              new Datasource(
                {
                  name: `${row["User"]}@${row["Host"]}`,
                  tooltip: "",
                  extra: "",
                  type: "user",
                },
                this,
                this.ds
              )
          );
          return resolve(ds.children);
        });
      });
    } catch (error) {
      vscode.window.showErrorMessage(`连接数据库失败：${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }
  async listUsers(ds: Datasource): Promise<Datasource[]> {
    if (ds.parent && ds.parent.type === "datasource") {
      return this.listAllUsers(ds);
    }
    
    if (!this.ds.parent) {
      return [];
    }
    
    try {
      await this.ensureConnection();
      
      return new Promise<Datasource[]>((resolve) => {
        this.conn.query(
          `
SELECT DISTINCT USER as name, HOST as host
FROM mysql.DB
WHERE db = '${this.ds.parent?.label}';
`,
          (err, results) => {
            if (err) {
              vscode.window.showErrorMessage(`查询数据库失败：${err.message}`);
              return resolve([]);
            }
            ds.children = (results as any[]).map(
              (row) =>
                new Datasource(
                  {
                    name: `${row["name"]}@${row["host"]}`,
                    tooltip: "",
                    extra: "",
                    type: "user",
                  },
                  this,
                  this.ds
                )
            );
            return resolve(ds.children);
          }
        );
      });
    } catch (error) {
      vscode.window.showErrorMessage(`连接数据库失败：${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }
  async listFiles(ds: Datasource, dsPath: vscode.Uri): Promise<Datasource[]> {
    try {
      const stats = await fs.stat(dsPath.fsPath);
      if (stats.isDirectory()) {
        readdirSync(dsPath.fsPath).forEach((file) => {
          ds.children.push(
            new Datasource(
              {
                name: file,
                tooltip: path.join(dsPath.fsPath, file),
                extra: "",
                type: "file",
              },
              this,
              ds.parent
            )
          );
        });
      }
    } catch (error) {
      await fs.mkdir(dsPath.fsPath, { recursive: true });
    }
    return ds.children;
  }

  listObjects(ds: Datasource, type: string): Promise<Datasource[]> {
    return new Promise<Datasource[]>((resolve) => {
      if (type === "document") {
        ds.children = [
          new Datasource(
            {
              type: "fieldType",
              name: "字段",
              tooltip: "",
            },
            this,
            ds
          ),
          new Datasource(
            {
              type: "indexType",
              name: "索引",
              tooltip: "",
            },
            this,
            ds
          ),
        ];
      } else if (type === "collection") {
        ds.children = [
          new Datasource(
            {
              type: "collectionType",
              name: "表",
              tooltip: "",
            },
            this,
            ds
          ),
          new Datasource(
            {
              type: "userType",
              name: "用户",
              tooltip: "",
            },
            this,
            ds
          ),
        ];
      } else if (type === "datasource") {
        ds.children = [
          new Datasource(
            {
              type: "datasourceType",
              name: "数据库",
              tooltip: "",
            },
            this,
            ds
          ),
          new Datasource(
            {
              type: "userType",
              name: "用户",
              tooltip: "",
            },
            this,
            ds
          ),
          new Datasource(
            {
              type: "fileType",
              name: "查询",
              tooltip: "",
            },
            this,
            ds
          ),
        ];
      }
      resolve(ds.children);
    });
  }

  async listIndexes(ds: Datasource): Promise<Datasource[]> {
    if (!ds.parent || !ds.parent.parent || !ds.parent.parent.parent) {
      return [];
    }
    
    try {
      await this.ensureConnection();
      
      return new Promise<Datasource[]>((resolve) => {
        this.conn.query(
          `
SELECT 
	INDEX_NAME AS iname,
	COLUMN_NAME AS cname,
	SEQ_IN_INDEX AS sii,
	NON_UNIQUE AS nu,
	INDEX_TYPE AS it
FROM 
    information_schema.STATISTICS 
WHERE 
    TABLE_SCHEMA = '${ds.parent?.parent?.parent?.label}'
    AND TABLE_NAME = '${ds.parent?.label}'
ORDER BY 
    NON_UNIQUE, INDEX_NAME, SEQ_IN_INDEX;
`,
          (err, results) => {
            if (err) {
              vscode.window.showErrorMessage(`查询索引失败：${err.message}`);
              return resolve([]);
            }
            const indexes = new Map<string, string[]>();
            const rows = results as any[];
            for (const row of rows) {
              if (!indexes.has(row["iname"] as string)) {
                indexes.set(row["iname"] as string, [
                  `${row["it"]}`,
                  `${row["nu"]}`,
                ]);
              }
              indexes.get(row["iname"] as string)?.push(`${row["cname"]}`);
            }
            const result: Datasource[] = [];
            for (const [k, v] of indexes) {
              const indexNames = v.slice(2).join(", ");
              const tooltip = `${v[0]}(${indexNames})`;
              result.push(
                new Datasource(
                  {
                    name: k,
                    tooltip: tooltip,
                    extra: parseInt(v[1]) === 0 ? `UNIQUE` : ``,
                    type: "index",
                  },
                  this,
                  ds
                )
              );
            }
            ds.children = result;
            return resolve(ds.children);
          }
        );
      });
    } catch (error) {
      vscode.window.showErrorMessage(`连接数据库失败：${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  async listColumns(ds: Datasource): Promise<Datasource[]> {
    if (!ds.parent || !ds.parent.parent || !ds.parent.parent.parent) {
      return [];
    }
    
    try {
      await this.ensureConnection();
      
      return new Promise<Datasource[]>((resolve) => {
        this.conn.query(
          `
SELECT 
	COLUMN_NAME AS name,
	COLUMN_TYPE AS ctype,
	COLUMN_COMMENT AS cc,
	IS_NULLABLE AS is_nullable
FROM 
    information_schema.COLUMNS 
WHERE 
    TABLE_SCHEMA = '${ds.parent?.parent?.parent?.label}'
    AND TABLE_NAME = '${ds.parent?.label}'
ORDER BY 
    ORDINAL_POSITION;
`,
          (err, results) => {
            if (err) {
              vscode.window.showErrorMessage(`查询数据库失败：${err.message}`);
              return resolve([]);
            }
            ds.children = (results as any[]).map(
              (row) =>
                new Datasource(
                  {
                    name: row["name"] as string,
                    tooltip: row["cc"] as string,
                    extra: row["ctype"] as string,
                    type: "field",
                    nullable: (row["is_nullable"] as string) === "YES",
                  },
                  this,
                  ds
              )
            );
            return resolve(ds.children);
          }
        );
      });
    } catch (error) {
      vscode.window.showErrorMessage(`连接数据库失败：${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  async listTables(ds: Datasource): Promise<Datasource[]> {
    if (!ds.parent) {
      return [];
    }
    
    try {
      await this.ensureConnection();
      
      return new Promise<Datasource[]>((resolve) => {
        this.conn.query(
          `
SELECT TABLE_NAME as name, TABLE_COMMENT as tc
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = '${ds.parent?.label}';
`,
          (err, results) => {
            if (err) {
              vscode.window.showErrorMessage(`查询数据库失败：${err.message}`);
              return resolve([]);
            }
            ds.children = (results as any[]).map(
              (row) =>
                new Datasource(
                  {
                    name: row["name"] as string,
                    tooltip: row["tc"] as string,
                    extra: "",
                    type: "document",
                  },
                  this,
                  ds
                )
            );
            return resolve(ds.children);
          }
        );
      });
    } catch (error) {
      vscode.window.showErrorMessage(`连接数据库失败：${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  async listDatabases(ds: Datasource): Promise<Datasource[]> {
    try {
      // 确保连接可用
      await this.ensureConnection();
      
      return new Promise<Datasource[]>((resolve) => {
        this.conn.query(
          `
SELECT 
	s.SCHEMA_NAME AS name,
	COUNT(t.TABLE_NAME) AS table_count
FROM 
	information_schema.SCHEMATA s
LEFT JOIN 
	information_schema.TABLES t ON s.SCHEMA_NAME = t.TABLE_SCHEMA
WHERE 
	s.SCHEMA_NAME NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys')
GROUP BY 
	s.SCHEMA_NAME
ORDER BY 
	s.SCHEMA_NAME;
				`,
          (err, results) => {
            if (err) {
              vscode.window.showErrorMessage(`获取数据库失败：${err.message}`);
              return resolve([]);
            }
            ds.children = (results as any[]).map(
              (row) => {
                const tableCount = row["table_count"] as number || 0;
                const descriptionText = `${tableCount} 个表`;
                return new Datasource(
                  {
                    name: row["name"] as string,
                    tooltip: "",
                    extra: descriptionText,
                    type: "collection",
                  },
                  this,
                  this.ds
                );
              }
            );
            return resolve(ds.children);
          }
        );
      });
    } catch (error) {
      vscode.window.showErrorMessage(`连接数据库失败：${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  async listData(ds: Datasource): Promise<TableResult> {
    const startTime = Date.now();

    const descTable = await new Promise<ColDef[]>((resolve) => {
      const table = ds.label;
      const database = ds.parent?.parent?.label;
      if (!table || !database) {
        return resolve([]);
      }
      this.conn.query(`SHOW FULL COLUMNS FROM \`${database}\`.\`${table}\``, (err, results) => {
        if (err) {
          vscode.window.showErrorMessage(err.message);
          return resolve([]);
        }
        resolve(
          (results as any[]).map((e) => {
            const extra = String(e["Extra"] ?? "").toLowerCase();
            return {
              field: e["Field"],
              type: e["Type"],
              canNull: e["Null"],
              key: e["Key"],
              defaultValue: e["Default"],
              comment: e["Comment"] ?? null,
              autoIncrement: extra.includes("auto_increment"),
            } as ColDef;
          })
        );
      });
    });

    const tableName = ds.label;
    const databaseName = ds.parent?.parent?.label;
    const baseTable = tableName && databaseName ? `\`${databaseName}\`.\`${tableName}\`` : null;

    const dataTable = await new Promise<Record<string, any>[]>((resolve) => {
      if (!baseTable) return resolve([]);
      this.conn.query(
        `SELECT * FROM ${baseTable} LIMIT 2000`,
        (err, results) => {
          if (err) {
            vscode.window.showErrorMessage(err.message);
            return resolve([]);
          }
          return resolve(
            (results as any[]).map((e) => e as Record<string, any>)
          );
        }
      );
    });

    const queryTime = (Date.now() - startTime) / 1000;

    return Promise.resolve({
      title: ds.label,
      columnDefs: descTable,
      rowData: dataTable,
      queryTime,
    } as TableResult);
  }

  /**
   * 保存表格数据（根据主键更新）
   */
  async saveData(params: SaveDataParams): Promise<SaveResult> {
    const { tableName, databaseName, primaryKeyField, rows, deletedRows } = params;

    await this.ensureConnection();
    await new Promise<void>((resolve, reject) => {
      this.conn.changeUser({ database: databaseName }, (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });

    let successCount = 0;
    let errorCount = 0;
    const errors: string[] = [];
    const executedSql: string[] = [];

    const escapeVal = (v: any): string => {
      if (v === null || v === undefined) return "NULL";
      if (v === true || String(v).toLowerCase() === "true") return "1";
      if (v === false || String(v).toLowerCase() === "false") return "0";
      const s = String(v).replace(/'/g, "''");
      return `'${s}'`;
    };

    // 先执行标记删除的行的 DELETE
    if (deletedRows?.length) {
      for (const { id } of deletedRows) {
        try {
          const deleteSql = `DELETE FROM \`${databaseName}\`.\`${tableName}\` WHERE \`${primaryKeyField}\` = ${escapeVal(id)}`;
          executedSql.push(deleteSql);
          await new Promise<void>((resolve, reject) => {
            this.conn.query(deleteSql, (err: any) => {
              if (err) reject(err);
              else resolve();
            });
          });
          successCount++;
        } catch (error) {
          errorCount++;
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    for (const row of rows) {
      try {
        const isNew = !!row.isNew;
        const full = row.full || row.original || {};
        const updated = row.updated || {};

        if (isNew) {
          // 新行：INSERT（主键为空时省略该列以支持自增）
          const allKeys = Object.keys(full).filter((k) => !String(k).startsWith("__"));
          const insertKeys = allKeys.filter(
            (k) =>
              k !== primaryKeyField ||
              (full[k] != null && String(full[k]).trim() !== "")
          );
          if (insertKeys.length === 0) {
            errors.push("新行无有效字段");
            errorCount++;
            continue;
          }
          const cols = insertKeys.map((k) => `\`${k}\``).join(", ");
          const insertVal = (v: any): string => {
            const s = String(v ?? "").trim().toUpperCase();
            if (s === "CURRENT_TIMESTAMP" || s === "CURRENT_DATE") return s;
            return escapeVal(v);
          };
          const vals = insertKeys.map((k) => insertVal(full[k])).join(", ");
          const insertSql = `INSERT INTO \`${databaseName}\`.\`${tableName}\` (${cols}) VALUES (${vals})`;
          executedSql.push(insertSql);
          await new Promise<void>((resolve, reject) => {
            this.conn.query(insertSql, (err: any) => {
              if (err) reject(err);
              else resolve();
            });
          });
          successCount++;
          continue;
        }

        const id = row.id;
        if (id === undefined || id === null || id === "") {
          errors.push("行缺少主键值");
          errorCount++;
          continue;
        }

        if (!updated || Object.keys(updated).length === 0) {
          continue;
        }

        const setClause = Object.keys(updated)
          .map((key) => {
            const value = updated[key];
            if (value === null || value === undefined) {
              return `\`${key}\` = NULL`;
            }
            if (value === true || value === "true" || value === 1) {
              return `\`${key}\` = 1`;
            }
            if (value === false || value === "false" || value === 0) {
              return `\`${key}\` = 0`;
            }
            return `\`${key}\` = '${String(value).replace(/'/g, "''")}'`;
          })
          .join(", ");

        const updateSql = `UPDATE \`${databaseName}\`.\`${tableName}\` SET ${setClause} WHERE \`${primaryKeyField}\` = ${escapeVal(id)}`;
        executedSql.push(updateSql);

        await new Promise<void>((resolve, reject) => {
          this.conn.query(updateSql, (err: any) => {
            if (err) reject(err);
            else resolve();
          });
        });

        successCount++;
      } catch (error) {
        errorCount++;
        errors.push(
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    return {
      successCount,
      errorCount,
      errors,
      executedSql,
    };
  }

  /**
   * 修改表结构（添加/修改/删除字段）
   * @returns 实际执行的 SQL 语句
   */
  async alterColumn(params: {
    databaseName: string;
    tableName: string;
    operation: "add" | "modify" | "drop";
    originalName?: string;
    field?: {
      name: string;
      type: string;
      length?: number | null;
      defaultValue?: string | null;
      nullable?: boolean;
      autoIncrement?: boolean;
      primaryKey?: boolean;
      comment?: string;
    };
  }): Promise<string> {
    const { databaseName, tableName, operation, originalName, field } = params;
    const table = `\`${databaseName}\`.\`${tableName}\``;

    await this.ensureConnection();

    if (operation === "drop" && originalName) {
      const sql = `ALTER TABLE ${table} DROP COLUMN \`${this.escapeId(originalName)}\``;
      return new Promise((resolve, reject) => {
        this.conn.query(sql, (err) => {
          if (err) reject(err);
          else resolve(sql);
        });
      });
    }

    if (operation === "add" || operation === "modify") {
      if (!field) throw new Error("field 参数必填");
      const colDef = this.buildColumnDefinition(field);
      let sql: string;
      if (operation === "add") {
        sql = `ALTER TABLE ${table} ADD COLUMN \`${this.escapeId(field.name)}\` ${colDef}`;
      } else {
        const oldName = originalName || field.name;
        if (oldName === field.name) {
          sql = `ALTER TABLE ${table} MODIFY COLUMN \`${this.escapeId(field.name)}\` ${colDef}`;
        } else {
          sql = `ALTER TABLE ${table} CHANGE COLUMN \`${this.escapeId(oldName)}\` \`${this.escapeId(field.name)}\` ${colDef}`;
        }
      }
      return new Promise((resolve, reject) => {
        this.conn.query(sql, (err) => {
          if (err) reject(err);
          else resolve(sql);
        });
      });
    }

    throw new Error(`不支持的 operation: ${operation}`);
  }

  private escapeId(id: string): string {
    return id.replace(/`/g, "``");
  }

  private buildColumnDefinition(field: {
    type: string;
    length?: number | null;
    defaultValue?: string | null;
    nullable?: boolean;
    autoIncrement?: boolean;
    comment?: string;
  }): string {
    const parts: string[] = [];
    const typeMap: Record<string, string> = {
      varchar: "VARCHAR",
      int: "INT",
      bigint: "BIGINT",
      text: "TEXT",
      datetime: "DATETIME",
      date: "DATE",
      decimal: "DECIMAL",
      float: "FLOAT",
      double: "DOUBLE",
      json: "JSON",
      blob: "BLOB",
    };
    const baseType = typeMap[field.type.toLowerCase()] || field.type.toUpperCase();
    if (field.length != null && field.length > 0 && ["VARCHAR", "CHAR", "DECIMAL", "NUMERIC"].includes(baseType)) {
      parts.push(`${baseType}(${field.length})`);
    } else {
      parts.push(baseType);
    }
    const nullable = field.nullable !== false;
    parts.push(nullable ? "NULL" : "NOT NULL");
    if (field.defaultValue !== undefined && field.defaultValue !== null && field.defaultValue !== "") {
      const v = String(field.defaultValue).trim();
      if (v.toLowerCase() === "null") {
        parts.push("DEFAULT NULL");
      } else if (["CURRENT_TIMESTAMP", "CURRENT_DATE"].includes(v.toUpperCase())) {
        parts.push(`DEFAULT ${v.toUpperCase()}`);
      } else {
        parts.push(`DEFAULT ${this.conn.escape(v)}`);
      }
    }
    if (field.autoIncrement === true || String(field.autoIncrement) === "true") {
      parts.push("AUTO_INCREMENT");
    }
    if (field.comment) {
      parts.push(`COMMENT ${this.conn.escape(field.comment)}`);
    }
    return parts.join(" ");
  }

  /**
   * 修改表索引（添加/修改/删除）
   * @returns 实际执行的 SQL 语句（多条用换行分隔）
   */
  async alterIndex(params: {
    databaseName: string;
    tableName: string;
    operation: "add" | "modify" | "drop";
    originalName?: string;
    index?: {
      name: string;
      type: string;
      fields: string[];
      unique?: boolean;
      comment?: string;
    };
  }): Promise<string> {
    const { databaseName, tableName, operation, originalName, index } = params;
    const table = `\`${databaseName}\`.\`${tableName}\``;

    await this.ensureConnection();

    const runSql = (sql: string): Promise<void> =>
      new Promise((resolve, reject) => {
        this.conn.query(sql, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

    if (operation === "drop" && originalName) {
      const sql =
        originalName === "PRIMARY"
          ? `ALTER TABLE ${table} DROP PRIMARY KEY`
          : `ALTER TABLE ${table} DROP INDEX \`${this.escapeId(originalName)}\``;
      await runSql(sql);
      return sql;
    }

    if (operation === "add" || operation === "modify") {
      if (!index || !index.fields || index.fields.length === 0) {
        throw new Error("索引数据不完整，需至少包含字段列表");
      }
      const cols = index.fields.map((c) => `\`${this.escapeId(c)}\``).join(", ");
      let addSql: string;

      if (index.type === "primary") {
        addSql = `ALTER TABLE ${table} ADD PRIMARY KEY (${cols})`;
      } else if (index.type === "fulltext") {
        addSql = `ALTER TABLE ${table} ADD FULLTEXT INDEX \`${this.escapeId(index.name)}\` (${cols})`;
      } else {
        const unique =
          index.type === "unique" ||
          index.unique === true ||
          String(index.unique) === "true";
        const uniqueKw = unique ? "UNIQUE " : "";
        addSql = `ALTER TABLE ${table} ADD ${uniqueKw}INDEX \`${this.escapeId(index.name)}\` (${cols})`;
      }
      if (index.comment && index.type !== "primary") {
        addSql += ` COMMENT ${this.conn.escape(index.comment)}`;
      }

      if (operation === "modify" && originalName) {
        const dropSql =
          originalName === "PRIMARY"
            ? `ALTER TABLE ${table} DROP PRIMARY KEY`
            : `ALTER TABLE ${table} DROP INDEX \`${this.escapeId(originalName)}\``;
        await runSql(dropSql);
        await runSql(addSql);
        return `${dropSql}\n${addSql}`;
      }

      await runSql(addSql);
      return addSql;
    }

    throw new Error(`不支持的 operation: ${operation}`);
  }
}
