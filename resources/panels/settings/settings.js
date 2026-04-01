/**
 * 统一配置页面
 * 根据配置类型动态加载不同的表单
 */

// VSCode API
const vscode = acquireVsCodeApi();

// 当前配置类型
let currentConfigType = null;
let dynamicForm = null;

// ==================== 配置类型定义 ====================

const CONFIG_TYPES = {
  DATASOURCE: "datasource",
  USER: "user",
  DATABASE: "database",
  DRIVERS: "drivers",
  CONNECTION_GROUPS: "connectionGroups",
};

/** 新建/编辑连接时由扩展下发的可选驱动列表（保持到切换其它配置页） */
let datasourceDriverOptions = null;
/** 连接表单「分组」下拉选项（扩展下发；切换数据库类型时沿用） */
let datasourceGroupOptions = null;

// ==================== 从全局配置获取字段映射 ====================

// 获取全局字段配置
const FieldConfig = window.FieldConfig;
const datasourceFieldMapping = FieldConfig.datasource;
const userFieldMapping = FieldConfig.user;
const databaseFieldMapping = FieldConfig.database;
const privilegeFields = FieldConfig.privilegeFields;

// ==================== 自定义表单类 ====================

// 用户表单（扩展权限字段布局）
class UserDynamicForm extends DynamicForm {
  generateFieldsHtml(fields) {
    let html = "";
    
    // 分离权限字段和普通字段
    const privilegeFields = [];
    const normalFields = [];
    
    fields.forEach(field => {
      if (field.config.type === "checkbox" && field.name.endsWith("_priv")) {
        privilegeFields.push(field);
      } else {
        normalFields.push(field);
      }
    });
    
    // 先渲染普通字段
    if (normalFields.length > 0) {
      const useGrid = normalFields.length >= 4;
      if (useGrid) {
        html += '<div class="field-group">';
      }
      normalFields.forEach(field => {
        html += this.generateFieldHtml(field.name, field.config);
      });
      if (useGrid) {
        html += '</div>';
      }
    }
    
    // 再渲染权限字段（使用特殊网格布局）
    if (privilegeFields.length > 0) {
      if (normalFields.length > 0) {
        html += '<div class="section-title-small">权限设置</div>';
      }
      html += '<div class="permission-grid">';
      privilegeFields.forEach(field => {
        html += '<div class="layui-form-item permission-item">';
        html += this.generateCheckboxField(field.name, field.config);
        html += '</div>';
      });
      html += '</div>';
    }
    
    return html;
  }
}

// ==================== 初始化函数 ====================

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s == null ? "" : String(s);
  return div.innerHTML;
}

/**
 * 初始化数据库连接配置表单
 * @param {object} data
 * @param {Array<{id:string,label:string,description?:string}>|null} driverOptionsFromHost 扩展下发的已启用驱动；null 表示沿用上次
 */
function initDatasourceForm(data = {}, driverOptionsFromHost) {
  $("#pageTitle").text("数据库连接配置");
  $("#pageSubtitle").text("仅显示已在「管理数据库驱动」中启用的数据库类型");
  
  if (Array.isArray(driverOptionsFromHost) && driverOptionsFromHost.length > 0) {
    datasourceDriverOptions = driverOptionsFromHost;
  }

  const allowedIds = new Set(
    (datasourceDriverOptions || []).map((o) => o.id)
  );
  const fallbackType =
    (datasourceDriverOptions && datasourceDriverOptions[0] && datasourceDriverOptions[0].id) || "mysql";

  // 根据数据库类型过滤字段
  let dbType = data.dbType || fallbackType;
  if (allowedIds.size > 0 && !allowedIds.has(dbType)) {
    dbType = fallbackType;
  }
  let filteredData = { ...data, dbType };

  // 对于 SQLite，只显示相关字段
  if (dbType === "sqlite") {
    filteredData = {
      dbType: filteredData.dbType,
      name: data.name,
      group: data.group,
      saveLocation: data.saveLocation,
      markColor: data.markColor,
      sqlitePath: data.database || data.sqlitePath,
    };
  } else {
    // 对于其他数据库，移除 SQLite 字段
    delete filteredData.sqlitePath;
  }

  const mapping = JSON.parse(JSON.stringify(datasourceFieldMapping));
  if (datasourceDriverOptions && datasourceDriverOptions.length > 0) {
    mapping.dbType = {
      ...mapping.dbType,
      options: datasourceDriverOptions.map((o) => ({
        value: o.id,
        label: o.label,
      })),
    };
  }
  if (datasourceGroupOptions && datasourceGroupOptions.length > 0) {
    mapping.group = {
      ...mapping.group,
      options: datasourceGroupOptions.map((o) => ({
        value: o.value != null ? String(o.value) : String(o),
        label: o.label != null ? String(o.label) : String(o.value ?? o),
      })),
    };
  }
  dynamicForm = new DynamicForm({
    container: "#formContainer",
    fieldMapping: mapping,
    formId: "datasource-form",
    onSubmit: handleDatasourceSave,
    onCancel: handleCancel,
    onTest: handleTest,
    testButton: {
      label: "测试连接",
      icon: "layui-icon-link",
      show: "true", // 默认显示，可以根据需要配置表达式
    },
  });

  dynamicForm.load(filteredData);

  // 监听数据库类型变化
  $(document).off("change", '[name="dbType"]').on("change", '[name="dbType"]', function () {
    const selectedType = $(this).val();
    const currentData = dynamicForm.getData();
    currentData.dbType = selectedType;
    initDatasourceForm(currentData, null);
  });
}

/**
 * 数据库驱动 + 预览插件管理（Tab：驱动 / 预览插件；安装=启用 / 卸载=停用）
 */
function initDriversForm(drivers, previewPlugins, extensionVersion) {
  $("#pageTitle").text("驱动与预览");
  const ver =
    extensionVersion != null && String(extensionVersion).trim()
      ? `当前扩展 v${String(extensionVersion).trim()}。`
      : "";
  $("#pageSubtitle").text(
    `使用上方标签切换「驱动」与「预览插件」。驱动：「安装」后出现在新建连接中；表格中 Windows/Linux 为 Ctrl+单击、macOS 为 ⌘+单击单元格时按内容类型选用已启用的预览插件。${ver}`
  );
  dynamicForm = null;
  const list = Array.isArray(drivers) ? drivers : [];
  const plist = Array.isArray(previewPlugins) ? previewPlugins : [];

  let driversInner = '<div class="drivers-manage">';
  list.forEach((d) => {
    const id = escapeHtml(d.id);
    const rawId = d.id;
    const desc = d.description ? escapeHtml(d.description) : "";
    const statusClass = d.enabled ? "is-on" : "is-off";
    const statusText = d.enabled ? "已安装" : "未安装";

    let pkgsHtml = "";
    const pkgs = Array.isArray(d.packages) ? d.packages : [];
    if (pkgs.length > 0) {
      pkgsHtml += '<ul class="driver-packages__list">';
      pkgs.forEach((p) => {
        const pn = escapeHtml(p.name);
        const pv = escapeHtml(p.version);
        pkgsHtml += `<li><code class="driver-pkg-name">${pn}</code><span class="driver-pkg-ver">${pv}</span></li>`;
      });
      pkgsHtml += "</ul>";
    } else {
      pkgsHtml =
        '<p class="driver-packages__empty">未声明运行时 npm 依赖（由扩展侧注册表提供）</p>';
    }

    const installDisabled = d.enabled ? " disabled" : "";
    const uninstallDisabled = !d.enabled ? " disabled" : "";

    driversInner += `<article class="driver-card" data-driver-id="${escapeHtml(rawId)}">`;
    driversInner += '<div class="driver-card__main">';
    driversInner += `<div class="driver-card__head">`;
    driversInner += `<h2 class="driver-card__title">${escapeHtml(d.displayName)}`;
    driversInner += ` <span class="driver-card__id">${id}</span></h2>`;
    driversInner += `<span class="driver-card__status ${statusClass}">${statusText}</span>`;
    driversInner += `</div>`;
    if (desc) {
      driversInner += `<p class="driver-card__desc">${desc}</p>`;
    }
    if (d.marketplaceExtensionId) {
      driversInner += `<p class="driver-card__marketplace">扩展：<code>${escapeHtml(
        d.marketplaceExtensionId
      )}</code></p>`;
    }
    driversInner += `<div class="driver-packages"><div class="driver-packages__label">运行时依赖（npm）</div>${pkgsHtml}</div>`;
    driversInner += `</div>`;
    driversInner += `<div class="driver-card__actions">`;
    driversInner += `<button type="button" class="driver-btn driver-btn-install"${installDisabled} data-driver-action="install" data-driver-id="${escapeHtml(
      rawId
    )}" title="启用此驱动">`;
    driversInner += `<i class="codicon codicon-download" aria-hidden="true"></i><span>安装</span></button>`;
    driversInner += `<button type="button" class="driver-btn driver-btn-uninstall"${uninstallDisabled} data-driver-action="uninstall" data-driver-id="${escapeHtml(
      rawId
    )}" title="停用此驱动">`;
    driversInner += `<i class="codicon codicon-trash" aria-hidden="true"></i><span>卸载</span></button>`;
    driversInner += `</div></article>`;
  });
  driversInner += "</div>";

  let previewInner = '<div class="preview-plugins-manage">';
  previewInner += `<p class="preview-plugins-hint">与数据表格侧栏「预览」配合：仅对已启用的类型进行渲染。渲染包为扩展内置或与驱动管理页相同的 npm 版本解析规则。</p>`;
  plist.forEach((p) => {
    const rawId = p.id;
    const fmt = escapeHtml(p.dataFormatLabel || p.id);
    const desc = p.description ? escapeHtml(p.description) : "";
    const statusClass = p.enabled ? "is-on" : "is-off";
    const statusText = p.enabled ? "已安装" : "未安装";
    let pkgsHtml = "";
    const pkgs = Array.isArray(p.packages) ? p.packages : [];
    if (pkgs.length > 0) {
      pkgsHtml += '<ul class="driver-packages__list">';
      pkgs.forEach((pkg) => {
        const pn = escapeHtml(pkg.name);
        const pv = escapeHtml(pkg.version);
        pkgsHtml += `<li><code class="driver-pkg-name">${pn}</code><span class="driver-pkg-ver">${pv}</span></li>`;
      });
      pkgsHtml += "</ul>";
    } else {
      pkgsHtml = '<p class="driver-packages__empty">—</p>';
    }
    const installDisabled = p.enabled ? " disabled" : "";
    const uninstallDisabled = !p.enabled ? " disabled" : "";
    previewInner += `<article class="preview-plugin-card" data-preview-id="${escapeHtml(rawId)}">`;
    previewInner += '<div class="preview-plugin-card__main">';
    previewInner += `<div class="preview-plugin-card__head"><h2 class="preview-plugin-card__title">${fmt}</h2>`;
    previewInner += `<span class="driver-card__status ${statusClass}">${statusText}</span></div>`;
    if (desc) {
      previewInner += `<p class="driver-card__desc">${desc}</p>`;
    }
    previewInner += `<div class="driver-packages"><div class="driver-packages__label">渲染插件（npm / 内置）</div>${pkgsHtml}</div>`;
    previewInner += "</div>";
    previewInner += `<div class="preview-plugin-card__actions">`;
    previewInner += `<button type="button" class="driver-btn driver-btn-install"${installDisabled} data-preview-action="install" data-preview-id="${escapeHtml(
      rawId
    )}" title="启用此预览插件">`;
    previewInner += `<i class="codicon codicon-download" aria-hidden="true"></i><span>安装</span></button>`;
    previewInner += `<button type="button" class="driver-btn driver-btn-uninstall"${uninstallDisabled} data-preview-action="uninstall" data-preview-id="${escapeHtml(
      rawId
    )}" title="停用此预览插件">`;
    previewInner += `<i class="codicon codicon-trash" aria-hidden="true"></i><span>卸载</span></button>`;
    previewInner += "</div></article>";
  });
  previewInner += "</div>";

  let html = '<div class="drivers-manage-page">';
  html += '<div class="dm-tabs" role="tablist">';
  html +=
    '<button type="button" class="dm-tab is-active" data-dm-tab="drivers" role="tab" aria-selected="true">驱动</button>';
  html +=
    '<button type="button" class="dm-tab" data-dm-tab="preview" role="tab" aria-selected="false">预览插件</button>';
  html += "</div>";
  html += `<div class="dm-panel is-active" data-dm-panel="drivers" role="tabpanel">${driversInner}</div>`;
  html += `<div class="dm-panel" data-dm-panel="preview" role="tabpanel" hidden>${previewInner}</div>`;
  html += "</div>";

  $("#formContainer").html(html);

  $("#formContainer")
    .off("click.dmTab")
    .on("click.dmTab", ".dm-tab", function (e) {
      e.preventDefault();
      const tab = $(this).attr("data-dm-tab");
      if (!tab) return;
      $("#formContainer .dm-tab").removeClass("is-active").attr("aria-selected", "false");
      $(this).addClass("is-active").attr("aria-selected", "true");
      $("#formContainer .dm-panel").removeClass("is-active").attr("hidden", "hidden");
      $(`#formContainer .dm-panel[data-dm-panel="${tab}"]`).addClass("is-active").removeAttr("hidden");
    });

  $("#formContainer")
    .off("click.driversManage")
    .on("click.driversManage", "[data-driver-action]", function (e) {
      e.preventDefault();
      const $btn = $(this);
      if ($btn.prop("disabled")) {
        return;
      }
      const action = $btn.attr("data-driver-action");
      const driverId = $btn.attr("data-driver-id");
      if (!driverId) {
        return;
      }
      if (action === "install") {
        vscode.postMessage({ command: "setDriverEnabled", id: driverId, enabled: true });
      } else if (action === "uninstall") {
        vscode.postMessage({ command: "setDriverEnabled", id: driverId, enabled: false });
      }
    });

  $("#formContainer")
    .off("click.previewPluginsManage")
    .on("click.previewPluginsManage", "[data-preview-action]", function (e) {
      e.preventDefault();
      const $btn = $(this);
      if ($btn.prop("disabled")) {
        return;
      }
      const action = $btn.attr("data-preview-action");
      const id = $btn.attr("data-preview-id");
      if (!id) {
        return;
      }
      if (action === "install") {
        vscode.postMessage({ command: "setPreviewPluginEnabled", id, enabled: true });
      } else if (action === "uninstall") {
        vscode.postMessage({ command: "setPreviewPluginEnabled", id, enabled: false });
      }
    });
}

/** 与扩展侧栏一致：未分类连接归入此分组，且管理页中不可删除 */
const CG_DEFAULT_GROUP = "默认";

/**
 * 连接分组：输入名称后确认加入，下方 Tag 表示顺序（「默认」不可删除），保存写入扩展
 */
function initConnectionGroupsForm(groups) {
  $("#pageTitle").text("连接分组");
  $("#pageSubtitle").text(
    "「默认」分组固定存在、显示在列表最下方且不可删除，未填写分组的连接均归入默认。输入其他分组名后点「确认」加入；删除某个分组并保存后，该分组下的连接会移到默认。保存空列表表示完全按连接里的分组名自动排序。"
  );
  dynamicForm = null;

  function dedupeCgOrder(arr) {
    const out = [];
    const set = new Set();
    for (const n of arr) {
      const t = String(n || "").trim();
      if (!t) continue;
      if (!set.has(t)) {
        set.add(t);
        out.push(t);
      }
    }
    return out;
  }

  /** 非空列表时强制「默认」在末位且唯一 */
  function ensureDefaultAtEnd(arr) {
    const u = dedupeCgOrder(arr);
    if (u.length === 0) return [];
    const rest = u.filter((x) => x !== CG_DEFAULT_GROUP);
    return [...rest, CG_DEFAULT_GROUP];
  }

  /** @type {string[]} */
  let cgOrder = ensureDefaultAtEnd(Array.isArray(groups) ? groups : []);

  const html = `
    <div class="connection-groups-form">
      <div class="cg-add-row">
        <input type="text" id="cg-input" class="layui-input cg-input" maxlength="64" spellcheck="false" placeholder="输入分组名称" />
        <button type="button" class="layui-btn layui-btn-normal" id="cg-add">确认</button>
      </div>
      <div class="cg-tags-section">
        <div class="cg-tags-hint">当前顺序（自上而下对应侧栏显示顺序）</div>
        <div id="cg-tags" class="cg-tags" role="list"></div>
        <p class="cg-tags-empty" id="cg-tags-empty">暂无自定义顺序，保存后将按连接中的分组名自动排序。</p>
      </div>
      <div id="cg-status" class="cg-status" role="status" aria-live="polite"></div>
      <div class="cg-actions">
        <button type="button" class="layui-btn" id="cg-save">保存</button>
      </div>
    </div>`;
  $("#formContainer").html(html);

  const $status = $("#cg-status");
  const $empty = $("#cg-tags-empty");

  function setStatus(msg, kind) {
    $status.text(msg || "");
    $status.removeClass("is-ok is-err is-info");
    if (kind === "ok") {
      $status.addClass("is-ok");
    } else if (kind === "err") {
      $status.addClass("is-err");
    } else if (kind === "info") {
      $status.addClass("is-info");
    }
  }

  function renderCgTags() {
    const $box = $("#cg-tags");
    $box.empty();
    if (cgOrder.length === 0) {
      $empty.show();
    } else {
      $empty.hide();
    }
    cgOrder.forEach((name, index) => {
      const $tag = $('<span class="cg-tag" role="listitem">').attr("data-index", String(index));
      if (name === CG_DEFAULT_GROUP) {
        $tag.addClass("cg-tag--pinned");
      }
      $tag.append(
        $('<span class="cg-tag-text">')
          .text(name)
          .attr("title", name)
      );
      if (name !== CG_DEFAULT_GROUP) {
        $tag.append(
          $('<button type="button" class="cg-tag-close">')
            .text("×")
            .attr("title", "删除")
            .attr("aria-label", "删除分组 " + name)
        );
      }
      $box.append($tag);
    });
  }

  function tryAddOne() {
    const raw = String($("#cg-input").val() || "").trim();
    if (!raw) {
      setStatus("请输入分组名称", "info");
      return;
    }
    if (raw === CG_DEFAULT_GROUP) {
      setStatus("「默认」分组已固定显示在末位，无需添加", "info");
      return;
    }
    if (cgOrder.includes(raw)) {
      setStatus("该分组已在列表中", "info");
      return;
    }
    cgOrder = ensureDefaultAtEnd([...cgOrder, raw]);
    $("#cg-input").val("");
    setStatus("");
    renderCgTags();
  }

  renderCgTags();

  $("#cg-add")
    .off("click")
    .on("click", tryAddOne);

  $("#cg-input")
    .off("keydown")
    .on("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        tryAddOne();
      }
    });

  $("#cg-tags")
    .off("click", ".cg-tag-close")
    .on("click", ".cg-tag-close", function (e) {
      e.preventDefault();
      const $tag = $(this).closest(".cg-tag");
      const idx = Number($tag.attr("data-index"));
      if (!Number.isInteger(idx) || idx < 0 || idx >= cgOrder.length) {
        return;
      }
      if (cgOrder[idx] === CG_DEFAULT_GROUP) {
        return;
      }
      cgOrder.splice(idx, 1);
      cgOrder = ensureDefaultAtEnd(cgOrder);
      setStatus("");
      renderCgTags();
    });

  $("#cg-save")
    .off("click")
    .on("click", () => {
      const toSave = cgOrder.length === 0 ? [] : ensureDefaultAtEnd(cgOrder);
      vscode.postMessage({ command: "saveConnectionGroups", groups: toSave });
    });
}

/**
 * 初始化用户配置表单
 */
function initUserForm(data = {}) {
  $("#pageTitle").text("数据库用户配置");
  $("#pageSubtitle").text("管理数据库用户信息和权限设置");
  
  // 确保所有权限字段都存在
  const completeData = { ...data };
  privilegeFields.forEach(priv => {
    if (!(priv in completeData)) {
      completeData[priv] = "N";
    }
  });

  dynamicForm = new UserDynamicForm({
    container: "#formContainer",
    fieldMapping: userFieldMapping,
    formId: "user-form",
    onSubmit: handleUserSave,
    onCancel: handleCancel,
  });

  dynamicForm.load(completeData);

  // 监听 SSL 类型变化
  $(document).off("change", '[name="ssl_type"]').on("change", '[name="ssl_type"]', function () {
    const sslType = $(this).val();
    const $sslFields = $('[name="ssl_cipher"], [name="x509_issuer"], [name="x509_subject"]')
      .closest(".layui-form-item");
    
    if (sslType === "SPECIFIED" || sslType === "X509") {
      $sslFields.show();
    } else {
      $sslFields.hide();
    }
  });

  // 初始化时触发一次
  setTimeout(() => {
    $('[name="ssl_type"]').trigger("change");
  }, 100);
}

/**
 * 初始化数据库创建表单
 */
function initDatabaseForm(data = {}, options = {}) {
  const isEditMode = data && data._mode === "edit";
  $("#pageTitle").text(isEditMode ? "编辑数据库" : "创建数据库");
  $("#pageSubtitle").text(isEditMode ? "修改数据库配置" : "创建一个新的数据库");

  // 检查字段配置是否已加载
  if (!databaseFieldMapping) {
    console.error("databaseFieldMapping 未定义，FieldConfig 可能未正确加载");
    showStatus("字段配置未加载，请刷新页面重试", "error");
    return;
  }

  // 复制字段配置，避免修改全局配置
  const mapping = JSON.parse(JSON.stringify(databaseFieldMapping));
  
  // 如果提供了排序规则选项，更新下拉框
  if (options && options.collation) {
    mapping.collation.options = options.collation;
  }
  
  if (data && data._mode) {
    mapping._mode = { type: "hidden" };
  }
  if (data && data._originalName) {
    mapping._originalName = { type: "hidden" };
  }

  dynamicForm = new DynamicForm({
    container: "#formContainer",
    fieldMapping: mapping,
    formId: "database-form",
    onSubmit: handleDatabaseSave,
    onCancel: handleCancel
  });

  dynamicForm.load(data);
  }

// ==================== 事件处理 ====================

/**
 * 处理数据库连接配置保存
 */
function handleDatasourceSave(data) {
  // 对于 SQLite，将 sqlitePath 映射到 database
  if (data.dbType === "sqlite") {
    data.database = data.sqlitePath;
    delete data.sqlitePath;
  }

  vscode.postMessage({
    command: "save",
    payload: data,
  });

  showStatus("正在保存连接配置...", "success");
}

/**
 * 处理用户配置保存
 */
function handleUserSave(data) {
  // 转换权限字段为 Y/N 格式
  privilegeFields.forEach(priv => {
    if (priv in data) {
      data[priv] = data[priv] ? "Y" : "N";
    }
  });

  // 转换账户状态字段
  if ("account_locked" in data) {
    data.account_locked = data.account_locked ? "Y" : "N";
  }
  if ("password_expired" in data) {
    data.password_expired = data.password_expired ? "Y" : "N";
  }

  vscode.postMessage({
    command: "save",
    payload: data,
  });

  showStatus("正在保存用户配置...", "success");
}

/**
 * 处理数据库创建保存
 */
function handleDatabaseSave(data) {
  vscode.postMessage({
    command: "save",
    payload: data,
  });

  const isEditMode = data && data._mode === "edit";
  showStatus(isEditMode ? "正在保存数据库..." : "正在创建数据库...", "success");
}

/**
 * 处理测试连接
 */
function handleTest() {
  const data = dynamicForm.getData();

  // 对于 SQLite，将 sqlitePath 映射到 database
  if (data.dbType === "sqlite") {
    data.database = data.sqlitePath;
    delete data.sqlitePath;
  }

  vscode.postMessage({
    command: "test",
    payload: data,
  });

  showStatus("正在测试连接...", "success");
}

/**
 * 处理取消
 */
function handleCancel() {
  vscode.postMessage({
    command: "cancel",
  });
}

/**
 * 显示状态消息
 */
function showStatus(message, type = "success") {
  if (dynamicForm) {
    dynamicForm.showStatus(message, type);
  }
}

// ==================== 消息监听 ====================

window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || !message.command) {
    return;
  }

  switch (message.command) {
    case "load": {
      currentConfigType = message.configType;
      
      if (currentConfigType === CONFIG_TYPES.DATASOURCE) {
        if (Array.isArray(message.groupOptions)) {
          datasourceGroupOptions =
            message.groupOptions.length > 0
              ? message.groupOptions
              : [{ value: "默认", label: "默认" }];
        }
        // 数据库连接配置
        if (message.data && message.data.rowData && message.data.rowData.length > 0) {
          const rowData = { ...message.data.rowData[0] };
          if (rowData.group == null || String(rowData.group).trim() === "") {
            rowData.group = "默认";
          }
          initDatasourceForm(rowData, message.driverOptions || null);
        } else {
          // 新建模式：加载默认数据
          const opts = message.driverOptions || [];
          const firstId = (opts[0] && opts[0].id) || "mysql";
          const defaultData = {
            dbType: firstId,
            name: "",
            group: "默认",
            host: "localhost",
            port: 3306,
            username: "root",
            password: "",
            database: "",
          };
          initDatasourceForm(defaultData, message.driverOptions || null);
        }
      } else if (currentConfigType === CONFIG_TYPES.DRIVERS) {
        initDriversForm(message.drivers, message.previewPlugins, message.extensionVersion);
      } else if (currentConfigType === CONFIG_TYPES.CONNECTION_GROUPS) {
        initConnectionGroupsForm(message.groups);
      } else if (currentConfigType === CONFIG_TYPES.USER) {
        // 用户配置
        if (message.data && message.data.rowData && message.data.rowData.length > 0) {
          const rowData = message.data.rowData[0];
          initUserForm(rowData);
          showStatus("用户数据加载成功", "success");
        } else {
          // 新建模式：加载默认数据
          const defaultData = {
            User: "",
            Host: "%",
            plugin: "caching_sha2_password",
            password: "",
            ssl_type: "",
            account_locked: "N",
            password_expired: "N",
            max_connections: 0,
            max_questions: 0,
            max_updates: 0,
            max_user_connections: 0,
          };
          // 所有权限默认为 N
          privilegeFields.forEach(priv => {
            defaultData[priv] = "N";
          });
          initUserForm(defaultData);
        }
      } else if (currentConfigType === CONFIG_TYPES.DATABASE) {
        // 数据库创建
        initDatabaseForm(message.data || {}, message.options || {});
      }
      break;
    }
    case "status": {
      const { success, message: msg } = message;
      if (currentConfigType === CONFIG_TYPES.CONNECTION_GROUPS) {
        const el = document.getElementById("cg-status");
        if (el) {
          el.textContent = msg || "";
          el.className = "cg-status " + (success ? "is-ok" : "is-err");
        }
      } else {
        showStatus(msg, success ? "success" : "error");
      }
      break;
    }
  }
});

// ==================== 页面加载 ====================

document.addEventListener("DOMContentLoaded", () => {
  // 发送就绪消息
  vscode.postMessage({
    command: "ready",
  });
});

