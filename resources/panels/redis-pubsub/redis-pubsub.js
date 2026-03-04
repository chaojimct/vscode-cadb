(function () {
  const vscode = window.vscode || (typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null);

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const subscribedChannels = new Set();

  function addMessage(channel, message) {
    const list = $("#message-list");
    if (!list) return;
    const li = document.createElement("li");
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    li.innerHTML =
      '<span class="msg-time">' +
      time +
      '</span><span class="msg-channel">[' +
      escapeHtml(channel) +
      "]</span><span class='msg-payload'>" +
      escapeHtml(String(message)) +
      "</span>";
    list.appendChild(li);
    list.scrollTop = list.scrollHeight;
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  function renderChannelList() {
    const ul = $("#channel-list");
    if (!ul) return;
    ul.innerHTML = "";
    subscribedChannels.forEach((ch) => {
      const li = document.createElement("li");
      li.innerHTML = escapeHtml(ch) + ' <span class="unsub" data-channel="' + escapeHtml(ch) + '">[退订]</span>';
      li.querySelector(".unsub").addEventListener("click", () => {
        vscode?.postMessage({ command: "unsubscribe", channel: ch });
        subscribedChannels.delete(ch);
        renderChannelList();
      });
      ul.appendChild(li);
    });
  }

  $("#btn-subscribe")?.addEventListener("click", () => {
    const input = $("#sub-channel");
    const ch = input?.value?.trim();
    if (!ch) return;
    vscode?.postMessage({ command: "subscribe", channel: ch });
    subscribedChannels.add(ch);
    renderChannelList();
    if (input) input.value = "";
  });

  $("#btn-publish")?.addEventListener("click", () => {
    const chInput = $("#pub-channel");
    const msgInput = $("#pub-message");
    const ch = chInput?.value?.trim();
    const msg = msgInput?.value ?? "";
    if (!ch) return;
    vscode?.postMessage({ command: "publish", channel: ch, message: msg });
    if (msgInput) msgInput.value = "";
  });

  $("#btn-clear")?.addEventListener("click", () => {
    const list = $("#message-list");
    if (list) list.innerHTML = "";
  });

  window.addEventListener("message", (event) => {
    const data = event.data || {};
    if (data.command === "message") {
      addMessage(data.channel || "", data.payload ?? "");
    }
    if (data.command === "subscribed") {
      subscribedChannels.add(data.channel || "");
      renderChannelList();
    }
    if (data.command === "unsubscribed") {
      subscribedChannels.delete(data.channel || "");
      renderChannelList();
    }
  });

  if (vscode) vscode.postMessage({ command: "ready" });
})();
