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
  DATABASE: "database"
};

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

/**
 * 初始化数据库连接配置表单
 */
function initDatasourceForm(data = {}) {
  $("#pageTitle").text("数据库连接配置");
  $("#pageSubtitle").text("配置数据库连接信息，支持多种数据库类型");
  
  // 根据数据库类型过滤字段
  const dbType = data.dbType || "mysql";
  let filteredData = { ...data };

  // 对于 SQLite，只显示相关字段
  if (dbType === "sqlite") {
    filteredData = {
      dbType: data.dbType,
      name: data.name,
      sqlitePath: data.database || data.sqlitePath,
    };
  } else {
    // 对于其他数据库，移除 SQLite 字段
    delete filteredData.sqlitePath;
  }

  dynamicForm = new DynamicForm({
    container: "#formContainer",
    fieldMapping: datasourceFieldMapping,
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
    initDatasourceForm(currentData);
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
        // 数据库连接配置
        if (message.data && message.data.rowData && message.data.rowData.length > 0) {
          const rowData = message.data.rowData[0];
          initDatasourceForm(rowData);
        } else {
          // 新建模式：加载默认数据
          const defaultData = {
            dbType: "mysql",
            name: "",
            host: "localhost",
            port: 3306,
            username: "root",
            password: "",
            database: "",
          };
          initDatasourceForm(defaultData);
        }
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
      showStatus(msg, success ? "success" : "error");
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

