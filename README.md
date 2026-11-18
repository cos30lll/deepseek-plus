# deepseek plus

基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 的社区客户端，包含 React / TypeScript 网页和 Android WebView 应用。此源码包基于 v14（`1.0.13-plus14`），并非 DeepSeek、Simple Chat 或 Chatbox 的官方发布。

- 可配置 DeepSeek、OpenAI 和 Anthropic 兼容服务商及模型 ID，使用自己的 API Key。
- 支持本地对话与分支、附件、会话参数、手动前情提要和预设。
- 可导入 DeepSeek ZIP、Simple Chat JSON/ZIP、Chatbox JSON/ZIP 和本应用完整备份。支持增量、覆盖匹配会话和保留副本。
- 完整备份含对话、分支、现存附件原件、会话参数、前情提要和预设，不含设置里的 API Key、服务商配置或草稿。第三方备份仅恢复支持的字段。

## 电脑上运行

安装 [Node.js 24](https://nodejs.org/) 和 pnpm。以下命令在包含本 README 的目录运行，适用于 PowerShell、macOS 和 Linux：

```sh
npm install -g pnpm@11.20.0
pnpm --dir web install --frozen-lockfile
pnpm --dir web dev
```

在浏览器打开 `http://localhost:8090`。从「设置 → API 配置」填写自己的服务商、模型和 Key。浏览器直连接口需要服务端允许 CORS；Android 使用原生网络桥。聊天历史保存在当前站点的 IndexedDB，浏览器端 Key 只存于当前会话，Android 端用本机 Keystore 保护。请求内容会发送到所选服务商，请核对 URL 后再输入 Key。

生产网页与检查：

```sh
pnpm --dir web type
pnpm --dir web test:import
pnpm --dir web build
```

网页产物在 `web/dist/`，可用 HTTP 服务预览或部署到静态站点，不需提交到 Git。导入检查默认使用合成样例和内存数据库，不读取个人聊天、不发模型请求。主动传入备份路径时可只读检查 DeepSeek ZIP：`node web/check_import_v14.mjs "/path/to/backup.zip"`。导入和备份支持范围见 [备份格式](docs/ARCHIVE_FORMATS.md)。

## 构建 Android

另需 Python 3.9+、JDK 17、Android SDK Platform 35 和 Build-Tools 35.0.0。可在 Android Studio 的 SDK Manager 安装 SDK；此项目通过 Python 调用 SDK 工具打包，不需要 Gradle。Android 最低 API 为 26。

先完成上面的 `pnpm --dir web build`，然后运行：

```sh
python3 build_android.py
```

Windows 可用 `py -3 build_android.py`。SDK 不在默认位置时，设置 `ANDROID_HOME` 或在命令后加 `--sdk "你的 SDK 目录"`。JDK 不在 PATH 时先设置 `JAVA_HOME`。

输出为 `build/android/deepseek-plus-debug.apk`。第一次构建会在被 Git 忽略的 `.signing/` 目录生成调试签名。**新签名不能覆盖先前安装的同包名 APK**。如需续用原签名，请在自己电脑上用已有私钥文件构建：

```sh
python3 build_android.py --keystore "/path/to/private-keystore.p12" --key-alias "your-alias"
```

脚本会交互读取库密码，也可从本机环境读取 `DSP_KEYSTORE_PASSWORD` 和可选的 `DSP_KEY_PASSWORD`（默认同库密码）。输出 `build/android/deepseek-plus-release.apk`。不要上传密钥、密码或聊天备份。

## 发布到 GitHub

解压 ZIP 后，把包含本 README、`.gitignore`、`web/`、`android/` 的 **`deepseek-plus`** 目录作为仓库根目录。发布源码文件，不把 ZIP 本身提交为仓库内容。

可在 GitHub Desktop 选择 **File → Add Local Repository**，选中解压后的目录；尚无 Git 仓库时按提示在该目录初始化。提交并选择 **Publish repository**，需开源时取消 **Keep this code private**。也可先在 GitHub 建立一个不自动生成 README 的空仓库，在源码目录运行：

```sh
git init -b main
git add .
git status --short
git commit -m "Initial public release"
git remote add origin https://github.com/YOUR-ACCOUNT/deepseek-plus.git
git push -u origin main
```

推送后 `.github/workflows/ci.yml` 会在 Linux 和 Windows 检查 Web 类型、导入功能和构建；不部署网页、不签名、不发布 APK。建议将 APK 单独作为 GitHub Release 附件发布。

## 目录与许可

| 路径 | 内容 |
| --- | --- |
| `web/` | 客户端、依赖锁文件与导入检查 |
| `android/` | WebView 宿主、Android 清单与资源 |
| `build_android.py` | Android 本地构建入口 |
| `UPSTREAM.json` | 上游仓库与原始提交 |

本公开版用新绘制的启动图标和重新撰写的提要提示词替换了旧资源；不包含参考 APK 或反编译材料。原上游 MIT 版权和许可见 [LICENSE](LICENSE)，依赖许可与声明见 [NOTICE.md](NOTICE.md)。