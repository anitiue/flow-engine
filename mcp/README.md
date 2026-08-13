# Flow Engine MCP

`flow-engine-mcp` 是 Flow Engine 的 stdio MCP Server。它将全部 15 个流程工具提供给支持 MCP 的客户端，例如 Claude Desktop、Claude Code、Codex、Cursor 和 Windsurf。

## 连接方式

无需安装第三方依赖。客户端应以 stdio 方式启动 `server.js`：

```json
{
  "mcpServers": {
    "flow-engine": {
      "command": "node",
      "args": ["/absolute/path/to/flow-engine/mcp/server.js"],
      "env": {
        "FLOW_ENGINE_DATA_DIR": "/absolute/path/to/flow-engine-data",
        "FLOW_ENGINE_AGENT_ID": "mcp-user"
      }
    }
  }
}
```

Windows 示例：

```json
{
  "mcpServers": {
    "flow-engine": {
      "command": "node",
      "args": ["C:\\path\\to\\flow-engine\\mcp\\server.js"],
      "env": {
        "FLOW_ENGINE_DATA_DIR": "C:\\flow-engine-data",
        "FLOW_ENGINE_AGENT_ID": "mcp-user"
      }
    }
  }
}
```

也可在 `mcp/` 目录执行 `npm link`，再将命令配置为 `flow-engine-mcp`。

## 环境变量

- `FLOW_ENGINE_DATA_DIR`：流程数据根目录。未设置时使用 `~/.flow-engine/`。MCP 数据与 Hanako 插件的 `plugin-data/flow-engine/` 完全分离。
- `FLOW_ENGINE_AGENT_ID`：服务默认身份，未设置时为 `mcp-user`。工具调用也可在参数中提供 `agent_id`，用于声明当前操作的责任身份；该调用参数优先于服务默认身份。

`agent_id` 是声明式身份，不代表认证或权限验证。MCP 标准输入输出没有宿主应用的可信用户上下文，部署者应由启动配置和客户端访问控制决定谁可以使用该服务。

## 数据目录结构

首次启动会自动创建目录；当 `flows/` 为空时，会自动复制仓库内的 `flows/example.yaml`。

```text
<FLOW_ENGINE_DATA_DIR>/
  flows/         # 流程定义
  orders/        # 进行中或暂停的订单
  archive/       # 已完成归档或已关闭订单
  bindings.json  # 项目与流程绑定关系
```

## 与 Hanako 插件版的差异

MCP 版复用同一套 15 个流程工具、流程定义、门禁检查、签名和归档规则，但不包含 Hanako 插件的自动保障层。MCP 没有宿主事件钩子，无法自动拦截或注入调度行为；客户端需要自行在合适的工作节点调用 `flow_check`、`flow_sign` 等工具。

本地 Hanako 应继续使用插件版；本 MCP 版面向其他 MCP 客户端。
