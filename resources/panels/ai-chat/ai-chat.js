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
    placeholder: "描述需求…（@ 插入表名；Enter 发送，Shift+Enter 换行）",
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

  function renderMarkdown(bubble, text) {
    if (!text) { bubble.innerHTML = ""; return; }
    try { bubble.innerHTML = marked.parse(text, { breaks: true, gfm: true }); } catch (_e) { bubble.textContent = text; }
  }

  function addCopyButtons(bubble) {
    var pres = bubble.querySelectorAll("pre");
    pres.forEach(function (pre) {
      var wrapper = document.createElement("div");
      wrapper.className = "code-block-wrapper";
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);
      var btn = document.createElement("button");
      btn.className = "code-copy-btn";
      btn.textContent = "复制";
      btn.addEventListener("click", function () {
        var code = pre.querySelector("code");
        navigator.clipboard.writeText((code || pre).textContent || "").then(function () {
          btn.textContent = "已复制";
          setTimeout(function () { btn.textContent = "复制"; }, 1500);
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
