import * as vscode from "vscode";
import * as fs from "fs/promises";
import { Connection, createConnection } from "mysql2";
import {
  ColDef,
  Dataloader,
  FormResult,
  PromiseResult,
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
	listCollations(): Promise<Datasource[]> {
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
  descDatabase(ds: Datasource): Promise<FormResult | undefined> {
    return new Promise<FormResult | undefined>((resolve) => {
      this.conn.query(``, (err, results) => {
        if (err) {
          vscode.window.showErrorMessage(err.message);
          return resolve(undefined);
        }
      });
    });
  }
  descTable(ds: Datasource): Promise<FormResult | undefined> {
    if (!ds.dataloader || !ds.parent || !ds.parent.parent) {
      return Promise.resolve(undefined);
    }
    const table = ds.label || "";
    const database = ds.parent.parent.label || "";
    return new Promise<FormResult | undefined>((resolve) => {
      // 使用 SHOW FULL COLUMNS 而不是 DESC，可以获取字段注释
      this.conn.query(`SHOW FULL COLUMNS FROM ${database}.${table}`, (err, results) => {
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
	COLUMN_COMMENT AS cc
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

  async listData(
    ds: Datasource,
    page?: number,
    pageSize?: number
  ): Promise<TableResult> {
    page = page ? page : 1;
    pageSize = pageSize ? pageSize : 50;
    
    // 记录查询开始时间
    const startTime = Date.now();
    
    const descTable = await new Promise<ColDef[]>((resolve) => {
      const table = ds.label;
      const database = ds.parent?.parent?.label;
      if (!table || !database) {
        return resolve([]);
      }
      this.conn.query(`DESC ${database}.${table}`, (err, results) => {
        if (err) {
          vscode.window.showErrorMessage(err.message);
          return resolve([]);
        }
        resolve(
          (results as any[]).map((e) => {
            return {
              field: e["Field"],
              type: e["Type"],
              canNull: e["Null"],
              key: e["Key"],
              defaultValue: e["Default"],
            } as ColDef;
          })
        );
      });
    });
    const dataTable = await new Promise<Record<string, any>[]>((resolve) => {
      const table = ds.label;
      const database = ds.parent?.parent?.label;
      if (!table || !database) {
        return resolve([]);
      }
      this.conn.query(
        `
		SELECT * FROM ${database}.${table} LIMIT ${(page - 1) * pageSize}, ${pageSize}
		`,
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
    
    // 计算查询时间（秒）
    const queryTime = (Date.now() - startTime) / 1000;
    
    return Promise.resolve({
      title: ds.label,
      columnDefs: descTable,
      rowData: dataTable,
      queryTime: queryTime,
    } as TableResult);
  }
}
