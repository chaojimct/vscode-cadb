(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  // --- DOM refs ---
  const chatMessages = document.getElementById("chatMessages");
  const chatInput = document.getElementById("chatInput");
  const chatInputArea = document.getElementById("chatInputArea");
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsOverlay = document.getElementById("settingsOverlay");
  const settingsSaveBtn = document.getElementById("settingsSaveBtn");
  const settingsCancelBtn = document.getElementById("settingsCancelBtn");
  const toggleApiKeyBtn = document.getElementById("toggleApiKey");
  const cfgApiKey = document.getElementById("cfgApiKey");
  const cfgBaseUrl = document.getElementById("cfgBaseUrl");
  const cfgModel = document.getElementById("cfgModel");
  const clearBtn = document.getElementById("clearBtn");
  const dbLabel = document.getElementById("dbLabel");
  const sessionSelect = document.getElementById("sessionSelect");
  const sessionNewBtn = document.getElementById("sessionNewBtn");
  const sessionDelBtn = document.getElementById("sessionDelBtn");
  const dbPickerScreen = document.getElementById("dbPickerScreen");
  const dbPicker = document.getElementById("dbPicker");
  const dbPickerConfirm = document.getElementById("dbPickerConfirm");
  const quickQueryToggle = document.getElementById("quickQueryToggle");

  var QUICK_QUERY_STORAGE_KEY = "cadb.aiChat.quickQuery";

  // --- State ---
  let history = [];
  let streaming = false;
  let currentStreamText = "";
  let currentStreamBubble = null;

  /** @type {{ id:string, title:string, dbId:string, history:{role:string,content:string,html?:string}[] }[]} */
  let sessions = [];
  let currentSessionId = "";
  let persistTimer = null;

  /** 扩展下发的数据库选项 [{id,name}] */
  var dbOptions = [];

  function newSessionId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "s" + Date.now() + Math.random().toString(16).slice(2);
  }

  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(function () {
      persistTimer = null;
      vscode.postMessage({
        command: "persistSessions",
        sessions: sessions.map(function (s) {
          return {
            id: s.id, title: s.title, dbId: s.dbId || "",
            history: s.history.map(function (m) {
              return { role: m.role, content: m.content, html: m.html || "" };
            }),
          };
        }),
        currentSessionId: currentSessionId,
      });
    }, 400);
  }

  function getCurrentSession() {
    return sessions.find(function (s) { return s.id === currentSessionId; });
  }

  function ensureCurrentSession() {
    if (!sessions.length) {
      var id = newSessionId();
      sessions.push({ id: id, title: "新会话", dbId: "", history: [] });
      currentSessionId = id;
      return;
    }
    if (!sessions.some(function (s) { return s.id === currentSessionId; })) {
      currentSessionId = sessions[0].id;
    }
  }

  function syncHistoryToSession() {
    var cur = getCurrentSession();
    if (cur) cur.history = history.slice();
  }

  function refreshSessionSelect() {
    sessionSelect.innerHTML = "";
    sessions.forEach(function (s) {
      var opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.title || "未命名";
      sessionSelect.appendChild(opt);
    });
    sessionSelect.value = currentSessionId;
  }

  // --- 数据库选择屏 ---

  function showDbPicker() {
    dbPickerScreen.classList.remove("hidden");
    chatMessages.style.display = "none";
    chatInputArea.style.display = "none";
    populateDbPicker();
  }

  function hideDbPicker() {
    dbPickerScreen.classList.add("hidden");
    chatMessages.style.display = "";
    chatInputArea.style.display = "";
  }

  function populateDbPicker() {
    dbPicker.innerHTML = '<option value="" disabled selected>-- 请选择 --</option>';
    dbOptions.forEach(function (o) {
      if (!o.id || o.id === "__empty__") return;
      var opt = document.createElement("option");
      opt.value = o.id;
      opt.textContent = o.name || o.id;
      dbPicker.appendChild(opt);
    });
    dbPickerConfirm.disabled = true;
  }

  dbPicker.addEventListener("change", function () {
    dbPickerConfirm.disabled = !dbPicker.value;
  });

  dbPickerConfirm.addEventListener("click", function () {
    var val = dbPicker.value;
    if (!val) return;
    var cur = getCurrentSession();
    if (!cur) return;
    cur.dbId = val;
    var label = "";
    for (var i = 0; i < dbOptions.length; i++) {
      if (dbOptions[i].id === val) { label = dbOptions[i].name || val; break; }
    }
    dbLabel.textContent = label;
    hideDbPicker();
    rebuildMessagesFromHistory();
    schedulePersist();
    vscode.postMessage({ command: "requestTables", dbId: val });
  });

  // --- 聊天视图 ---

  function rebuildMessagesFromHistory() {
    chatMessages.innerHTML = "";
    if (!history.length) {
      var cur = getCurrentSession();
      var dbName = cur && cur.dbId ? cur.dbId.split("/").pop() : "";
      chatMessages.innerHTML =
        '<div class="welcome-msg">' +
        '<div class="welcome-icon">&#x1F4AC;</div>' +
        '<div class="welcome-title">你好，我是数据库 AI 助手</div>' +
        '<div class="welcome-hint">当前数据库: <b>' + escapeHtml(dbName || "未知") + '</b><br/>输入 <b>@</b> 可插入表名，Enter 发送。</div>' +
        "</div>";
      return;
    }
    for (var i = 0; i < history.length; i++) {
      var h = history[i];
      if (h.role === "user") {
        appendUserBubble(h.content, h.html);
      } else if (h.role === "assistant") {
        var bubble = appendAssistantBubble();
        renderMarkdown(bubble, h.content);
        addCopyButtons(bubble);
      }
    }
  }

  function applySession(id) {
    ensureCurrentSession();
    var s = sessions.find(function (x) { return x.id === id; });
    if (!s) return;
    currentSessionId = id;
    history = (s.history || []).map(function (m) {
      return { role: m.role, content: m.content, html: m.html || "" };
    });
    streaming = false;
    currentStreamText = "";
    currentStreamBubble = null;
    refreshSessionSelect();

    if (!s.dbId) {
      showDbPicker();
    } else {
      hideDbPicker();
      var label = "";
      for (var i = 0; i < dbOptions.length; i++) {
        if (dbOptions[i].id === s.dbId) { label = dbOptions[i].name || s.dbId; break; }
      }
      dbLabel.textContent = label || s.dbId;
      rebuildMessagesFromHistory();
      scrollToBottom();
      vscode.postMessage({ command: "requestTables", dbId: s.dbId });
    }
  }

  function updateCurrentTitleFromFirstUser() {
    var cur = getCurrentSession();
    if (!cur) return;
    var first = (cur.history || []).find(function (m) { return m.role === "user"; });
    if (first && first.content) {
      var t = first.content.replace(/\s+/g, " ").trim();
      if (t.length > 36) t = t.slice(0, 36) + "…";
      cur.title = t || "新会话";
    }
    refreshSessionSelect();
  }

  // --- ChatArea 初始化（@ 插入表名） ---
  var EMPTY_TABLE_HINT = [{ id: "__empty__", name: "加载中…" }];

  const chat = new ChatArea({
    elm: chatInput,
    maxLength: 8000,
    userList: EMPTY_TABLE_HINT,
    wrapKeyFun: function (event) {
      return event.shiftKey && event.key === "Enter";
    },
    sendKeyFun: function (event) {
      return !event.shiftKey && event.key === "Enter";
    },
  });

  try {
    chat.revisePCPointDialogLabel({ title: "选择数据表" });
  } catch (_e) {}

  chat.addEventListener("enterSend", onSend);

  function syncQuickQueryTip() {
    if (!quickQueryToggle) return;
    var on = quickQueryToggle.checked;
    try {
      sessionStorage.setItem(QUICK_QUERY_STORAGE_KEY, on ? "1" : "0");
    } catch (_e) {}
    try {
      if (on) {
        chat.openTipTag({
          tagLabel: "快速查询",
          popoverLabel:
            "已启用：模型通过单次 function calling 仅调用 execute_sql 一次，直接生成并执行最终语句（不再多步 list_tables / describe_table）。复杂探表请关闭本模式。",
          codeLabel: "",
        });
      } else {
        void chat.closeTipTag();
      }
    } catch (_e) {}
  }

  if (quickQueryToggle) {
    try {
      quickQueryToggle.checked = sessionStorage.getItem(QUICK_QUERY_STORAGE_KEY) === "1";
    } catch (_e) {}
    quickQueryToggle.addEventListener("change", syncQuickQueryTip);
    syncQuickQueryTip();
  }

  function updateTableList(tags) {
    var list = Array.isArray(tags) && tags.length > 0 ? tags : EMPTY_TABLE_HINT;
    try { chat.updateUserList(list); } catch (_e) {}
  }

  // --- 通知 Extension 就绪 ---
  vscode.postMessage({ command: "ready" });

  // --- 消息发送 ---
  function onSend() {
    if (streaming) return;
    var cur = getCurrentSession();
    if (!cur || !cur.dbId) return;
    var text = (chat.getText() || "").trim();
    if (!text) return;
    var html = chat.getHtml() || "";

    removeWelcome();
    appendUserBubble(text, html);
    history.push({ role: "user", content: text, html: html });
    syncHistoryToSession();
    updateCurrentTitleFromFirstUser();
    schedulePersist();

    chat.clear();

    streaming = true;
    currentStreamText = "";
    currentStreamBubble = appendAssistantBubble();
    showTyping(currentStreamBubble);

    vscode.postMessage({
      command: "send",
      text: text,
      dbId: cur.dbId,
      quickSql: !!(quickQueryToggle && quickQueryToggle.checked),
      history: history.map(function (m) {
        return { role: m.role, content: m.content };
      }),
    });
  }

  // --- 接收 Extension 消息 ---
  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case "init":
        if (msg.config) {
          cfgApiKey.value = msg.config.apiKey || "";
          cfgBaseUrl.value = msg.config.baseUrl || "";
          cfgModel.value = msg.config.model || "";
        }
        dbOptions = Array.isArray(msg.dbOptions) ? msg.dbOptions : [];
        if (Array.isArray(msg.sessions) && msg.sessions.length) {
          sessions = msg.sessions.map(function (s) {
            return {
              id: s.id,
              title: s.title || "会话",
              dbId: s.dbId || "",
              history: Array.isArray(s.history)
                ? s.history.map(function (m) {
                    return { role: m.role, content: m.content, html: m.html || "" };
                  })
                : [],
            };
          });
          currentSessionId = msg.currentSessionId || sessions[0].id;
        } else {
          var nid = newSessionId();
          sessions = [{ id: nid, title: "新会话", dbId: "", history: [] }];
          currentSessionId = nid;
        }
        ensureCurrentSession();
        applySession(currentSessionId);
        break;

      case "refresh":
        dbOptions = Array.isArray(msg.dbOptions) ? msg.dbOptions : dbOptions;
        break;

      case "updateTableTags":
        updateTableList(msg.tableTags);
        break;

      case "stream-start":
        currentStreamText = "";
        if (currentStreamBubble) hideTyping(currentStreamBubble);
        break;

      case "tool-start":
        if (currentStreamBubble) {
          hideTyping(currentStreamBubble);
          appendToolCallIndicator(currentStreamBubble, msg.toolName || "tool", msg.input || "", true);
        }
        break;

      case "tool-end":
        if (currentStreamBubble) {
          appendToolCallIndicator(currentStreamBubble, msg.toolName || "tool", msg.output || "", false);
        }
        scrollToBottom();
        break;

      case "stream-chunk":
        currentStreamText += msg.text || "";
        if (currentStreamBubble) renderMarkdown(currentStreamBubble, currentStreamText);
        scrollToBottom();
        break;

      case "stream-end":
        streaming = false;
        if (currentStreamText) {
          history.push({ role: "assistant", content: currentStreamText });
          syncHistoryToSession();
          schedulePersist();
        }
        if (currentStreamBubble) {
          renderMarkdown(currentStreamBubble, currentStreamText);
          addCopyButtons(currentStreamBubble);
        }
        currentStreamBubble = null;
        scrollToBottom();
        break;

      case "stream-error":
        streaming = false;
        if (currentStreamBubble) currentStreamBubble.closest(".msg-row")?.remove();
        currentStreamBubble = null;
        appendErrorBubble(msg.error || "请求失败");
        scrollToBottom();
        break;
    }
  });

  // --- 会话管理 ---
  sessionSelect.addEventListener("change", function () {
    syncHistoryToSession();
    applySession(sessionSelect.value);
    schedulePersist();
  });

  sessionNewBtn.addEventListener("click", function () {
    syncHistoryToSession();
    var id = newSessionId();
    sessions.unshift({ id: id, title: "新会话", dbId: "", history: [] });
    currentSessionId = id;
    history = [];
    streaming = false;
    currentStreamText = "";
    currentStreamBubble = null;
    refreshSessionSelect();
    showDbPicker();
    schedulePersist();
  });

  sessionDelBtn.addEventListener("click", function () {
    if (sessions.length <= 1) {
      var cur = getCurrentSession();
      if (cur) {
        cur.history = [];
        cur.dbId = "";
        cur.title = "新会话";
        history = [];
        streaming = false;
        currentStreamText = "";
        currentStreamBubble = null;
        refreshSessionSelect();
        showDbPicker();
        schedulePersist();
      }
      return;
    }
    sessions = sessions.filter(function (s) { return s.id !== currentSessionId; });
    currentSessionId = sessions[0].id;
    applySession(currentSessionId);
    schedulePersist();
  });

  // --- DOM helpers ---
  function removeWelcome() {
    var w = chatMessages.querySelector(".welcome-msg");
    if (w) w.remove();
  }

  function appendUserBubble(text, html) {
    var row = document.createElement("div");
    row.className = "msg-row user";
    var bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    if (html) { bubble.innerHTML = html; } else { bubble.textContent = text; }
    var avatar = document.createElement("div");
    avatar.className = "msg-avatar";
    avatar.textContent = "U";
    row.appendChild(bubble);
    row.appendChild(avatar);
    chatMessages.appendChild(row);
    scrollToBottom();
    return row;
  }

  function appendAssistantBubble() {
    var row = document.createElement("div");
    row.className = "msg-row assistant";
    row.innerHTML = '<div class="msg-avatar">AI</div><div class="msg-bubble"></div>';
    chatMessages.appendChild(row);
    scrollToBottom();
    return row.querySelector(".msg-bubble");
  }

  function appendErrorBubble(errText) {
    var row = document.createElement("div");
    row.className = "msg-row assistant";
    row.innerHTML = '<div class="msg-avatar">AI</div><div class="msg-bubble msg-error">' + escapeHtml(errText) + "</div>";
    chatMessages.appendChild(row);
  }

  function showTyping(bubble) {
    bubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  }

  function hideTyping(bubble) {
    var dots = bubble.querySelector(".typing-dots");
    if (dots) dots.remove();
  }

  function appendToolCallIndicator(bubble, toolName, detail, isStart) {
    var TOOL_LABELS = { execute_sql: "执行 SQL", list_tables: "查询表列表", describe_table: "查看表结构" };
    var TOOL_ICONS = { execute_sql: "&#9654;", list_tables: "&#128203;", describe_table: "&#128269;" };
    var label = TOOL_LABELS[toolName] || toolName;
    var icon = TOOL_ICONS[toolName] || "&#9881;";

    if (isStart) {
      var wrapper = document.createElement("details");
      wrapper.className = "tool-panel tool-running";
      wrapper.setAttribute("data-tool", toolName);

      var summary = document.createElement("summary");
      summary.className = "tool-panel-header";
      summary.innerHTML =
        '<span class="tool-panel-icon">' + icon + '</span>' +
        '<span class="tool-panel-label">' + escapeHtml(label) + '</span>' +
        '<span class="tool-panel-status"><span class="tool-spinner"></span> 调用中</span>';
      wrapper.appendChild(summary);

      var inputSection = document.createElement("div");
      inputSection.className = "tool-panel-section";
      var inputTitle = document.createElement("div");
      inputTitle.className = "tool-panel-section-title";
      inputTitle.textContent = "参数";
      inputSection.appendChild(inputTitle);
      var inputPre = document.createElement("pre");
      inputPre.className = "tool-panel-code";
      try {
        var parsed = JSON.parse(detail);
        inputPre.textContent = JSON.stringify(parsed, null, 2);
      } catch (_e) {
        inputPre.textContent = detail || "(无)";
      }
      inputSection.appendChild(inputPre);
      wrapper.appendChild(inputSection);

      var resultSection = document.createElement("div");
      resultSection.className = "tool-panel-section tool-panel-result";
      resultSection.style.display = "none";
      wrapper.appendChild(resultSection);

      bubble.appendChild(wrapper);
    } else {
      var panels = bubble.querySelectorAll('.tool-panel.tool-running[data-tool="' + toolName + '"]');
      var target = panels.length > 0 ? panels[panels.length - 1] : null;
      if (target) {
        target.classList.remove("tool-running");
        target.classList.add("tool-done");

        var statusEl = target.querySelector(".tool-panel-status");
        if (statusEl) statusEl.innerHTML = '<span class="tool-panel-check">&#10003;</span> 完成';

        var resultSec = target.querySelector(".tool-panel-result");
        if (resultSec && detail) {
          resultSec.style.display = "";
          var resultTitle = document.createElement("div");
          resultTitle.className = "tool-panel-section-title";
          resultTitle.textContent = "结果";
          resultSec.appendChild(resultTitle);
          var resultPre = document.createElement("pre");
          resultPre.className = "tool-panel-code tool-panel-code-result";
          resultPre.textContent = detail.slice(0, 5000);
          resultSec.appendChild(resultPre);
        }

        target.setAttribute("open", "");
      }
    }
  }

  function scrollToBottom() {
    requestAnimationFrame(function () { chatMessages.scrollTop = chatMessages.scrollHeight; });
  }

  /** 将复制类按钮设为 codicon 图标（不依赖外部模板字符串） */
  function setBtnCodicon(btn, codiconName) {
    btn.innerHTML = '<i class="codicon codicon-' + codiconName + '" aria-hidden="true"></i>';
  }

  function resetCopyIconButton(btn, defaultCodicon) {
    setBtnCodicon(btn, defaultCodicon || "clippy");
  }

  function flashCopyIconButton(btn, ok, defaultCodicon) {
    var def = defaultCodicon || "clippy";
    setBtnCodicon(btn, ok ? "check" : "error");
    setTimeout(function () { setBtnCodicon(btn, def); }, 1500);
  }

  /** 是否为 GFM 表格分隔行（| --- | --- |） */
  function isMarkdownTableSeparatorLine(line) {
    var t = line.trim();
    return t.length >= 3 && /^\|[\s\-:|]+\|\s*$/.test(t);
  }

  /** 是否为 GFM 表格数据/表头行（整行以 | 包裹） */
  function isMarkdownTableRowLine(line) {
    var t = line.trim();
    if (t.length < 3 || t.charAt(0) !== "|") return false;
    if (t.charAt(t.length - 1) !== "|") return false;
    if (isMarkdownTableSeparatorLine(line)) return true;
    return /\|[^|]+\|/.test(t);
  }

  /**
   * 修复模型常见输出：正文与表格之间只有单个换行，GFM 不会识别为表格，整段会变成「乱码」纯文本。
   * 在 ``` 围栏外：若上一行不是表格行且非空，下一行是表格行，则插入空行；并处理「共 N 行。|」粘在同一行的情况。
   */
  function normalizeMarkdownForGfmTables(src) {
    if (!src) return src;
    var parts = src.split(/(```[\s\S]*?```)/g);
    for (var p = 0; p < parts.length; p++) {
      if (p % 2 === 1) continue;
      var chunk = parts[p];
      chunk = chunk.replace(/([。！？…])\s*\|/g, "$1\n\n|");
      var lines = chunk.split("\n");
      var out = [];
      for (var i = 0; i < lines.length; i++) {
        if (i > 0) {
          var prevTrim = lines[i - 1].trim();
          var curTrim = lines[i].trim();
          var prevIsTable =
            prevTrim !== "" &&
            (isMarkdownTableRowLine(lines[i - 1]) || isMarkdownTableSeparatorLine(lines[i - 1]));
          var curIsTable =
            curTrim !== "" &&
            (isMarkdownTableRowLine(lines[i]) || isMarkdownTableSeparatorLine(lines[i]));
          if (curIsTable && !prevIsTable && prevTrim !== "") {
            if (out.length > 0 && out[out.length - 1] !== "") {
              out.push("");
            }
          }
        }
        out.push(lines[i]);
      }
      parts[p] = out.join("\n");
    }
    return parts.join("");
  }

  /** 将 HTML table 转为 TSV，便于粘贴到 Excel / 表格软件 */
  function htmlTableToTsv(table) {
    if (!table || !table.rows) return "";
    var rows = [];
    for (var r = 0; r < table.rows.length; r++) {
      var cells = table.rows[r].cells;
      var line = [];
      for (var c = 0; c < cells.length; c++) {
        var raw = (cells[c].textContent || "").replace(/\r?\n/g, " ").replace(/\t/g, " ");
        line.push(raw.trim());
      }
      rows.push(line.join("\t"));
    }
    return rows.join("\n");
  }

  /**
   * 将气泡内由 Markdown 渲染出的 table 包成可折叠区域，避免一条消息里多张表占满屏幕。
   * 默认折叠，用户点击摘要行展开。
   */
  function wrapMarkdownTablesCollapsible(root) {
    if (!root) return;
    var tables = root.querySelectorAll("table");
    for (var i = 0; i < tables.length; i++) {
      var table = tables[i];
      if (table.closest(".md-table-fold")) continue;
      var parent = table.parentNode;
      if (!parent) continue;
      var rowHint = table.rows && table.rows.length ? table.rows.length + " 行" : "表格";
      var details = document.createElement("details");
      details.className = "md-table-fold";
      var summary = document.createElement("summary");
      summary.className = "md-table-fold-summary";
      var titleSpan = document.createElement("span");
      titleSpan.className = "md-table-fold-title";
      titleSpan.textContent = "数据表格（" + rowHint + "，点击展开）";
      var copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "md-table-copy-btn icon-btn-codicon";
      copyBtn.title = "复制表格（制表符分隔，可粘贴到 Excel）";
      copyBtn.setAttribute("aria-label", "复制表格");
      resetCopyIconButton(copyBtn, "table");
      copyBtn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var tsv = htmlTableToTsv(table);
        if (!tsv) {
          flashCopyIconButton(copyBtn, false, "table");
          return;
        }
        navigator.clipboard.writeText(tsv).then(function () {
          flashCopyIconButton(copyBtn, true, "table");
        }).catch(function () {
          flashCopyIconButton(copyBtn, false, "table");
        });
      });
      summary.appendChild(titleSpan);
      summary.appendChild(copyBtn);
      var body = document.createElement("div");
      body.className = "md-table-fold-body";
      parent.insertBefore(details, table);
      details.appendChild(summary);
      body.appendChild(table);
      details.appendChild(body);
    }
  }

  function renderMarkdown(bubble, text) {
    if (!text) { bubble.innerHTML = ""; return; }
    try {
      var normalized = normalizeMarkdownForGfmTables(text);
      bubble.innerHTML = marked.parse(normalized, { breaks: true, gfm: true });
      wrapMarkdownTablesCollapsible(bubble);
    } catch (_e) {
      bubble.textContent = text;
    }
  }

  function addCopyButtons(bubble) {
    var pres = bubble.querySelectorAll("pre");
    pres.forEach(function (pre) {
      var wrapper = document.createElement("div");
      wrapper.className = "code-block-wrapper";
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "code-copy-btn icon-btn-codicon";
      btn.title = "复制";
      btn.setAttribute("aria-label", "复制代码");
      resetCopyIconButton(btn, "clippy");
      btn.addEventListener("click", function () {
        var code = pre.querySelector("code");
        navigator.clipboard.writeText((code || pre).textContent || "").then(function () {
          flashCopyIconButton(btn, true, "clippy");
        }).catch(function () {
          flashCopyIconButton(btn, false, "clippy");
        });
      });
      wrapper.appendChild(btn);
    });
  }

  // --- 设置面板 ---
  settingsBtn.addEventListener("click", function () { settingsOverlay.classList.add("visible"); });
  settingsCancelBtn.addEventListener("click", function () { settingsOverlay.classList.remove("visible"); });
  settingsOverlay.addEventListener("click", function (e) { if (e.target === settingsOverlay) settingsOverlay.classList.remove("visible"); });
  settingsSaveBtn.addEventListener("click", function () {
    vscode.postMessage({ command: "saveConfig", apiKey: cfgApiKey.value.trim(), baseUrl: cfgBaseUrl.value.trim(), model: cfgModel.value.trim() });
    settingsOverlay.classList.remove("visible");
  });
  toggleApiKeyBtn.addEventListener("click", function () { cfgApiKey.type = cfgApiKey.type === "password" ? "text" : "password"; });

  clearBtn.addEventListener("click", function () {
    history = [];
    streaming = false;
    currentStreamText = "";
    currentStreamBubble = null;
    var cur = getCurrentSession();
    if (cur) { cur.history = []; if (sessions.length === 1) cur.title = "新会话"; }
    rebuildMessagesFromHistory();
    schedulePersist();
  });

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
})();
