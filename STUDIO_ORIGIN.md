# opencut_os 迁入记录

- 日期：2026-10-03（北京时间）。
- 工作室端名：`opencut_os`。
- 来源：用户指定的本机 OpenChatCut 工作目录；原目录保留。
- Git 基线：`d03acbd6c7b15e7fd08b48f2c54cd1eaaeabc35a`。
- package 版本：`0.2.15`；上游 package 名：`openchatcut`。
- 上游仓库：<https://github.com/0xsline/OpenChatCut>。
- 保留源码、静态产品资产、配置示例、LICENSE、Git 历史及原工作目录中已有的源码修改；这是工作副本快照，不是干净发布版本。
- 本次仅调整本副本 README、启动脚本中的端名说明，并新增本记录；不改变工程格式、CLI、应用身份或媒体协议。

迁入时已有修改：

```text
.gitignore
desktop/directory-watch.verify.ts
server/directory-watch-import.ts
server/directory-watch.ts
server/media-binaries.ts
server/media-binaries.verify.ts
shared/file-name.ts
shared/file-name.verify.ts
src/media/directoryDrop.ts
src/media/directoryDrop.verify.ts
src/media/mediaProbe.ts
src/media/mobileUploadApi.verify.ts
src/media/useMediaPoolFileImport.ts
launch.sh（原目录未跟踪文件）
```

未复制：`node_modules`、构建产物、`.env` / `.env.local`、`.cache`、`.run`、`.codex`、用户上传媒体、ASR 模型和自动同步的浏览器运行文件。本副本需独立安装依赖和配置。

未复制 `.git/openchatcut-dev-profile.json`：该文件绑定原 checkout 的绝对路径与隔离运行 profile。新副本首次运行 `npm run dev` 时由原有脚本创建自己的 profile，避免沿用原工程数据及密钥。原目录和原 profile 均未修改。

两副本不自动同步。后续上游跟进通过 Git 评估并合入；跨端需求维护在 [工作室任务清单](../.specs/20261003-media-studio-dual-os/tasks.md)。
