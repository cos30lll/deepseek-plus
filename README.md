# DeepSeek Plus

用自己的 API Key 在网页或 Android 上聊天。项目基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)。

聊天记录保存在本机。你可以从一条消息另开分支，也可以导入 DeepSeek、Simple Chat 或 Chatbox 的旧对话，接着上次的话题聊。

## 运行网页版

装好 Node.js 24 后，在项目根目录运行以下命令。

```sh
npm install -g pnpm@11.20.0
pnpm --dir web install --frozen-lockfile
pnpm --dir web dev
```

打开 `http://localhost:8090`，在「设置 → API 配置」里填入 DeepSeek 的 API Key。这里也支持 OpenAI 和 Anthropic 兼容接口。

[构建 Android 版](docs/BUILD.md#android) · [备份格式](docs/ARCHIVE_FORMATS.md) · [MIT 许可证](LICENSE)
