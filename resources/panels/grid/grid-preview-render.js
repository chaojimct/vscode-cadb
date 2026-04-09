/**
 * 根据扩展校验通过的 pluginId 在侧栏中渲染预览（避免把 HTML 拼接分散在各处）
 * JSON 预览使用 jsoneditor（npm），只读 view 模式。
 */
(function (global) {
  let cadbJsonEditorInstance = null;
  /** @type {HTMLButtonElement | null} */
  let cadbJsonExpandToggleBtn = null;
  let cadbJsonTreeFullyExpanded = true;
  let cadbJsonEditModeActive = false;
  /** @type {any} */
  let cadbJsonOriginalData = null;
  /** @type {HTMLButtonElement | null} */
  let cadbJsonEditBtn = null;
  /** @type {HTMLButtonElement | null} */
  let cadbJsonApplyBtn = null;
  /** @type {HTMLButtonElement | null} */
  let cadbJsonCancelBtn = null;

  function destroyCadbJsonEditor() {
    if (!cadbJsonEditorInstance) {
      return;
    }
    try {
      cadbJsonEditorInstance.destroy();
    } catch (_e) {
      /* 忽略 */
    }
    cadbJsonEditorInstance = null;
    cadbJsonExpandToggleBtn = null;
    cadbJsonEditModeActive = false;
    cadbJsonOriginalData = null;
    cadbJsonEditBtn = null;
    cadbJsonApplyBtn = null;
    cadbJsonCancelBtn = null;
  }

  function updateJsonExpandToggleLabel() {
    if (!cadbJsonExpandToggleBtn) return;
    const icon = cadbJsonExpandToggleBtn.querySelector("i");
    if (icon) {
      icon.className = cadbJsonTreeFullyExpanded
        ? "codicon codicon-fold"
        : "codicon codicon-unfold";
    }
    const label = cadbJsonTreeFullyExpanded ? "全部收起" : "全部展开";
    cadbJsonExpandToggleBtn.title = label;
    cadbJsonExpandToggleBtn.setAttribute("aria-label", label);
    cadbJsonExpandToggleBtn.setAttribute(
      "aria-expanded",
      cadbJsonTreeFullyExpanded ? "true" : "false",
    );
  }

  function clearEl(el) {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  function setMeta(el, text) {
    if (!el) return;
    clearEl(el);
    el.textContent = text || "";
  }

  /**
   * @param {HTMLElement} container
   * @param {string} pluginId
   * @param {string} raw
   */
  function renderInto(container, pluginId, raw) {
    if (!container) return;
    destroyCadbJsonEditor();
    container.classList.remove("grid-preview-panel__body--jsoneditor");
    clearEl(container);
    const s = raw == null ? "" : String(raw);

    if (pluginId === "preview-json") {
      let data;
      try {
        data = JSON.parse(s.trim());
      } catch (_e) {
        const pre = document.createElement("pre");
        pre.className = "grid-preview-panel__pre";
        pre.textContent = s;
        container.appendChild(pre);
        return;
      }
      const JSONEditorCtor =
        global.JSONEditor ||
        (typeof window !== "undefined" ? window.JSONEditor : null);
      if (typeof JSONEditorCtor !== "function") {
        const pre = document.createElement("pre");
        pre.className = "grid-preview-panel__pre";
        pre.textContent = JSON.stringify(data, null, 2);
        container.appendChild(pre);
        return;
      }
      container.classList.add("grid-preview-panel__body--jsoneditor");
      const toolbar = document.createElement("div");
      toolbar.className = "grid-preview-json-toolbar";
      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "grid-preview-json-icon-btn";
      toggleBtn.setAttribute("aria-label", "全部收起");
      toggleBtn.innerHTML =
        '<i class="codicon codicon-fold" aria-hidden="true"></i>';
      cadbJsonExpandToggleBtn = toggleBtn;
      cadbJsonTreeFullyExpanded = true;
      updateJsonExpandToggleLabel();
      toolbar.appendChild(toggleBtn);

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "grid-preview-json-icon-btn";
      editBtn.title = "编辑";
      editBtn.setAttribute("aria-label", "编辑 JSON");
      editBtn.innerHTML =
        '<i class="codicon codicon-edit" aria-hidden="true"></i>';
      cadbJsonEditBtn = editBtn;
      toolbar.appendChild(editBtn);

      const applyBtn = document.createElement("button");
      applyBtn.type = "button";
      applyBtn.className =
        "grid-preview-json-icon-btn grid-preview-json-icon-btn--primary is-hidden";
      applyBtn.title = "应用";
      applyBtn.setAttribute("aria-label", "应用修改");
      applyBtn.innerHTML =
        '<i class="codicon codicon-check" aria-hidden="true"></i>';
      cadbJsonApplyBtn = applyBtn;
      toolbar.appendChild(applyBtn);

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "grid-preview-json-icon-btn is-hidden";
      cancelBtn.title = "取消";
      cancelBtn.setAttribute("aria-label", "取消编辑");
      cancelBtn.innerHTML =
        '<i class="codicon codicon-discard" aria-hidden="true"></i>';
      cadbJsonCancelBtn = cancelBtn;
      toolbar.appendChild(cancelBtn);

      container.appendChild(toolbar);
      const host = document.createElement("div");
      host.className = "grid-preview-jsoneditor-host";
      container.appendChild(host);
      try {
        cadbJsonEditorInstance = new JSONEditorCtor(host, {
          mode: "view",
          navigationBar: false,
          statusBar: true,
          mainMenuBar: false,
        });
        cadbJsonEditorInstance.set(data);
        try {
          if (typeof cadbJsonEditorInstance.expandAll === "function") {
            cadbJsonEditorInstance.expandAll();
          }
        } catch (_expandErr) {
          /* 忽略：极端情况下展开失败不影响只读展示 */
        }
        cadbJsonTreeFullyExpanded = true;
        updateJsonExpandToggleLabel();
        toggleBtn.onclick = function () {
          if (!cadbJsonEditorInstance) return;
          if (cadbJsonTreeFullyExpanded) {
            try {
              if (typeof cadbJsonEditorInstance.collapseAll === "function") {
                cadbJsonEditorInstance.collapseAll();
              }
            } catch (_e) {
              /* 忽略 */
            }
            cadbJsonTreeFullyExpanded = false;
          } else {
            try {
              if (typeof cadbJsonEditorInstance.expandAll === "function") {
                cadbJsonEditorInstance.expandAll();
              }
            } catch (_e) {
              /* 忽略 */
            }
            cadbJsonTreeFullyExpanded = true;
          }
          updateJsonExpandToggleLabel();
        };

        function enterJsonEditMode() {
          if (!cadbJsonEditorInstance) return;
          try {
            cadbJsonOriginalData = cadbJsonEditorInstance.get();
          } catch (_) {
            cadbJsonOriginalData = null;
          }
          try {
            cadbJsonEditorInstance.setMode("tree");
          } catch (_err) {
            return;
          }
          cadbJsonEditModeActive = true;
          editBtn.classList.add("is-hidden");
          toggleBtn.classList.add("is-hidden");
          applyBtn.classList.remove("is-hidden");
          cancelBtn.classList.remove("is-hidden");
        }

        function exitJsonEditMode(newData) {
          try {
            cadbJsonEditorInstance.setMode("view");
            cadbJsonEditorInstance.set(newData);
            if (typeof cadbJsonEditorInstance.expandAll === "function") {
              cadbJsonEditorInstance.expandAll();
            }
          } catch (_) {
            /* 忽略 */
          }
          cadbJsonEditModeActive = false;
          cadbJsonOriginalData = null;
          cadbJsonTreeFullyExpanded = true;
          updateJsonExpandToggleLabel();
          editBtn.classList.remove("is-hidden");
          toggleBtn.classList.remove("is-hidden");
          applyBtn.classList.add("is-hidden");
          cancelBtn.classList.add("is-hidden");
        }

        editBtn.onclick = function () {
          enterJsonEditMode();
        };
        applyBtn.onclick = function () {
          if (!cadbJsonEditorInstance) return;
          let newData;
          try {
            newData = cadbJsonEditorInstance.get();
          } catch (_err) {
            /* JSON 无效时 JSONEditor 已有内联提示，等用户修正后再应用 */
            return;
          }
          if (typeof window.cadbApplyPreviewJsonEdit === "function") {
            window.cadbApplyPreviewJsonEdit(JSON.stringify(newData));
          }
          exitJsonEditMode(newData);
        };
        cancelBtn.onclick = function () {
          exitJsonEditMode(
            cadbJsonOriginalData !== null ? cadbJsonOriginalData : data,
          );
        };
      } catch (err) {
        cadbJsonExpandToggleBtn = null;
        toolbar.remove();
        host.textContent =
          err && err.message ? String(err.message) : String(err);
      }
      return;
    }

    if (pluginId === "preview-image") {
      const img = document.createElement("img");
      img.className = "grid-preview-panel__img";
      img.alt = "预览";
      img.src = s;
      container.appendChild(img);
      return;
    }

    if (pluginId === "preview-url") {
      const wrap = document.createElement("div");
      wrap.className = "grid-preview-panel__url";
      const a = document.createElement("a");
      a.href = s;
      a.textContent = s;
      a.rel = "noopener noreferrer";
      a.target = "_blank";
      wrap.appendChild(a);
      const hint = document.createElement("p");
      hint.className = "grid-preview-panel__hint";
      hint.textContent = "点击链接在浏览器中打开（若被策略拦截请复制 URL）";
      wrap.appendChild(hint);
      container.appendChild(wrap);
      return;
    }

    const pre = document.createElement("pre");
    pre.className = "grid-preview-panel__pre";
    pre.textContent = s;
    container.appendChild(pre);
  }

  /**
   * @param {{ metaEl: HTMLElement | null, bodyEl: HTMLElement | null, dataFormatLabel?: string, columnField?: string, pluginId?: string, message?: string, success?: boolean, rawValue?: string }} opts
   */
  function applyPreviewMessage(opts) {
    const metaEl = opts.metaEl;
    const bodyEl = opts.bodyEl;
    if (!bodyEl) return;

    destroyCadbJsonEditor();
    bodyEl.classList.remove("grid-preview-panel__body--jsoneditor");

    if (!opts.success) {
      setMeta(
        metaEl,
        opts.dataFormatLabel
          ? `${opts.dataFormatLabel}${opts.pluginId ? " · " + opts.pluginId : ""}`
          : "",
      );
      clearEl(bodyEl);
      const p = document.createElement("p");
      p.className = "grid-preview-panel__err";
      p.textContent = opts.message || "无法预览";
      bodyEl.appendChild(p);
      return;
    }

    const label = opts.dataFormatLabel || opts.pluginId || "预览";
    const col = opts.columnField ? `列：${opts.columnField}` : "";
    setMeta(metaEl, col ? `${label} · ${col}` : label);
    renderInto(
      bodyEl,
      String(opts.pluginId || "preview-text"),
      opts.rawValue != null ? String(opts.rawValue) : "",
    );
  }

  global.CadbGridPreviewRender = {
    renderInto,
    applyPreviewMessage,
  };
})(typeof window !== "undefined" ? window : globalThis);
