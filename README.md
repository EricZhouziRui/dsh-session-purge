# 彻底删除会话 · DSH Session Purge

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：**真正**删除会话，而不只是从侧边栏移除。

它会删除会话在磁盘上的转录目录、投影缓存、spill 文件、工作区记账，以及归档/置顶/收藏记录；同时能发现并清理此前删除会话后遗留的孤儿目录。

> A DSH plugin that **permanently** removes a session's transcript folder, projection cache, spill files, workspace accounting and archive/pin/favorite records — not just the sidebar entry.

---

## 为什么需要它

DSH 自带删除、以及一些会话管理插件（例如 archive-manager）的「永久删除」，通常只移除会话在列表中的记录。删除之后，类似下面的目录仍会留在磁盘上：

```text
~/.dsh/sessions/--Users-you-project--/session-xxxxxxxx-..../   # 对话正文与附件
~/.dsh/storages/session_projcache/sessions/session-xxxxxxxx....json
~/.dsh/storages/workspace.json                                  # 工作区/归档/置顶记账
```

这些残留会一直占用空间；某些插件还会因为旧索引反复提示“缺少列表缓存 / 重建失败”。本插件就是用来把这些痕迹一起清干净的。

## 功能

| 能力 | 说明 |
| --- | --- |
| 彻底删除 | 转录目录、投影缓存、spill、工作区记账、归档/置顶/收藏、空项目目录 |
| 自动收尾 | 挂接 `api-session/removed` 事件和 `workspaceRegistry` 的删除方法；archive-manager 等插件删除后自动清理残留 |
| 运行中可删 | 先 flush 并从 Host 分离，再删文件；对仍在写盘的会话用 tombstone 反复清除，直到 Agent 结束 |
| 工作区视图 | 设置页按工作区分组，逐会话删除；一级只显示标题、状态、时间、大小 |
| 安全清理 | 只识别 DSH 项目目录；拒绝符号链接路径；没有持久化列表时自动停用残留清理 |
| 可审计 | 删除前支持 dry-run；没有磁盘痕迹时返回 `missing`，不假报成功 |
| 子代理保护 | 默认隐藏 `origin: subagent` 的委派会话，避免误删正在运行的子任务 |

## 安装

### 前置条件

- DSH 0.2.x（在 0.2.2-rc.1 上测试）
- Node.js 18+（DSH Desktop 自带 Node 也可以）
- 至少启动过一次 DSH，让 `~/.dsh`（Windows 为 `%USERPROFILE%\.dsh`）和 profile 生成

### 方式 A：一键安装（推荐）

```bash
git clone https://github.com/EricZhouziRui/dsh-session-purge.git
cd dsh-session-purge

# 先预演，看看会改哪个 profile
node install.mjs --dry-run

# 真正安装
node install.mjs
```

安装器会自动定位 `$DSH_HOME` 和 profile，然后：

1. 把插件复制到 `<profile>/local-plugins/@local/session-purge`；
2. 同步写入 `<profile>/node_modules/@local/session-purge`；
3. 更新 `<profile>/package.json` 的 `dependencies` 与 `dsh.profile.bundles`；
4. 备份原配置到 `<profile>/package.json.session-purge.bak`。

装完**完全退出 DSH（macOS 按 Cmd+Q）再重新打开**。设置 → 插件中应出现「彻底删除会话」。

**常用参数**

```bash
node install.mjs --profile web            # 安装到指定 profile
node install.mjs --home /custom/.dsh      # DSH_HOME 不在默认位置
node install.mjs --link                   # 开发模式：不复制，直接链接当前源码目录
```

`--link` 适合改代码后重启 DSH 立即生效；普通用户用默认复制模式即可。

### 方式 B：手动安装

如果不想运行脚本：

1. 把仓库目录复制到 `<profile>/local-plugins/@local/session-purge`；
2. 把它复制/软链到 `<profile>/node_modules/@local/session-purge`；
3. 在 `<profile>/package.json` 中加入：

   ```json
   {
     "dependencies": {
       "@local/session-purge": "file:./local-plugins/@local/session-purge"
     },
     "dsh": {
       "profile": {
         "bundles": ["@local/session-purge"]
       }
     }
   }
   ```

4. 重启 DSH。

更完整的步骤、验证和卸载说明见 [INSTALL.md](INSTALL.md)。

## 使用

### 设置页

打开 **设置 → 彻底删除会话**：

- 按工作区分组；没有工作区归属的会话和磁盘残留放在最后一组。
- 一级只显示标题、运行中/残留标记、时间和大小；路径、会话 ID、转录目录与痕迹收在每行「详情」里。
- 点「彻底删除」→「确认删除」即永久删除。运行中的会话也可以删，页面会提示刷新后消失。
- 顶部「清理残留」清理孤儿会话目录、过期投影缓存、失效工作区/收藏记录、archive-manager 失效索引和空项目目录。

### 模型工具

```text
session_purge({ "action": "list" })
session_purge({ "action": "purge", "sessionIds": ["session-xxxx"], "dryRun": true })
session_purge({ "action": "cleanup" })
session_purge({ "action": "reconcile", "sessionIds": ["session-xxxx"] })
```

### 自动挂接其他删除入口

安装后不需要每次打开本插件。它会：

- 监听官方 `api-session/removed`；
- 包装 `workspaceRegistry` 上的 `deleteSession` / `deleteArchivedSessions` / `cleanOrphanSubagents` / `deleteSessionCore` / `publishDeletedSession` 等删除方法；
- 对方声明删除后等待约 0.9 秒，确认会话已不在持久化列表中，再清理残留；
- 普通关闭/Agent 释放也会触发事件，但会话仍在列表中，会被安全跳过。

设置页顶部的「自动收尾」状态行可确认是否已挂接、最近一次处理的会话和结果。

## 安全边界

- 删除**不可恢复**。删除前请确认标题与路径；建议先 `dryRun`。
- 只删除满足 `<sessionsRoot>/<project>/<session-id>` 结构、且整条路径不经过符号链接的目录。
- `sessions/` 下不是 `--<encoded-cwd>--` / `_no-cwd` 的目录不会被当成 DSH 项目。
- 没有磁盘痕迹、又不在持久化列表里的目标返回 `missing`，不会假装删除成功。
- 清理孤儿目录时跳过创建不足 60 秒的会话目录，避免误删正在生成的新会话。
- 读取不到会话持久化列表时，「清理残留」主动停用，避免把正常会话误判为孤儿。
- 不删除附件二进制对象、费用统计、模型凭据。

## 更新

- 用 `--link` 安装：在源码目录 `git pull`，重启 DSH。
- 用默认复制安装：`git pull` 后重新执行 `node install.mjs`，重启 DSH。

## 卸载

1. 从 `<profile>/package.json` 的 `dsh.profile.bundles` 与 `dependencies` 中移除 `@local/session-purge`；
2. 删除 `<profile>/local-plugins/@local/session-purge` 和 `<profile>/node_modules/@local/session-purge`；
3. 重启 DSH。

卸载插件不会删除会话数据本身。

## 开发与测试

```bash
node --test test/*.test.mjs
node --check engine.js index.js client.js
```

测试覆盖引擎扫描/删除、符号链接与路径穿越、工作区记账、archive-manager 索引清理、运行中会话、自动挂接、客户端冷启动 slot 注册和安装器行为。

目录：

```text
index.js            Host 半：HTTP API + session_purge 工具 + 自动挂接
engine.js           纯 Node 扫描/删除引擎（不依赖 Cordis）
client.js           Web 设置页（settings.section）
cordis.patch.yml    bundle 默认补丁
test/               单元、边界、集成测试
install.mjs         本地安装器
```

## License

[MIT](LICENSE)
