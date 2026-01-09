/**
 * Edit 页面 - 数据库结构编辑视图
 * 用于对数据库、表、字段、索引等进行结构修改
 * 使用动态表单工具类
 */

// VSCode API
const vscode = acquireVsCodeApi();

// 模拟数据
const mockData = {
  fields: [
    {
      id: "field-name",
      name: "name",
      type: "varchar",
      length: 255,
      defaultValue: "",
      nullable: false,
    },
    {
      id: "field-email",
      name: "email",
      type: "varchar",
      length: 255,
      defaultValue: "",
      nullable: false,
    },
    {
      id: "field-age",
      name: "age",
      type: "int",
      length: null,
      defaultValue: "0",
      nullable: true,
    },
  ],
  indexes: [
    {
      id: "index-primary",
      name: "PRIMARY",
      type: "primary",
      fields: "id",
      unique: true,
    },
    {
      id: "index-unique-email",
      name: "unique_email",
      type: "unique",
      fields: "email",
      unique: true,
    },
  ],
};

// 当前编辑的项
let currentEditItem = null;
let currentEditType = null; // 'field' 或 'index'
let dynamicForm = null;

// ==================== 从全局配置获取字段映射 ====================

// 获取全局字段配置
const FieldConfig = window.FieldConfig;
const fieldMapping = FieldConfig.tableField;
const indexMapping = FieldConfig.index;

// Layui 初始化
layui.use(["element", "form", "layer"], function () {
  const element = layui.element;
  const layer = layui.layer;

  /**
   * 渲染字段列表
   */
  function renderFieldList() {
    const $fieldList = $("#field-list");
    $fieldList.empty();

    mockData.fields.forEach((field) => {
      // 根据字段类型显示不同的图标和标记
      let icon = "layui-icon-cols";
      let badge = "";
      
      if (field.key === "PRI") {
        icon = "layui-icon-key"; // 主键显示钥匙图标
        badge = '<span style="color: #FFB800; margin-left: 5px; font-size: 11px;">[PK]</span>';
      } else if (field.key === "UNI") {
        badge = '<span style="color: #1E9FFF; margin-left: 5px; font-size: 11px;">[UNI]</span>';
      } else if (field.key === "MUL") {
        badge = '<span style="color: #5FB878; margin-left: 5px; font-size: 11px;">[IDX]</span>';
      }
      
      $fieldList.append(`
        <li class="menu-item" data-id="${field.id}" data-type="field">
          <i class="layui-icon ${icon}"></i> ${field.name}${badge}
        </li>
      `);
    });

    // 默认选中第一个
    if (mockData.fields.length > 0) {
      $fieldList.find(".menu-item").first().addClass("active");
      loadFieldForm(mockData.fields[0]);
    }
  }

  /**
   * 渲染索引列表
   */
  function renderIndexList() {
    const $indexList = $("#index-list");
    $indexList.empty();

    mockData.indexes.forEach((index) => {
      $indexList.append(`
        <li class="menu-item" data-id="${index.id}" data-type="index">
          <i class="layui-icon layui-icon-template"></i> ${index.name}
        </li>
      `);
    });
  }

  /**
   * 加载字段表单
   */
  function loadFieldForm(field) {
    currentEditItem = field;
    currentEditType = "field";

    // 创建动态表单
    dynamicForm = new DynamicForm({
      container: "#formContainer",
      fieldMapping: fieldMapping,
      formId: "field-form",
      onSubmit: handleSaveField,
      onCancel: null, // 不需要取消按钮
    });

    dynamicForm.load(field);

    // 添加删除按钮
    addDeleteButton("删除字段", handleDeleteField);
  }

  /**
   * 加载索引表单
   */
  function loadIndexForm(index) {
    currentEditItem = index;
    currentEditType = "index";

    // 处理 fields 字段（数组转字符串）
    const indexData = { ...index };
    if (Array.isArray(indexData.fields)) {
      indexData.fields = indexData.fields.join(", ");
    }

    // 创建动态表单
    dynamicForm = new DynamicForm({
      container: "#formContainer",
      fieldMapping: indexMapping,
      formId: "index-form",
      onSubmit: handleSaveIndex,
      onCancel: null, // 不需要取消按钮
    });

    dynamicForm.load(indexData);

    // 添加删除按钮
    addDeleteButton("删除索引", handleDeleteIndex);
  }

  /**
   * 添加删除按钮
   */
  function addDeleteButton(text, handler) {
    // 使用 setTimeout 确保 DynamicForm 完全渲染后再添加按钮
    setTimeout(() => {
      const $buttonGroup = $("#formContainer .button-group");
      
      // 先移除已存在的删除按钮（如果有）
      $buttonGroup.find("#deleteBtn").remove();
      
      // 添加新的删除按钮
      $buttonGroup.append(`
        <button type="button" id="deleteBtn" class="layui-btn layui-btn-danger">
          <i class="layui-icon layui-icon-delete"></i> ${text}
        </button>
      `);

      // 绑定点击事件
      $("#deleteBtn").off("click").on("click", handler);
    }, 50); // 延迟 50ms 以确保表单已完全渲染
  }

  /**
   * 处理保存字段
   */
  function handleSaveField(data) {
    if (currentEditItem) {
      Object.assign(currentEditItem, data);
      renderFieldList();
      dynamicForm.showStatus("字段保存成功！", "success");

      // 通知 VSCode
        vscode.postMessage({
        command: "saveField",
        data: data,
        });
    }
  }

  /**
   * 处理保存索引
   */
  function handleSaveIndex(data) {
    // 处理字段列表（字符串转数组）
    if (typeof data.fields === "string") {
      data.fields = data.fields
        .split(",")
        .map((f) => f.trim())
        .filter((f) => f);
    }

    if (currentEditItem) {
      Object.assign(currentEditItem, data);
      renderIndexList();
      dynamicForm.showStatus("索引保存成功！", "success");

      // 通知 VSCode
      vscode.postMessage({
        command: "saveIndex",
        data: data,
      });
    }
  }

  /**
   * 处理删除字段
   */
  function handleDeleteField() {
    if (!currentEditItem) {
      return;
    }

    layer.confirm(
      '确定要删除字段 "' + currentEditItem.name + '" 吗？',
      {
        icon: 3,
        title: "确认删除",
      },
      function (index) {
        const idx = mockData.fields.findIndex(
          (f) => f.id === currentEditItem.id
        );
        if (idx !== -1) {
          mockData.fields.splice(idx, 1);
          renderFieldList();

          // 通知 VSCode
        vscode.postMessage({
            command: "deleteField",
            fieldId: currentEditItem.id,
          });
        }
        layer.close(index);
      }
    );
  }

  /**
   * 处理删除索引
   */
  function handleDeleteIndex() {
    if (!currentEditItem) {
      return;
    }

    layer.confirm(
      '确定要删除索引 "' + currentEditItem.name + '" 吗？',
      {
        icon: 3,
        title: "确认删除",
      },
      function (index) {
        const idx = mockData.indexes.findIndex(
          (i) => i.id === currentEditItem.id
        );
        if (idx !== -1) {
          mockData.indexes.splice(idx, 1);
          renderIndexList();

          // 通知 VSCode
          vscode.postMessage({
            command: "deleteIndex",
            indexId: currentEditItem.id,
        });
      }
        layer.close(index);
      }
    );
  }

  // 初始化列表
  renderFieldList();
  renderIndexList();

  // 菜单项点击事件（事件委托）
  $(document).on("click", ".menu-item", function () {
    const $this = $(this);
    const type = $this.data("type");
    const id = $this.data("id");

    // 更新选中状态
    $this.siblings().removeClass("active");
    $this.addClass("active");

    // 加载对应表单
    if (type === "field") {
      const field = mockData.fields.find((f) => f.id === id);
      if (field) {
        loadFieldForm(field);
      }
    } else if (type === "index") {
      const index = mockData.indexes.find((i) => i.id === id);
      if (index) {
        loadIndexForm(index);
      }
    }
  });

  // 监听 Tab 切换事件
  element.on("tab(edit-tabs)", function (data) {
    if (data.index === 0) {
      // 切换到字段标签
      if (mockData.fields.length > 0) {
        setTimeout(() => {
          $("#field-list .menu-item").first().trigger("click");
        }, 100);
      }
    } else if (data.index === 1) {
      // 切换到索引标签
      if (mockData.indexes.length > 0) {
        setTimeout(() => {
          $("#index-list .menu-item").first().trigger("click");
        }, 100);
      }
    }
  });

  // 监听来自 VSCode 的消息
  window.addEventListener("message", (event) => {
    const { command, data } = event.data;

    if (command === "load" || command === "loadData") {
      // 加载数据
      if (data && data.rowData) {
        // 从 DESC table 查询结果转换数据
        // rowData 格式：[{ Field, Type, Null, Key, Default, Extra }, ...]
        const fields = [];
        const indexes = [];
        const indexMap = {}; // 用于收集索引信息
        
        data.rowData.forEach((row, index) => {
          // 创建字段对象
          const field = {
            id: `field-${row.Field}`,
            name: row.Field,
            type: row.Type,
            length: null, // 可以从 Type 中解析，如 varchar(255)
            defaultValue: row.Default || "",
            nullable: row.Null === "YES",
            key: row.Key,
            extra: row.Extra || "",
            comment: row.Comment || "",
          };
          
          // 解析长度（如果有）
          const lengthMatch = row.Type.match(/\((\d+)\)/);
          if (lengthMatch) {
            field.length = parseInt(lengthMatch[1]);
            field.type = row.Type.replace(/\(\d+\)/, ""); // 移除长度，只保留类型名
          }
          
          fields.push(field);
          
          // 收集索引信息
          if (row.Key) {
            if (row.Key === "PRI") {
              if (!indexMap.PRIMARY) {
                indexMap.PRIMARY = {
                  id: "index-primary",
                  name: "PRIMARY",
                  type: "primary",
                  fields: [],
                  unique: true,
                };
              }
              indexMap.PRIMARY.fields.push(row.Field);
            } else if (row.Key === "UNI") {
              const indexName = `unique_${row.Field}`;
              indexMap[indexName] = {
                id: `index-${indexName}`,
                name: indexName,
                type: "unique",
                fields: [row.Field],
                unique: true,
              };
            } else if (row.Key === "MUL") {
              const indexName = `index_${row.Field}`;
              indexMap[indexName] = {
                id: `index-${indexName}`,
                name: indexName,
                type: "index",
                fields: [row.Field],
                unique: false,
              };
            }
          }
        });
        
        // 将索引映射转换为数组
        Object.keys(indexMap).forEach((key) => {
          const idx = indexMap[key];
          // 将字段数组转换为逗号分隔的字符串（用于显示）
          if (Array.isArray(idx.fields)) {
            idx.fieldsArray = idx.fields;
            idx.fields = idx.fields.join(", ");
          }
          indexes.push(idx);
        });
        
        mockData.fields = fields;
        mockData.indexes = indexes;
      } else if (data && data.fields) {
        // 兼容旧格式
        mockData.fields = data.fields;
      }
      
      if (data && data.indexes) {
        mockData.indexes = data.indexes;
      }

      renderFieldList();
      renderIndexList();
    } else if (command === "status") {
      const statusMsg = data.message || "操作完成";
      const statusType = data.success ? '成功' : '失败';
      if (dynamicForm) {
        dynamicForm.showStatus(statusMsg, data.success ? "success" : "error");
      }
    }
  });
});
