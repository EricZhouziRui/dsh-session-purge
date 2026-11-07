# 安装说明 · INSTALL

本文是 [README](README.md) 的详细安装/卸载补充。

## 0. 前置条件

- 已安装 **DeepSeek Harness Desktop**，并且至少启动过一次。
  - macOS/Linux 数据目录：`~/.dsh`
  - Windows：`%USERPROFILE%\.dsh`（部分版本在 `%APPDATA%\dsh` 或 `%LOCALAPPDATA%\dsh`）
- 有 Node.js 18+（DSH Desktop 自带 Node 亦可）。
- 建议先**完全退出 DSH** 再安装；安装器会修改 profile 的 `package.json`，退出状态更稳妥。

确认 DSH 数据目录和 profile：

```bash
ls ~/.dsh/profiles
# 常见为 desktop / web
```

## 1. 安装

### 1.1 下载 Release（普通用户）

从 <https://github.com/EricZhouziRui/dsh-session-purge/releases> 下载最新 zip，解压后进入目录：

```bash
node install.mjs --dry-run
node install.mjs
```

### 1.2 从源码安装（开发者）

```bash
git clone https://github.com/EricZhouziRui/dsh-session-purge.git
cd dsh-session-purge

# 预演：只打印计划，不写任何文件
node install.mjs --dry-run

# 安装
node install.mjs
```

看到“安装完成”后，**完全退出 DSH 再打开**（macOS：Cmd+Q；Windows：托盘图标右键退出）。

> 安装器默认使用**复制模式**：把插件复制到 profile 的 `local-plugins`，之后移动/删除仓库目录不影响已安装的插件。

### 参数

| 参数 | 作用 |
| --- | --- |
| `--dry-run` | 只预演，不修改配置 |
| `--profile <name>` | 指定 profile（默认 `desktop`，其次 `web`，否则第一个） |
| `--home <dir>` | 指定 DSH_HOME（默认 `~/.dsh`，也读 `$DSH_HOME`） |
| `--link` | 开发模式：不复制，直接把 profile 链接到当前仓库目录 |
| `--help` | 帮助 |

示例：

```bash
node install.mjs --profile web
node install.mjs --home "/Users/me/Library/Application Support/dsh"
node install.mjs --link
```

`--link` 适合需要频繁改源码的人：`git pull` 后重启 DSH 即生效。注意不要移动或删除被链接的源码目录。

## 2. 安装器做了什么

以目标 profile 为 `<profile>`：

1. 复制插件到 `<profile>/local-plugins/@local/session-purge`（`--link` 时为符号链接）；
2. 写入 `<profile>/node_modules/@local/session-purge`；
3. 更新 `<profile>/package.json`：
   - `dependencies["@local/session-purge"] = "file:./local-plugins/@local/session-purge"`（`--link` 时为 `link:<仓库绝对路径>`）；
   - 向 `dsh.profile.bundles` 追加 `@local/session-purge`（已存在则不重复）；
4. 备份原配置到 `<profile>/package.json.session-purge.bak`。

安装器只读写 profile 配置和插件目录，**不会删除任何会话数据**。

## 3. 手动安装（备用）

如果不运行脚本：

```bash
PROFILE="$HOME/.dsh/profiles/desktop"
mkdir -p "$PROFILE/local-plugins/@local" "$PROFILE/node_modules/@local"
cp -R . "$PROFILE/local-plugins/@local/session-purge"
rm -rf "$PROFILE/node_modules/@local/session-purge"
cp -R "$PROFILE/local-plugins/@local/session-purge" "$PROFILE/node_modules/@local/session-purge"
```

然后编辑 `<profile>/package.json`：

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

已有 `dependencies` / `dsh.profile.bundles` 时只追加对应项，不要覆盖其他插件。改完重启 DSH。

## 4. 安装后验证

1. 重新打开 DSH → **设置 → 插件**：应能看到「彻底删除会话」。
2. 打开 **设置 → 彻底删除会话**：
   - 能看到会话列表或“没有会话”；
   - 顶部统计行、清理残留按钮可用。
3. 在设置页确认“自动收尾”状态（如果安装了 archive-manager 等会触发删除的插件）。
4. 可选：让模型调用 `session_purge({ "action": "list" })`，应返回会话列表。

## 5. 常见问题

**找不到 DSH 数据目录 / profile**

先打开一次 DSH，进入任意对话再退出；确认 `~/.dsh/profiles` 存在。如果 DSH_HOME 不在默认位置，用 `--home` 或 `$DSH_HOME`。

**有多个 profile**

默认 `desktop`。要装到其他 profile：`node install.mjs --profile <名字>`。

**安装后设置页没有出现**

- 确认已完全退出并重新打开 DSH（不是只关闭窗口）；
- 检查 `<profile>/package.json` 的 `dsh.profile.bundles` 是否包含 `@local/session-purge`；
- 检查 `<profile>/node_modules/@local/session-purge/package.json` 是否存在；
- 如果启动失败，查看最新日志：`~/Library/Logs/DeepSeek Harness/crash-*-web-boot.log`（macOS）。

**重启后插件加载失败**

优先用 DSH 的恢复界面关闭插件；然后检查 `@local/session-purge` 的依赖路径是否还存在。若用 `--link` 安装，不要把仓库目录移动到别处。

**会影响已有会话吗**

插件只在你点击删除或调用工具时删除目标会话；安装/更新本身不会动会话数据。清理残留只处理不在持久化列表中的孤儿目录。

## 6. 更新

- 复制模式：`git pull` 后重新运行 `node install.mjs`，重启 DSH。
- 链接模式：`git pull` 后重启 DSH。

## 7. 卸载

1. 编辑 `<profile>/package.json`：
   - 从 `dsh.profile.bundles` 移除 `@local/session-purge`；
   - 从 `dependencies` 移除 `@local/session-purge`；
2. 删除 `<profile>/local-plugins/@local/session-purge` 和 `<profile>/node_modules/@local/session-purge`；
3. 重启 DSH。

也可以用备份回滚：把 `<profile>/package.json.session-purge.bak` 复制回 `package.json`，再删除上述目录。

卸载插件不会删除会话数据。

## 8. 卸载后想恢复自动收尾

重新执行 `node install.mjs` 即可；已存在的会话和归档记录不会受影响。
