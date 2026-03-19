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
