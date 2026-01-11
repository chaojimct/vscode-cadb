/**
 * Result 页面 - SQL查询结果展示
 * 使用 Layui Tabs 标准 API 展示多个查询结果
 */

layui.use(["tabs", "layer"], function () {
  const tabs = layui.tabs;
  const layer = layui.layer;
  const $ = layui.$;

  // 获取 VSCode API
  let vscode = null;
  if (window.vscode) {
    vscode = window.vscode;
  } else {
    vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
  }

  // Tabs 实例 ID
  const TABS_ID = "results";

  // 当前右键菜单的标签
  let contextMenuTabId = null;

  /**
   * 初始化 Tabs
   */
  function initTabs() {
    // 注意：不需要手动调用 tabs.render()
    // Layui 会根据 HTML 中的 lay-options 自动渲染
    
    // 初始化自定义右键菜单
    initContextMenu();
    
    // 为已存在的标签（欢迎页）绑定右键菜单
    setTimeout(() => {
      $(`#${TABS_ID} .layui-tabs-header>li`).each(function() {
        const $tab = $(this);
        $tab.off("contextmenu").on("contextmenu", function (e) {
          e.preventDefault();
          const layId = $(this).attr("lay-id");
          showContextMenu(layId, e.clientX, e.clientY);
        });
      });
    }, 100);
  }

  /**
   * 初始化自定义右键菜单
   */
  function initContextMenu() {
    const $body = $("body");

    // 创建右键菜单 HTML
    const menuHtml = `
      <div class="tab-context-menu" id="tabContextMenu">
        <div class="tab-context-menu-item" data-action="pin">
          <i class="layui-icon layui-icon-rate"></i>
          <span class="menu-text">固定</span>
        </div>
        <div class="tab-context-menu-separator"></div>
        <div class="tab-context-menu-item" data-action="close">
          <i class="layui-icon layui-icon-close"></i>
          <span>关闭当前结果</span>
        </div>
        <div class="tab-context-menu-item" data-action="close-left">
          <i class="layui-icon layui-icon-left"></i>
          <span>关闭左侧结果</span>
        </div>
        <div class="tab-context-menu-item" data-action="close-right">
          <i class="layui-icon layui-icon-right"></i>
          <span>关闭右侧结果</span>
        </div>
        <div class="tab-context-menu-separator"></div>
        <div class="tab-context-menu-item" data-action="close-all">
          <i class="layui-icon layui-icon-close-fill"></i>
          <span>关闭全部结果</span>
        </div>
      </div>
    `;

    $body.append(menuHtml);

    const $menu = $("#tabContextMenu");

    // 点击菜单项
    $menu.on("click", ".tab-context-menu-item:not(.disabled)", function (e) {
      e.stopPropagation();
      const action = $(this).data("action");
      handleContextMenuAction(action);
      hideContextMenu();
    });

    // 点击页面其他地方隐藏菜单
    $(document).on("click", function () {
      hideContextMenu();
    });

    // 阻止菜单自身的右键
    $menu.on("contextmenu", function (e) {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  /**
   * 显示右键菜单
   */
  function showContextMenu(tabId, x, y) {
    contextMenuTabId = tabId;
    const $menu = $("#tabContextMenu");
    const $tab = $(`#${TABS_ID} .layui-tabs-header>li[lay-id="${tabId}"]`);
    const $allTabs = $(`#${TABS_ID} .layui-tabs-header>li`);
    const isPinned = $tab.hasClass("tab-pinned");
    const currentIndex = $allTabs.index($tab);

    // 更新固定按钮文本和图标
    const $pinItem = $menu.find('[data-action="pin"]');
    if (isPinned) {
      $pinItem.find(".menu-text").text("取消固定");
      $pinItem
        .find(".layui-icon")
        .removeClass("layui-icon-rate")
        .addClass("layui-icon-rate-solid");
    } else {
      $pinItem.find(".menu-text").text("固定");
      $pinItem
        .find(".layui-icon")
        .removeClass("layui-icon-rate-solid")
        .addClass("layui-icon-rate");
    }

    // 检查是否可以关闭
    $menu.find('[data-action="close"]').toggleClass("disabled", isPinned);

    // 检查是否有左侧/右侧标签
    const hasLeft = currentIndex > 0;
    const hasRight = currentIndex < $allTabs.length - 1;
    $menu.find('[data-action="close-left"]').toggleClass("disabled", !hasLeft);
    $menu
      .find('[data-action="close-right"]')
      .toggleClass("disabled", !hasRight);

    // 检查是否有可关闭的标签
    const hasClosable = $allTabs.filter(":not(.tab-pinned)").length > 0;
    $menu
      .find('[data-action="close-all"]')
      .toggleClass("disabled", !hasClosable);

    // 定位菜单
    $menu
      .css({
        left: x + "px",
        top: y + "px",
      })
      .addClass("show");

    // 确保菜单不超出屏幕
    const menuWidth = $menu.outerWidth();
    const menuHeight = $menu.outerHeight();
    const windowWidth = $(window).width();
    const windowHeight = $(window).height();

    if (x + menuWidth > windowWidth) {
      $menu.css("left", windowWidth - menuWidth - 5 + "px");
    }
    if (y + menuHeight > windowHeight) {
      $menu.css("top", windowHeight - menuHeight - 5 + "px");
    }
  }

  /**
   * 隐藏右键菜单
   */
  function hideContextMenu() {
    $("#tabContextMenu").removeClass("show");
    contextMenuTabId = null;
  }

  /**
   * 处理右键菜单操作
   */
  function handleContextMenuAction(action) {
    if (!contextMenuTabId) {
			return;
		}

    const tabId = contextMenuTabId;
    const $tab = $(`#${TABS_ID} .layui-tabs-header>li[lay-id="${tabId}"]`);
    const $allTabs = $(`#${TABS_ID} .layui-tabs-header>li`);
    const isPinned = $tab.hasClass("tab-pinned");
    const currentIndex = $allTabs.index($tab);

    switch (action) {
      case "pin":
        // 切换固定状态
        $tab.toggleClass("tab-pinned");
        const newPinned = $tab.hasClass("tab-pinned");

        // 参考官方文档，使用 lay-closable 属性控制关闭按钮
        if (newPinned) {
          // 固定：设置为不可关闭
          $tab.attr('lay-closable', 'false');
          $tab.find(".layui-tabs-close, .layui-tab-close").remove();
        } else {
          // 取消固定：移除属性并添加关闭按钮
          $tab.removeAttr('lay-closable');
          // 使用统一的方法添加关闭按钮并绑定事件
          addCloseButton($tab, tabId);
        }
        break;

      case "close":
        if (!isPinned) {
          tabs.close(TABS_ID, tabId);
        }
        break;

      case "close-left":
        closeTabsByDirection("left", currentIndex);
        break;

      case "close-right":
        closeTabsByDirection("right", currentIndex);
        break;

      case "close-all":
        closeAllUnpinnedTabs(true); // 显示提示消息
        break;
    }
  }

  /**
   * 根据方向关闭标签
   */
  function closeTabsByDirection(direction, currentIndex) {
    const $allTabs = $(`#${TABS_ID} .layui-tabs-header>li`);
    let closedCount = 0;

    // 收集要关闭的标签ID
    const toClose = [];
    $allTabs.each(function (index) {
      const $tab = $(this);
      const shouldClose =
        direction === "left" ? index < currentIndex : index > currentIndex;

      if (shouldClose && !$tab.hasClass("tab-pinned")) {
        toClose.push($tab.attr("lay-id"));
      }
    });

    // 关闭收集的标签
    toClose.forEach(function (tabId) {
      tabs.close(TABS_ID, tabId);
      closedCount++;
    });
  }

  /**
   * 关闭所有未固定的标签
   * @param {boolean} showMessage - 是否显示提示消息（默认false）
   */
  function closeAllUnpinnedTabs(showMessage = false) {
    const $allTabs = $(`#${TABS_ID} .layui-tabs-header>li`);
    let closedCount = 0;
    // 收集要关闭的标签ID
    const toClose = [];
    $allTabs.each(function () {
      const $tab = $(this);
      const tabId = $tab.attr("lay-id");
      const isPinned = $tab.hasClass("tab-pinned");
      if (!isPinned) {
        toClose.push(tabId);
      }
    });
    // 关闭收集的标签
    toClose.forEach(function (tabId) {
      tabs.close(TABS_ID, tabId);
      closedCount++;
    });
  }

  /**
   * 添加新的结果标签页
   * @param {Object} options - 标签页配置
   * @param {string} options.id - 标签页ID
   * @param {string} options.title - 标签页标题
   * @param {string} options.content - 标签页内容
   * @param {string} options.icon - 图标（可选）
   * @param {boolean} options.closable - 是否可关闭（默认true）
   * @param {boolean} options.pinned - 是否固定（默认false）
   */
  function addResultTab(options) {
    const {
      id,
      title,
      content,
      icon,
      closable = true,
      pinned = false,
    } = options;
    const tabId = id || `tab-${Date.now()}`;
    
    // 使用 Layui 标准 API 添加标签
    // 参考官方文档：https://layui.dev/docs/2/tabs/#add
    tabs.add(TABS_ID, {
      id: tabId,
      title: icon ? `<i class="layui-icon">${icon}</i> ${title}` : title,
      content: content,
      done: function (data) {
        // 标签添加完成后的回调
        const $headerItem = data.headerItem;
        // 如果不可关闭，设置 lay-closable="false" 属性（参考官方示例）
        if (!closable) {
          $headerItem.attr('lay-closable', 'false');
          // 移除关闭按钮
          $headerItem.find(".layui-tabs-close, .layui-tab-close").remove();
        } else {
          // 可关闭标签：手动添加关闭按钮并绑定事件
          addCloseButton($headerItem, tabId);
        }

        // 如果是固定标签，添加固定样式
        if (pinned) {
          $headerItem.addClass("tab-pinned");
        }

        // 为新标签绑定右键菜单事件
        $headerItem.on("contextmenu", function (e) {
          e.preventDefault();
          const layId = $(this).attr("lay-id");
          showContextMenu(layId, e.clientX, e.clientY);
        });

        // 显示 tabs 容器
        $(`#${TABS_ID}`).removeClass("layui-hide-v");
      },
    });
  }

  /**
   * 为标签添加关闭按钮并绑定点击事件
   * @param {jQuery} $headerItem - 标签头部元素
   * @param {string} tabId - 标签ID
   */
  function addCloseButton($headerItem, tabId) {
    // 检查是否已存在关闭按钮
    if ($headerItem.find(".layui-tabs-close").length > 0) {
      return;
    }

    // 创建关闭按钮
    const $close = $('<i class="layui-tabs-close layui-icon layui-icon-close"></i>');
    
    // 绑定点击事件
    $close.on('click', function(e) {
      e.stopPropagation(); // 阻止事件冒泡
      tabs.close(TABS_ID, tabId);
    });
    // 添加到标签头部
    $headerItem.append($close);
  }

  /**
   * 关闭标签页
   * @param {string} tabId - 标签页ID
   */
  function closeTab(tabId) {
    const $tab = $(`#${TABS_ID} .layui-tabs-header>li[lay-id="${tabId}"]`);

    // 检查是否固定
    if ($tab.hasClass("tab-pinned")) {
      return;
    }

    // 使用 Layui 标准 API 关闭标签
    tabs.close(TABS_ID, tabId);

    // 如果没有标签了，隐藏容器
    const $allTabs = $(`#${TABS_ID} .layui-tabs-header>li`);
    if ($allTabs.length === 0) {
      $(`#${TABS_ID}`).addClass("layui-hide-v");
    }
  }

  /**
   * 关闭所有标签页
   */
  function closeAllTabs() {
    closeAllUnpinnedTabs(true); // 显示提示消息
  }

  /**
   * 创建表格内容（使用 Tabulator）
   * @param {Array} columns - 列定义
   * @param {Array} data - 数据
   * @param {string} tabId - 标签ID
   * @returns {string} HTML内容
   */
  function createTableContent(columns, data, tabId) {
    if (!data || data.length === 0) {
      return `
        <div class="empty-state">
          <i class="layui-icon layui-icon-face-surprised"></i>
          <p>暂无数据</p>
        </div>
      `;
    }

    // 创建 Tabulator 容器
    const containerId = `tabulator-${tabId}`;
    const html = `<div id="${containerId}" class="tabulator-container"></div>`;

    // 延迟初始化 Tabulator（等待 DOM 渲染）
    setTimeout(() => {
      initTabulator(containerId, columns, data);
    }, 100);

    return html;
  }

  /**
   * 初始化 Tabulator 表格
   */
  function initTabulator(containerId, columns, data) {
    const container = document.getElementById(containerId);
    if (!container) {
      console.error("容器不存在:", containerId);
      return;
    }

    // 转换列定义为 Tabulator 格式
    const tabulatorColumns = columns.map((col) => ({
      title: col.field.toUpperCase(),
      field: col.field,
      headerSort: true,
      resizable: true,
      minWidth: 100,
    }));

    // 创建 Tabulator 实例
    new Tabulator(`#${containerId}`, {
      height: "100%",
      layout: "fitColumns",
      columns: tabulatorColumns,
      data: data,
      selectable: true,
      headerSort: true,
      resizableColumns: true,
      placeholder: "暂无数据",
      renderVertical: "basic",
      movableColumns: true,
      tooltips: true,
      clipboard: true,
      clipboardCopyStyled: false,
      clipboardCopyConfig: {
        columnHeaders: true,
        rowGroups: false,
        columnCalcs: false,
      },
    });
  }

  /**
   * 创建消息内容
   * @param {string} message - 消息文本
   * @param {string} type - 消息类型（success/error/info）
   * @returns {string} HTML内容
   */
  function createMessageContent(message, type = "info") {
    const icons = {
      success: "layui-icon-ok-circle",
      error: "layui-icon-close-fill",
      info: "layui-icon-tips",
    };

    const colors = {
      success: "#89d185",
      error: "#f48771",
      info: "#4fc3f7",
    };

    return `
      <div class="layui-card-body" style="display: flex; align-items: center; justify-content: center; min-height: 200px;">
        <div style="text-align: center;">
          <i class="layui-icon ${icons[type]}" style="font-size: 48px; color: ${colors[type]}; margin-bottom: 16px;"></i>
          <p style="font-size: 14px; color: var(--vscode-fg);">${message}</p>
        </div>
      </div>
    `;
  }

  // 监听来自 VSCode 的消息
  window.addEventListener("message", (event) => {
    const message = event.data;

    if (!message || !message.command) {
      return;
    }

    switch (message.command) {
      case "showResult": {
        // 1. 先删除所有未固定的标签
        closeAllUnpinnedTabs();

        // 2. 然后添加新的查询结果标签
        const { title, columns, data, id, pinned } = message;
        const tabId = id || `result-${Date.now()}`;
        const content = createTableContent(columns, data, tabId);

        addResultTab({
          id: tabId,
          title: title || "查询",
          content: content,
          icon: "&#xe65b;",
          pinned: pinned || false,
          closable: true, // 确保可以关闭
        });
        break;
      }
      case "showMessage": {
        // 1. 先删除所有未固定的标签
        closeAllUnpinnedTabs();

        // 2. 然后添加新的消息标签
        const { title, text, type, id, pinned } = message;
        const content = createMessageContent(text, type || "info");

        addResultTab({
          id: id || `message-${Date.now()}`,
          title: title || "消息",
          content: content,
          icon: type === "error" ? "&#xe69c;" : "&#xe65b;",
          pinned: pinned || false,
          closable: true, // 确保可以关闭
        });
        break;
      }
      case "closeTab": {
        // 关闭指定标签
        closeTab(message.id);
        break;
      }
      case "closeAllTabs": {
        // 关闭所有标签
        closeAllTabs();
        break;
      }
      case "clear": {
        // 清空所有结果
        closeAllTabs();
        break;
      }
    }
  });

  // 初始化
  initTabs();

  // 通知 VSCode 页面已准备好
  if (vscode) {
    vscode.postMessage({
      command: "ready",
    });
  }
});
