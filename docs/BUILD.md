# 从源码构建

## 网页版

使用 Node.js 24 和 pnpm 11.20.0，在项目根目录运行以下命令。

```sh
pnpm --dir web install --frozen-lockfile
pnpm --dir web type
pnpm --dir web test:import
pnpm --dir web build
```

生成的网页在 `web/dist/`。导入测试默认使用内存数据库和示例数据。

## Android

先构建网页版，再准备 Python 3.9+、JDK 17、Android SDK Platform 35 和 Build-Tools 35.0.0。在项目根目录运行以下命令。

```sh
python3 build_android.py
```

Windows 可以用 `py -3 build_android.py`。如果脚本找不到 SDK，用 `--sdk` 指定目录或设置 `ANDROID_HOME`。JDK 路径可以用 `JAVA_HOME` 指定。

调试包生成在 `build/android/deepseek-plus-debug.apk`，本机调试签名保存在 `.signing/`。要覆盖安装已有版本，请用原签名打包。

```sh
python3 build_android.py --keystore "/path/to/private-keystore.p12" --key-alias "your-alias"
```

按提示输入密码，或设置 `DSP_KEYSTORE_PASSWORD` 和可选的 `DSP_KEY_PASSWORD`。签名后的 APK 在 `build/android/deepseek-plus-release.apk`。
