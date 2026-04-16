/**
 * 将 AI 聊天 Webview 依赖复制到 resources/panels/ai-chat/vendor；
 * 将 @vscode/codicons 复制到 resources/panels/common/vendor（供 grid / settings / ai-chat 等
 * 经 {{resources-uri}} 引用），避免经 node_modules 的 webview URI 在安装版或新版 VS Code 下 404。
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const vendorRoot = path.join(root, "resources", "panels", "ai-chat", "vendor");
/** 各 Webview 共用的 codicons（勿经 node_modules 的 webview URI，新版 VS Code / 安装包下易 404） */
const commonCodiconsDir = path.join(
  root,
  "resources",
  "panels",
  "common",
  "vendor",
  "codicons",
  "dist"
);
const nm = path.join(root, "node_modules");

const copies = [
  {
    from: path.join(nm, "chatarea", "lib"),
    to: path.join(vendorRoot, "chatarea", "lib"),
    label: "chatarea/lib",
    recursive: true,
  },
  {
    from: path.join(nm, "marked", "lib", "marked.umd.js"),
    to: path.join(vendorRoot, "marked", "lib", "marked.umd.js"),
    label: "marked/lib/marked.umd.js",
    recursive: false,
  },
];

// 仅复制 Webview 所需文件；codicons 的 dist 含 .ts 会被 ts-loader 误纳入编译
const codiconCopies = [
  {
    from: path.join(nm, "@vscode", "codicons", "dist", "codicon.css"),
    to: path.join(commonCodiconsDir, "codicon.css"),
    label: "@vscode/codicons/dist/codicon.css",
  },
  {
    from: path.join(nm, "@vscode", "codicons", "dist", "codicon.ttf"),
    to: path.join(commonCodiconsDir, "codicon.ttf"),
    label: "@vscode/codicons/dist/codicon.ttf",
  },
];

function main() {
  if (!fs.existsSync(nm)) {
    console.error("[copy-ai-chat-vendor] 未找到 node_modules，请先执行 npm install。");
    process.exit(1);
  }

  if (fs.existsSync(vendorRoot)) {
    fs.rmSync(vendorRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(vendorRoot, { recursive: true });

  for (const c of copies) {
    if (!fs.existsSync(c.from)) {
      console.error(
        `[copy-ai-chat-vendor] 缺少依赖路径: ${c.label}（${c.from}）`
      );
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(c.to), { recursive: true });
    if (c.recursive) {
      fs.cpSync(c.from, c.to, { recursive: true });
    } else {
      fs.copyFileSync(c.from, c.to);
    }
  }

  fs.rmSync(commonCodiconsDir, { recursive: true, force: true });
  fs.mkdirSync(commonCodiconsDir, { recursive: true });
  for (const c of codiconCopies) {
    if (!fs.existsSync(c.from)) {
      console.error(
        `[copy-ai-chat-vendor] 缺少依赖路径: ${c.label}（${c.from}）`
      );
      process.exit(1);
    }
    fs.copyFileSync(c.from, c.to);
  }

  console.log("[copy-ai-chat-vendor] 已写入", vendorRoot, "与", commonCodiconsDir);
}

main();
