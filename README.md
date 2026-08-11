# TG 帖子总结

一个本地运行的 Telegram 公开帖子总结工具。

输入公开 Telegram 帖子链接后，工具会自动抓取主贴和公开讨论评论，并使用 OpenAI 或 OpenAI 兼容中转站生成中文结构化总结。

## 功能

- 抓取公开 Telegram 频道帖子
- 抓取帖子下的公开讨论评论，并自动分页
- 总结主贴问题、评论区共识、观点分歧和关键建议
- 为总结结论附带对应评论的作者与原文依据
- 显示评论抓取数量与 Telegram 标记数量的差异
- 支持 OpenAI 官方 API 和 OpenAI 格式兼容中转站
- 自动读取 Windows 系统代理，兼容 FlClash
- 使用 IndexedDB 保存最近 100 条本地历史记录
- 支持手动 WebDAV 双向同步最近 100 条总结记录，不同步 API Key
- 不保存服务器端历史，不需要 Telegram 登录或频道权限
- 支持封装为不依赖电脑后端的 Android APK

## 运行环境

- Node.js 20 或更高版本
- npm
- 可访问 Telegram 的网络环境
- OpenAI API Key 或 OpenAI 兼容中转站 Key

Android APK 还需要 Android Studio、JDK 21 或更高版本、Android SDK 和 Gradle 所需组件。

## 安装

```powershell
cd "D:\APP\Codex Desktop\TG帖子总结"
npm install
```

复制环境变量模板：

```powershell
Copy-Item .env.example .env
```

然后编辑 `.env`：

```env
OPENAI_API_KEY=你的APIKey
OPENAI_MODEL=你的模型名称
OPENAI_BASE_URL=https://api.openai.com/v1
PORT=8787
```

### 使用中转站

将 `OPENAI_BASE_URL` 改为中转站提供的 OpenAI 兼容地址，通常以 `/v1` 结尾：

```env
OPENAI_BASE_URL=https://your-relay.example.com/v1
OPENAI_MODEL=中转站支持的模型名称
```

程序也兼容常见的 `OPENAI_API_BASE` 环境变量。

### Telegram 网络代理

Telegram 抓取和 OpenAI 请求是两条独立的网络链路。OpenAI 中转站可用不代表 Telegram 一定可访问。

如果 FlClash 已开启 Windows 系统代理，程序会自动读取系统代理。也可以显式配置：

```env
TELEGRAM_PROXY_URL=http://127.0.0.1:7890
```

SOCKS5 代理示例：

```env
TELEGRAM_PROXY_URL=socks5h://127.0.0.1:7890
```

## 启动

开发模式：

```powershell
npm run dev
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。

生产构建：

```powershell
npm run build
npm run start
```

## 下载 Android APK

debug APK 不再提交到 `main` 分支。每次 push 会自动运行 [Build Android APK](https://github.com/xxf1113/TG_SUM/actions/workflows/android-apk.yml)，并在 [GitHub Releases](https://github.com/xxf1113/TG_SUM/releases) 创建一个预发布版本，附件名为 `TG帖子总结.apk`。也可以从对应 Actions 运行记录下载 Artifact。

APK 支持 Android 7.0（API 24）及更高版本。首次打开后，在右上角配置 API Key、OpenAI Base URL 和模型名称。

## 构建 Android APK

Android 版不启动 Node 服务。首次打开 APK 后，在右上角配置 API Key、OpenAI Base URL 和模型名称；API Key 会使用 Android Keystore 加密保存。Telegram 网络访问使用手机当前的 VPN 或系统代理。

```powershell
npm run android:build
```

个人安装版输出在：

```text
android/app/build/outputs/apk/debug/TG帖子总结.apk
```

安装到已连接的手机：

```powershell
adb install -r "android/app/build/outputs/apk/debug/TG帖子总结.apk"
```

Android 版只接受 HTTPS 的 OpenAI Base URL；APK 仍需要联网，不能离线抓取 Telegram 或调用模型。

## 使用流程

1. 输入公开 Telegram 帖子链接，例如 `https://t.me/channel/123`。
2. 点击“抓取并总结”。
3. 工具会先抓取主贴和公开评论，再自动生成总结。
4. 结果会保存到当前浏览器的本地历史记录中。

## WebDAV 同步

点击顶部云朵按钮配置 WebDAV 地址、远程文件路径、用户名和密码，再在“最近总结”区域点击“WebDAV 同步”。同步会读取远程历史，与本地最近 100 条记录按记录 ID 合并后重新上传。

WebDAV 文件默认为 `threadbrief/history.json`，只包含帖子、评论和总结结果，不包含 API Key、OpenAI 配置或 WebDAV 密码。浏览器仅在当前站点本地保存 WebDAV 配置，Android 使用加密存储保存密码。

## 测试

```powershell
npm test
```

当前测试覆盖 Telegram 链接校验、HTML 清理、帖子解析、讨论评论解析、评论去重、代理配置和 OpenAI 兼容地址配置。

## 接口

后端默认运行在 `8787` 端口：

- `GET /api/health`：健康检查
- `POST /api/telegram/preview`：抓取公开帖子和讨论评论
- `POST /api/summary`：调用 OpenAI 兼容 Chat Completions 接口生成总结
- `POST /api/webdav`：代理 WebDAV 历史文件读取和写入，不保存同步配置

## 限制

- 只支持公开频道帖子，不支持私有频道、需要登录的内容或 `t.me/c/...` 链接。
- Telegram 页面结构变化可能导致抓取失败。
- 只能获取 Telegram 公开讨论组件中可见的评论。
- 评论数量较多时，工具最多处理 500 条，并在页面中显示抓取限制。
- `.env`、依赖目录、Android 构建目录和本地构建缓存不会提交到 Git 仓库；debug APK 通过 GitHub Actions Artifact 或 GitHub Release 分发。

## 项目结构

```text
src/       React 前端、本地历史记录和运行时适配
shared/    浏览器与 Node 共用的 Telegram/总结逻辑
server/    Node 端 Telegram 抓取、OpenAI 总结和 HTTP 接口
android/   Capacitor Android 工程和原生网络/Keystore 插件
public/    静态资源
```
