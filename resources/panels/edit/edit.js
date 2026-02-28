/**
 * Edit 页面 - 数据库结构编辑视图
 * 用于对数据库、表、字段、索引等进行结构修改
 * 使用动态表单工具类
 */

// VSCode API
const vscode = window.vscode || (typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null);

// 数据容器，初始为空，由 VSCode 通过 load 事件填充
const mockData = {
  fields: [],
  indexes: [],
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

  layui.use(["element", "form", "layer"], function () {
  const element = layui.element;
  const layer = layui.layer;

  // 设置左侧列表滚动区高度，确保纵向滚动可用
  function updateListScrollHeight() {
    const panel = document.querySelector(".left-panel");
    const tabs = document.querySelector(".layui-tab-title");
    const addBtn = document.querySelector(".tab-pane-inner .layui-btn");
    const scrollEls = document.querySelectorAll(".list-scroll");
    if (!panel || !scrollEls.length) return;
    const panelH = panel.getBoundingClientRect().height;
    const tabsH = tabs ? tabs.getBoundingClientRect().height : 40;
    const addBtnH = addBtn ? addBtn.getBoundingClientRect().height + 16 : 48;
    const scrollH = Math.max(80, panelH - tabsH - addBtnH);
    scrollEls.forEach(function (el) {
      el.style.height = scrollH + "px";
    });
  }
  function scheduleUpdateScroll() {
    requestAnimationFrame(updateListScrollHeight);
  }
  updateListScrollHeight();
  setTimeout(updateListScrollHeight, 100);
  window.addEventListener("resize", scheduleUpdateScroll);
  if (typeof ResizeObserver !== "undefined") {
    const panel = document.querySelector(".left-panel");
    if (panel) new ResizeObserver(scheduleUpdateScroll).observe(panel);
  }

  /**
   * 渲染字段列表
   */
  function renderFieldList() {
    const $fieldList = $("#field-list");
    $fieldList.empty();

    mockData.fields.forEach((field, index) => {
      // 根据字段类型显示不同的图标和标记
      let icon = "layui-icon-cols";
      let badge = "";
      
      if (field.key === "PRI") {
        icon = "layui-icon-key";
        badge = '<span class="menu-item-badge" style="color:#FFB800">[PK]</span>';
      } else if (field.key === "UNI") {
        badge = '<span class="menu-item-badge" style="color:#1E9FFF">[UNI]</span>';
      } else if (field.key === "MUL") {
        badge = '<span class="menu-item-badge" style="color:#5FB878">[IDX]</span>';
      }
      
      const isFirst = index === 0;
      const isLast = index === mockData.fields.length - 1;

      $fieldList.append(`
        <li class="menu-item" data-id="${field.id}" data-type="field">
          <div class="menu-item-content">
            <i class="layui-icon ${icon}"></i> ${field.name}${badge}
          </div>
          <div class="menu-item-actions">
            ${!isFirst ? '<i class="layui-icon layui-icon-up menu-item-action menu-item-up" title="上移"></i>' : ''}
            ${!isLast ? '<i class="layui-icon layui-icon-down menu-item-action menu-item-down" title="下移"></i>' : ''}
            <i class="layui-icon layui-icon-delete menu-item-action menu-item-delete" title="删除字段"></i>
          </div>
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

    mockData.indexes.forEach((idx) => {
      $indexList.append(`
        <li class="menu-item" data-id="${idx.id}" data-type="index">
          <div class="menu-item-content">
            <i class="layui-icon layui-icon-template"></i> ${idx.name}
          </div>
          <div class="menu-item-actions">
            <i class="layui-icon layui-icon-delete menu-item-action menu-item-delete" title="删除索引"></i>
          </div>
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

    // 创建动态表单（扁平布局，不显示基础/高级设置标题）
    dynamicForm = new DynamicForm({
      container: "#formContainer",
      fieldMapping: fieldMapping,
      formId: "field-form",
      onSubmit: handleSaveField,
      onCancel: null,
      flatLayout: true,
    });

    dynamicForm.load(field);
  }

  /**
   * 加载索引表单
   */
  function loadIndexForm(index) {
    currentEditItem = index;
    currentEditType = "index";

    // 更新字段选项
    if (mockData.fields && mockData.fields.length > 0) {
      indexMapping.fields.options = mockData.fields.map(f => ({
        value: f.name,
        label: f.name
      }));
    }

    // 处理 fields 字段（数组转字符串）
    const indexData = { ...index };
    if (Array.isArray(indexData.fields)) {
      indexData.fields = indexData.fields.join(",");
    } else if (typeof indexData.fields === 'string') {
      // 确保没有空格
      indexData.fields = indexData.fields.replace(/,\s+/g, ',');
    }

    // 创建动态表单（扁平布局，不显示基础/高级设置标题）
    dynamicForm = new DynamicForm({
      container: "#formContainer",
      fieldMapping: indexMapping,
      formId: "index-form",
      onSubmit: handleSaveIndex,
      onCancel: null,
      flatLayout: true,
    });

    dynamicForm.load(indexData);
  }

  /**
   * 处理保存字段
   */
  function handleSaveField(data) {
    if (currentEditItem) {
      const originalName = currentEditItem.name;
      const isNew = String(currentEditItem.id || "").startsWith("field-new-");
      Object.assign(currentEditItem, data);
      renderFieldList();
      dynamicForm.showStatus("保存中...", "success");

      // 通知 VSCode 执行数据库 ALTER
      vscode.postMessage({
        command: "saveField",
        data: data,
        originalName: originalName,
        isNew: isNew,
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

    // ==================== 校验逻辑 ====================
    
    // 1. 主键必须是唯一索引
    if (data.type === "primary") {
      data.unique = true;
      
      // 检查是否已有其他主键
      const otherPrimary = mockData.indexes.find(i => 
        i.id !== currentEditItem.id && i.type === "primary"
      );
      if (otherPrimary) {
        layer.msg("表中只能有一个主键", { icon: 5 });
        return;
      }
    }

    // 2. 唯一索引字段组合不能重复
    // 检查范围：唯一索引(unique=true) 和 主键
    // 注意：表单可能返回字符串 "true"/"false" 或布尔值
    const isCurrentUnique = data.unique === true || String(data.unique) === "true" || data.type === "unique" || data.type === "primary";
    
    if (isCurrentUnique) {
      const currentFields = [...data.fields].sort().join(",");
      
      const duplicate = mockData.indexes.find(i => {
        if (i.id === currentEditItem.id) {
					return false;
				}
        
        // 检查目标是否是唯一索引/主键
        const isTargetUnique = i.unique === true || String(i.unique) === "true" || i.type === "unique" || i.type === "primary";
        if (!isTargetUnique) {
					return false;
				}
        
        // 获取目标字段列表
        let otherFields = i.fields;
        if (typeof otherFields === "string") {
          otherFields = otherFields.split(",").map(f => f.trim()).filter(f => f);
        } else if (!Array.isArray(otherFields)) {
          otherFields = [];
        }
        
        const otherFieldsStr = [...otherFields].sort().join(",");
        return currentFields === otherFieldsStr;
      });

      if (duplicate) {
        layer.msg("唯一索引字段组合不能重复", { icon: 5 });
        return;
      }
    }
    // ==================== 校验结束 ====================

    if (currentEditItem) {
      const originalName = currentEditItem.name;
      const isNew = String(currentEditItem.id || "").startsWith("index-new-");
      Object.assign(currentEditItem, data);
      renderIndexList();
      dynamicForm.showStatus("保存中...", "success");

      // 通知 VSCode 执行数据库 ALTER
      vscode.postMessage({
        command: "saveIndex",
        data: data,
        originalName: originalName,
        isNew: isNew,
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

    const fieldName = currentEditItem.name;
    layer.confirm(
      '确定要删除字段 "' + fieldName + '" 吗？',
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

          // 通知 VSCode 执行数据库 DROP COLUMN
          vscode.postMessage({
            command: "deleteField",
            fieldName: fieldName,
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
    if (!vscode) {
      layer.msg("无法与编辑器通信", { icon: 5 });
      return;
    }

    const indexName = currentEditItem.name;
    layer.confirm(
      '确定要删除索引 "' + indexName + '" 吗？',
      {
        icon: 3,
        title: "确认删除",
      },
      function (confirmIdx) {
        const idx = mockData.indexes.findIndex(
          (i) => i.id === currentEditItem.id
        );
        if (idx !== -1) {
          mockData.indexes.splice(idx, 1);
          renderIndexList();

          // 通知 VSCode 执行数据库 DROP INDEX
          vscode.postMessage({
            command: "deleteIndex",
            indexName: indexName,
          });
        }
        layer.close(confirmIdx);
      }
    );
  }

  // 初始化列表
  renderFieldList();
  renderIndexList();

  // 菜单项点击事件（事件委托）
  $(document).on("click", ".menu-item", function (e) {
    // 如果点击的是删除按钮，不触发选中
    if ($(e.target).hasClass("menu-item-delete")) {
      return;
    }

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

  // 删除按钮点击事件（事件委托）
  $(document).on("click", ".menu-item-delete", function (e) {
    e.stopPropagation(); // 阻止冒泡
    const $item = $(this).closest(".menu-item");
    const type = $item.data("type");
    const id = $item.data("id");

    if (type === "field") {
      const field = mockData.fields.find((f) => f.id === id);
      if (field) {
        currentEditItem = field;
        handleDeleteField();
      }
    } else if (type === "index") {
      const index = mockData.indexes.find((i) => i.id === id);
      if (index) {
        currentEditItem = index;
        handleDeleteIndex();
      }
    }
  });

  // 添加按钮
  $(document).on("click", "#add-field-btn", function () {
    const newField = {
      id: "field-new-" + Date.now(),
      name: "new_column",
      type: "varchar",
      length: 255,
      defaultValue: "",
      nullable: true,
      key: "",
      extra: "",
      comment: "",
    };
    mockData.fields.push(newField);
    renderFieldList();
    // 选中新添加的字段
    const $newItem = $(`#field-list .menu-item[data-id="${newField.id}"]`);
    $newItem.trigger("click");
    if ($newItem[0]) $newItem[0].scrollIntoView({ behavior: "smooth", block: "center" });
  });

  $(document).on("click", "#add-index-btn", function () {
    const newIndex = {
      id: "index-new-" + Date.now(),
      name: "new_index",
      type: "index",
      fields: [],
      unique: false,
    };
    mockData.indexes.push(newIndex);
    renderIndexList();
    // 选中新添加的索引
    const $newItem = $(`#index-list .menu-item[data-id="${newIndex.id}"]`);
    $newItem.trigger("click");
    if ($newItem[0]) $newItem[0].scrollIntoView({ behavior: "smooth", block: "center" });
  });

  // Layui Tab 切换
  element.on("tab(edit-tabs)", function (data) {
    scheduleUpdateScroll();
    if (data.index === 0 && mockData.fields.length > 0) {
      setTimeout(function () {
        $("#field-list .menu-item").first().trigger("click");
      }, 50);
    } else if (data.index === 1 && mockData.indexes.length > 0) {
      setTimeout(function () {
        $("#index-list .menu-item").first().trigger("click");
      }, 50);
    }
  });

  // 页面加载完成时向 VSCode 请求加载表字段和索引数据
  if (vscode) {
    vscode.postMessage({ command: "ready" });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && vscode) {
      vscode.postMessage({ command: "ready" });
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
            idx.fields = idx.fields.join(",");
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
      scheduleUpdateScroll();
    } else if (command === "status") {
      const statusMsg = data.message || "操作完成";
      const statusType = data.success ? '成功' : '失败';
      if (dynamicForm) {
        dynamicForm.showStatus(statusMsg, data.success ? "success" : "error");
      }
    }
  });
});
