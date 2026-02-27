# VSCode CADB 页面文件说明

## 📁 当前页面结构

### 核心页面（4个）

#### 1. **settings.html** - 统一配置管理页面 ⚙️
- **用途**: 所有配置类型的统一入口
- **支持的配置类型**:
  - `datasource`: 数据库连接配置（MySQL, PostgreSQL, SQLite, SQL Server）
  - `user`: 数据库用户管理（权限、SSL、连接限制等）
- **相关文件**:
  - `settings/settings.js` - 配置逻辑，根据 configType 动态切换
  - `settings/settings.css` - 配置页面样式
- **使用场景**:
  - 添加/编辑数据库连接
  - 管理数据库用户

#### 2. **edit.html** - 表结构编辑页面 ✏️
- **用途**: 编辑数据库表结构（字段、索引）
- **特点**: 左右分栏布局，左侧列表，右侧动态表单
- **相关文件**:
  - `edit/edit.js` - 编辑逻辑，使用动态表单
  - `edit/edit.css` - 分栏布局样式
- **使用场景**:
  - 编辑表字段（名称、类型、长度、默认值等）
  - 编辑表索引（名称、类型、字段、唯一约束等）

#### 3. **grid.html** - 数据表格页面 📊
- **用途**: 显示和编辑数据库表数据
- **特点**: 使用 AG Grid Community 实现高性能数据表格
- **相关文件**:
  - `grid/grid.js` - 表格逻辑
  - `grid/grid.css` - 表格样式
- **使用场景**:
  - 查看表数据
  - 编辑表数据
  - 数据排序、筛选

#### 4. **result.html** - SQL 查询结果页面 📈
- **用途**: 显示 SQL 查询结果
- **特点**: 
  - 多标签页管理（使用 Layui tabs）
  - 支持固定标签页
  - 右键菜单（固定、关闭等操作）
- **相关文件**:
  - `result/result.js` - 结果显示逻辑
  - `result/result.css` - 结果页面样式
- **使用场景**:
  - 显示 SELECT 查询结果
  - 显示 SQL 执行结果
  - 多查询结果管理

### 公共资源

#### **common/** - 公共工具和样式 🛠️
- **form.js** - 动态表单核心类
  - 根据数据和映射自动生成表单
  - 支持 7 种字段类型
  - 自动分类（base/advance）与折叠
  - 响应式布局
  
- **form.css** - 通用表单样式
  - VSCode 主题适配
  - Layui 组件样式覆盖
  - 响应式设计

- **table.js** - 表格工具类
  - AG Grid Community 封装（Grid / Items 面板）

- **table.css** - 表格样式

- **README.md** - 动态表单使用文档

#### **favicon.ico** - 扩展图标

## 🗑️ 已删除的页面

以下页面已被统一的 `settings.html` 替代：

- ❌ `config.html` + `config/config.js` → 数据库连接配置
- ❌ `user.html` + `user/user.js` + `user/user.css` → 用户管理配置

## 📊 页面使用统计

| 页面 | 用途 | 使用频率 | 依赖 |
|------|------|----------|------|
| settings.html | 配置管理 | 高 | common/form.js |
| edit.html | 表结构编辑 | 中 | common/form.js |
| grid.html | 数据表格 | 高 | common/table.js |
| result.html | 查询结果 | 高 | common/table.js |

## 🔧 技术栈

- **UI 框架**: Layui
- **表格**: AG Grid Community（Grid/Items）、Tabulator.js（Result 查询结果）
- **样式**: VSCode 主题变量
- **脚本**: jQuery + 原生 JavaScript

## 📝 开发规范

### 添加新页面

1. 在 `resources/panels/` 创建 HTML 文件
2. 在对应的子目录创建 JS 和 CSS 文件
3. 在 `database_provider.ts` 的 `panels` 对象中注册
4. 优先考虑使用 `common/form.js` 动态表单

### 修改现有页面

1. 检查是否影响其他页面
2. 保持 VSCode 主题适配
3. 确保响应式设计
4. 更新相关文档

## 🎯 设计原则

1. **统一性**: 所有页面使用统一的样式和交互模式
2. **复用性**: 公共功能提取到 common/ 目录
3. **主题适配**: 所有样式使用 VSCode 主题变量
4. **响应式**: 支持各种屏幕尺寸
5. **性能**: 最小化页面文件数量和大小

## 🚀 未来扩展

如需添加新的配置类型，建议：

1. **优先考虑**: 在 `settings.html` 中添加新的配置类型
2. **独立页面**: 仅在交互模式完全不同时创建新页面
3. **使用动态表单**: 利用 `common/form.js` 快速实现

## 📖 相关文档

- [动态表单使用说明](common/README.md)
- [VSCode 扩展开发文档](https://code.visualstudio.com/api)
- [Layui 官方文档](https://layui.dev)
- [AG Grid 官方文档](https://ag-grid.com)
- [Tabulator 官方文档](http://tabulator.info)

