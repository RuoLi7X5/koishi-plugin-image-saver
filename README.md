# koishi-plugin-image-saver

> 群内存图 / 更图插件 —— 一条指令存，一条指令发，支持群共享或群内按人隔离。

## 功能介绍

- **存图**：触发指令后，机器人等待你发送或引用一张图片，自动下载保存到本地
- **存图**：仅支持“引用含图消息 + `!存图`”方式保存，避免多人并发混乱
- **更图**：使用 `!更图` 发出本群已保存图片
- 支持两种绑定模式：**群共享**（同群一张图）/ **群内个人**（同群每人一张图）
- 支持按群覆盖模式：可以指定某些群共享、某些群个人
- 支持管理员命令动态切换当前群模式（重启后仍保留）
- 每群只保存**一张**，再次存图直接覆盖旧图
- 支持**直接发图**和**引用含图消息**两种方式存图
- 指令名称可在配置中**自由修改**
- 命令必须带感叹号前缀，兼容 `!` 与 `！`（英文/中文感叹号效果一致）

## 安装

在 Koishi 控制台插件市场搜索 `image-saver` 安装，或在 `koishi.yml` 中手动添加：

```yaml
plugins:
  image-saver:
    saveCommand: 存图
    getCommand: 更图
    modeCommand: 存图模式
    bindMode: guild
    modeAdminUserIds:
      - "123456789"
    guildModeOverrides:
      - guildId: "123456789"
        mode: user
      - guildId: "987654321"
        mode: guild
```

## 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `saveCommand` | string | `存图` | 保存图片的指令名称 |
| `getCommand` | string | `更图` | 发出已保存图片的指令名称 |
| `modeCommand` | string | `存图模式` | 管理员切换当前群模式的指令名称 |
| `bindMode` | `guild \| user` | `guild` | `guild`=群共享；`user`=群内按用户隔离 |
| `modeAdminUserIds` | string[] | `[]` | 可执行 `modeCommand` 的管理员 QQ 号（userId）白名单 |
| `guildModeOverrides` | array | `[]` | 按群覆盖模式，未匹配到的群走 `bindMode` |

## 使用示例

```
用户：存图
机器人：请使用“引用含图消息 + 存图”进行保存

用户：[引用一条图片消息并发送：!存图]
机器人：✅ 存图成功！

用户：!更图
机器人：[发出之前存的图片]
```

### 管理员切换群模式

```
管理员：!存图模式
机器人：当前模式：群共享模式
       用法：!存图模式 共享 或 !存图模式 个人

管理员：!存图模式 个人
机器人：✅ 已切换为群内个人模式

普通成员：!存图模式 共享
（无反馈）
```

## 注意事项

- 此指令**仅限群聊**使用，私聊中无效
- 存图只支持引用图片，不支持“先发存图再补图”
- 不带感叹号前缀（如仅发“存图/更图”）不会触发指令
- 图片以**二进制文件**形式保存在 Koishi 数据目录下的 `data/image-saver/` 文件夹中，不依赖图片 URL（QQ 图片 URL 有时效限制）
- 支持格式：PNG、JPG、GIF、WebP
- 若 `bindMode=user`，同一群内 A、B 使用同一条“更图”命令时，只会拿到各自存入的图片
- 若配置了 `guildModeOverrides`，其优先级高于 `bindMode`
- 管理员指令切换结果会持久化到 `data/image-saver/guild-mode-overrides.json`，且优先级高于 `guildModeOverrides`
- `modeAdminUserIds` 之外的用户调用模式切换指令时，插件不返回任何消息

## 数据存储路径

```
<Koishi 数据目录>/data/image-saver/<作用域键>.<ext>
```

## License

MIT
