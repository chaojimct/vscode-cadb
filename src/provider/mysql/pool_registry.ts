import { createPool, type Pool, type PoolConnection } from "mysql2";
import * as vscode from "vscode";
import type { DatasourceInputData } from "../entity/datasource";

function buildPoolKey(input: DatasourceInputData): string {
  return [
    String(input.host ?? ""),
    String(input.port ?? 3306),
    String(input.username ?? ""),
    String(input.password ?? ""),
  ].join("\0");
}

function buildTypeCast() {
  return (field: any, next: () => any) => {
    if (field.type === "BIT" || field.type === 16) {
      const buf = field.buffer();
      if (buf && Buffer.isBuffer(buf)) {
        if (buf.length === 1) return buf[0];
        let n = 0;
        for (let i = 0; i < buf.length; i++) n = (n << 8) | buf[i];
        return n;
      }
    }
    return next();
  };
}

/**
 * 按「主机 + 端口 + 账号 + 密码」复用 mysql2 连接池；不将默认 database 纳入 key，
 * 查询侧统一使用库名限定或 information_schema。
 */
export class MysqlPoolRegistry {
  private readonly pools = new Map<string, Pool>();

  getPool(input: DatasourceInputData): Pool {
    const key = buildPoolKey(input);
    let pool = this.pools.get(key);
    if (!pool) {
      const limit = vscode.workspace
        .getConfiguration("cadb")
        .get<number>("mysql.connectionPoolLimit", 10);
      pool = createPool({
        host: input.host,
        port: input.port,
        user: input.username,
        password: input.password,
        waitForConnections: true,
        connectionLimit: Math.max(1, Math.min(100, limit)),
        queueLimit: 0,
        connectTimeout: 2000,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
        typeCast: buildTypeCast(),
      });
      this.pools.set(key, pool);
    }
    return pool;
  }

  dispose(): void {
    for (const p of this.pools.values()) {
      try {
        p.end(() => {});
      } catch {
        // ignore
      }
    }
    this.pools.clear();
  }
}

let _registry: MysqlPoolRegistry | null = null;

export function getMysqlPoolRegistry(): MysqlPoolRegistry {
  if (!_registry) {
    _registry = new MysqlPoolRegistry();
  }
  return _registry;
}

/**
 * 从池中取一条连接，可选切换默认库，执行 fn 后 release。
 * 用于事务、BEGIN/COMMIT、changeUser 后连续查询等必须同一会话的场景。
 */
export function withMysqlSession<T>(
  input: DatasourceInputData,
  databaseName: string | undefined,
  fn: (conn: PoolConnection) => Promise<T>
): Promise<T> {
  const pool = getMysqlPoolRegistry().getPool(input);
  return new Promise<T>((resolve, reject) => {
    pool.getConnection((err, conn) => {
      if (err) {
        reject(err);
        return;
      }
      const release = () => {
        try {
          conn.release();
        } catch {
          // ignore
        }
      };
      const run = () => {
        fn(conn)
          .then((v) => {
            release();
            resolve(v);
          })
          .catch((e) => {
            release();
            reject(e instanceof Error ? e : new Error(String(e)));
          });
      };
      if (databaseName) {
        conn.changeUser({ database: databaseName }, (e2) => {
          if (e2) {
            release();
            reject(e2);
            return;
          }
          run();
        });
      } else {
        run();
      }
    });
  });
}
