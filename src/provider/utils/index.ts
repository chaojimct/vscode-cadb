export function generateNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/** 模糊匹配：pattern 的字符按顺序出现在 text 中即视为匹配（忽略大小写） */
export function fuzzyMatch(pattern: string, text: string): boolean {
  if (!pattern.trim()) return true;
  const p = pattern.toLowerCase().trim();
  const t = text.toLowerCase();
  let i = 0;
  for (let j = 0; j < t.length && i < p.length; j++) {
    if (t[j] === p[i]) i++;
  }
  return i === p.length;
}

/**
 * 关闭 mysql2 等 TCP 连接。缓存淘汰或替换时必须调用，否则服务端会堆积 Command/Sleep 线程。
 */
export function safeEndMysqlCompatibleConnection(connection: unknown): void {
  if (connection == null) {
    return;
  }
  const c = connection as {
    end?: (cb?: (err?: Error) => void) => void;
    destroy?: () => void;
  };
  try {
    if (typeof c.end === "function") {
      c.end();
      return;
    }
    if (typeof c.destroy === "function") {
      c.destroy();
    }
  } catch {
    // 已关闭或状态异常时忽略
  }
}
