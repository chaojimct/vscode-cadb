/**
 * 全局字段映射配置
 * 定义所有表单字段的类型、标签、验证规则等
 */

(function () {
  "use strict";

  // ==================== 数据库连接配置字段 ====================

  const datasourceFieldMapping = {
    // 隐藏字段
    type: {
      type: "hidden",
			value: "datasource"
    },
    // 基础字段
    dbType: {
      type: "select",
      label: "数据库类型",
      category: "base",
      required: true,
      options: [
        { value: "mysql", label: "MySQL" },
        { value: "redis", label: "Redis" },
      ],
    },
    name: {
      type: "text",
      label: "连接名称",
      category: "base",
      required: true,
      placeholder: "例如：生产数据库",
      hint: "给此连接起一个易于识别的名称",
    },
    host: {
      type: "text",
      label: "主机地址",
      category: "base",
      placeholder: "localhost 或 IP 地址",
    },
    port: {
      type: "number",
      label: "端口",
      category: "base",
      placeholder: "3306",
      default: "dbType == 'mysql' ? 3306 : (dbType == 'redis' ? 6379 : 5432)",
      min: 1,
      max: 65535,
      hidden: "dbType == 'sqlite'", // 当数据库类型是 sqlite 时隐藏（hidden 优先级高于 show）
    },
    username: {
      type: "text",
      label: "用户名",
      category: "base",
      placeholder: "数据库用户名",
      show: "dbType != 'redis'", // 当数据库类型不是 redis 时显示
    },
    password: {
      type: "password",
      label: "密码",
      category: "base",
      placeholder: "数据库密码",
    },
    database: {
      type: "text",
      label: "数据库名",
      category: "base",
      placeholder: "数据库名称",
      hint: "要连接的数据库名称（可选）",
      show: "dbType != 'redis'", // 当数据库类型不是 redis 时显示
    },

    // SQLite 专用字段
    sqlitePath: {
      type: "text",
      label: "文件路径",
      category: "base",
      placeholder: "/path/to/database.db",
      hint: "SQLite 数据库文件的完整路径",
      show: "dbType == 'sqlite'", // 当数据库类型是 sqlite 时显示
      // 也可以使用 hidden: "dbType != 'sqlite'" 实现相同效果
    },

    // 高级字段
    charset: {
      type: "select",
      label: "字符集",
      category: "advance",
      options: [
        { value: "utf8mb4", label: "utf8mb4" },
        { value: "utf8", label: "utf8" },
        { value: "latin1", label: "latin1" },
        { value: "gbk", label: "gbk" },
      ],
    },
    timezone: {
      type: "text",
      label: "时区",
      category: "advance",
      placeholder: "+08:00",
    },
    connectTimeout: {
      type: "number",
      label: "连接超时(ms)",
      category: "advance",
      placeholder: "10000",
      min: 0,
    },
  };

  // ==================== 用户管理配置字段 ====================

  // 所有权限字段列表
  const privilegeFields = [
    "Select_priv",
    "Insert_priv",
    "Update_priv",
    "Delete_priv",
    "Create_priv",
    "Drop_priv",
    "Reload_priv",
    "Shutdown_priv",
    "Process_priv",
    "File_priv",
    "Grant_priv",
    "References_priv",
    "Index_priv",
    "Alter_priv",
    "Show_db_priv",
    "Super_priv",
    "Create_tmp_table_priv",
    "Lock_tables_priv",
    "Execute_priv",
    "Repl_slave_priv",
    "Repl_client_priv",
    "Create_view_priv",
    "Show_view_priv",
    "Create_routine_priv",
    "Alter_routine_priv",
    "Create_user_priv",
    "Event_priv",
    "Trigger_priv",
    "Create_tablespace_priv",
    "Create_role_priv",
    "Drop_role_priv",
  ];

  // 权限字段的中文名称映射
  const privilegeLabels = {
    Select_priv: "SELECT",
    Insert_priv: "INSERT",
    Update_priv: "UPDATE",
    Delete_priv: "DELETE",
    Create_priv: "CREATE",
    Drop_priv: "DROP",
    Index_priv: "INDEX",
    Alter_priv: "ALTER",
    Reload_priv: "RELOAD",
    Shutdown_priv: "SHUTDOWN",
    Process_priv: "PROCESS",
    File_priv: "FILE",
    Grant_priv: "GRANT",
    References_priv: "REFERENCES",
    Show_db_priv: "SHOW DATABASES",
    Super_priv: "SUPER",
    Create_tmp_table_priv: "CREATE TEMP TABLES",
    Lock_tables_priv: "LOCK TABLES",
    Execute_priv: "EXECUTE",
    Repl_slave_priv: "REPLICATION SLAVE",
    Repl_client_priv: "REPLICATION CLIENT",
    Create_view_priv: "CREATE VIEW",
    Show_view_priv: "SHOW VIEW",
    Create_routine_priv: "CREATE ROUTINE",
    Alter_routine_priv: "ALTER ROUTINE",
    Create_user_priv: "CREATE USER",
    Event_priv: "EVENT",
    Trigger_priv: "TRIGGER",
    Create_tablespace_priv: "CREATE TABLESPACE",
    Create_role_priv: "CREATE ROLE",
    Drop_role_priv: "DROP ROLE",
  };

  // 常用权限（显示在基础设置中）
  const commonPrivileges = [
    "Select_priv",
    "Insert_priv",
    "Update_priv",
    "Delete_priv",
    "Create_priv",
    "Drop_priv",
    "Index_priv",
    "Alter_priv",
  ];

  // 高级权限（显示在高级设置中）
  const advancePrivileges = privilegeFields.filter(
    (priv) => !commonPrivileges.includes(priv)
  );

  // 用户字段映射
  const userFieldMapping = {
    authentication_string: {
      type: "hidden",
    },
    // 基础字段
    User: {
      type: "text",
      label: "用户名",
      category: "base",
      required: true,
      placeholder: "数据库用户名",
    },
    Host: {
      type: "text",
      label: "主机",
      category: "base",
      required: true,
      placeholder: "% 表示任意主机",
    },
    plugin: {
      type: "select",
      label: "认证插件",
      category: "base",
      options: [
        { value: "caching_sha2_password", label: "caching_sha2_password" },
        { value: "mysql_native_password", label: "mysql_native_password" },
        { value: "sha256_password", label: "sha256_password" },
      ],
    },
    password: {
      type: "password",
      label: "密码",
      category: "base",
      placeholder: "留空则不修改密码",
      hint: "提示：编辑模式下留空密码字段将不会修改密码",
    },
    // 连接限制
    max_connections: {
      type: "number",
      label: "最大连接数",
      category: "advance",
      placeholder: "0",
      min: 0,
      hint: "0 表示不限制",
    },
    max_questions: {
      type: "number",
      label: "最大问题数",
      category: "advance",
      placeholder: "0",
      min: 0,
    },
    max_updates: {
      type: "number",
      label: "最大更新数",
      category: "advance",
      placeholder: "0",
      min: 0,
    },
    max_user_connections: {
      type: "number",
      label: "最大用户连接数",
      category: "advance",
      placeholder: "0",
      min: 0,
    },

    // SSL 配置
    ssl_type: {
      type: "select",
      label: "SSL 类型",
      category: "advance",
      options: [
        { value: "", label: "NONE" },
        { value: "ANY", label: "ANY" },
        { value: "X509", label: "X509" },
        { value: "SPECIFIED", label: "SPECIFIED" },
      ],
    },
    ssl_cipher: {
      type: "text",
      label: "SSL 密码",
      category: "advance",
      placeholder: "SSL 密码套件",
    },
    x509_issuer: {
      type: "text",
      label: "X509 颁发者",
      category: "advance",
      placeholder: "X509 证书颁发者",
    },
    x509_subject: {
      type: "text",
      label: "X509 使用者",
      category: "advance",
      placeholder: "X509 证书使用者",
    },

    // 账户状态
    account_locked: {
      type: "switch",
      label: "账户锁定",
      category: "advance",
      text: "是|否",
    },
    password_expired: {
      type: "switch",
      label: "密码过期",
      category: "advance",
      text: "是|否",
    },
  };

  // 动态添加权限字段到用户映射
  commonPrivileges.forEach((priv) => {
    userFieldMapping[priv] = {
      type: "checkbox",
      title: privilegeLabels[priv],
      category: "base",
    };
  });

  advancePrivileges.forEach((priv) => {
    userFieldMapping[priv] = {
      type: "checkbox",
      title: privilegeLabels[priv],
      category: "advance",
    };
  });

  // ==================== 表字段编辑配置 ====================

  const tableFieldMapping = {
    name: {
      type: "text",
      label: "字段名",
      category: "base",
      required: true,
      placeholder: "字段名",
    },
    type: {
      type: "select",
      label: "数据类型",
      category: "base",
      required: true,
      options: [
        { value: "varchar", label: "VARCHAR" },
        { value: "int", label: "INT" },
        { value: "bigint", label: "BIGINT" },
        { value: "text", label: "TEXT" },
        { value: "datetime", label: "DATETIME" },
        { value: "date", label: "DATE" },
        { value: "decimal", label: "DECIMAL" },
        { value: "float", label: "FLOAT" },
        { value: "double", label: "DOUBLE" },
        { value: "json", label: "JSON" },
        { value: "blob", label: "BLOB" },
      ],
    },
    length: {
      type: "number",
      label: "长度",
      category: "base",
      placeholder: "字段长度（可选）",
      hint: "部分类型需要指定长度，如 VARCHAR(255)",
    },
    defaultValue: {
      type: "text",
      label: "默认值",
      category: "base",
      placeholder: "默认值（可选）",
    },
    nullable: {
      type: "switch",
      label: "允许为空",
      category: "base",
      text: "是|否",
    },
    autoIncrement: {
      type: "switch",
      label: "自动增长",
      category: "base",
      text: "是|否",
    },
    primaryKey: {
      type: "switch",
      label: "主键",
      category: "base",
      text: "是|否",
    },
    comment: {
      type: "text",
      label: "注释",
      category: "base",
      placeholder: "字段说明",
    },
  };

  // ==================== 索引编辑配置 ====================

  const indexFieldMapping = {
    name: {
      type: "text",
      label: "索引名",
      category: "base",
      required: true,
      placeholder: "索引名",
    },
    type: {
      type: "select",
      label: "索引类型",
      category: "base",
      required: true,
      options: [
        { value: "primary", label: "主键索引" },
        { value: "unique", label: "唯一索引" },
        { value: "normal", label: "普通索引" },
        { value: "fulltext", label: "全文索引" },
      ],
    },
    fields: {
      type: "text",
      label: "涉及字段",
      category: "base",
      required: true,
      placeholder: "字段名，多个用逗号分隔",
      hint: "例如: id, name 或单个字段 email",
    },
    unique: {
      type: "switch",
      label: "唯一约束",
      category: "base",
      text: "是|否",
    },
    comment: {
      type: "text",
      label: "注释",
      category: "base",
      placeholder: "索引说明",
    },
  };

  // ==================== 导出配置 ====================

  // 如果是在浏览器环境中（通过 script 标签引入）
  if (typeof window !== "undefined") {
    window.FieldConfig = {
      datasource: datasourceFieldMapping,
      user: userFieldMapping,
      tableField: tableFieldMapping,
      index: indexFieldMapping,
      privilegeFields: privilegeFields,
      commonPrivileges: commonPrivileges,
      advancePrivileges: advancePrivileges,
      privilegeLabels: privilegeLabels,
    };
  }

  // 如果是在 Node.js 环境中（通过 require 或 import）
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      datasource: datasourceFieldMapping,
      user: userFieldMapping,
      tableField: tableFieldMapping,
      index: indexFieldMapping,
      privilegeFields: privilegeFields,
      commonPrivileges: commonPrivileges,
      advancePrivileges: advancePrivileges,
      privilegeLabels: privilegeLabels,
    };
  }
})();
