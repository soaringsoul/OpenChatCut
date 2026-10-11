---
name: agent-motion
description: 用本机 Agent Motion 把口播原片与完整 SRT 做成动效包装（MP4 + Three.js 工程），再把成片导入 OpenChatCut 素材池继续剪辑。
---

# Agent Motion 桥接

本技能把 [Agent Motion](https://github.com/erduo1998-cell/agent-motion) 接到 OpenChatCut，**不**把 Agent Motion 嵌进时间线引擎。成片在 `work/<影片名>/` 下生成，再用编辑器工具导入素材池。

## 前置条件

1. 已运行 `dtb_media_studio/scripts/setup-agent-motion.sh`（或手动 clone + `node scripts/bootstrap.mjs`）。
2. `opencut_os/.env.local` 含 `AGENT_MOTION_ROOT=/绝对路径/agent_motion`。
3. 可用 `GET /api/agent-motion/status` 或 `run_agent_motion_script(command="node scripts/doctor.mjs --matting")` 自检。

## 与上游 Skill 的关系

Agent Motion 自带两个本地 Skill：

- `srt-reference-to-three` — 内容分析
- `motion-craft` — 动效制作

它们已复制到 `~/.openchatcut/skills/`。正文里的规则仍适用，但**所有**原文写的：

```text
node scripts/...
npm run ...
python3 scripts/...
```

在 OpenChatCut 里一律改为：

```text
run_agent_motion_script(command="node scripts/...")
```

工作目录锁定在 `AGENT_MOTION_ROOT`，不是技能子目录。

## 从 OpenChatCut 素材池准备 inputs

时间线上的视频在素材池里是 **`/media/uploads/<文件名>`**（HTTP 路径），**不是**磁盘绝对路径。禁止：

- `bash -c` / `sh -c`（白名单不允许内联 shell）
- `mkdir … && cp /media/uploads/…`（`&&` 不会被当作一条 shell 执行，`cp` 也找不到 `/media/uploads`）

正确做法：用 `run_agent_motion_script` 的 **`files`** 参数，在执行 node 脚本**之前**写入工程目录，例如：

```json
{
  "files": [
    { "path": "inputs/work-map-promo/source.mp4", "url": "/media/uploads/xxx.mp4" },
    { "path": "inputs/work-map-promo/source.srt", "content": "1\\n00:00:00,000 --> …" }
  ],
  "command": "node scripts/read-stage.mjs …"
}
```

也可单独 `cp`（无 `&&`）：`run_agent_motion_script(command="cp /media/uploads/xxx.mp4 inputs/work-map-promo/source.mp4")` — 服务端会把 `/media/uploads/` 解析为真实上传目录。

SRT 优先从工程字幕/转写导出为 `content`，或让用户提供完整 SRT 文本。

## 推荐流程

1. 用 **`files`** 把 `source.mp4` 与 `source.srt` 写入 `AGENT_MOTION_ROOT/inputs/<工作名>/`（或用户指定工作目录）。
2. `load_skill` → `srt-reference-to-three`，按正文完成分析；脚本用 `run_agent_motion_script`。
3. `load_skill` → `motion-craft`，从 `assets` 阶段顺序推进；脚本同样用 `run_agent_motion_script`。
4. 预览：`npm run serve` 后在浏览器打开 `http://127.0.0.1:8793/work/<影片>/`（可在 Agent Motion 根目录用 `run_agent_motion_script(command="npm run serve")` 启动，勿与剪辑端端口混淆）。
5. 满意后，把成片 MP4 **导入当前 OpenChatCut 工程素材池**（`import_media` / 上传），再按需上时间线。不要声称已自动写入时间线。

## 禁止

- 不要用 `run_skill_script` 跑 Agent Motion 的 `scripts/`（技能目录里没有这些文件）。
- 不要把 SKILL.md 当成功交付：必须检查真实 MP4 与预览。
- 未配置 `AGENT_MOTION_ROOT` 时，先提示用户运行安装脚本，不要假装能制作。
