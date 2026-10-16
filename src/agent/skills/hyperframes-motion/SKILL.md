---
name: hyperframes-motion
description: 用本机 HyperFrames 动效服务制作数据动效、全国/省级地图动效与标题卡（HTML+GSAP，离线渲染 MP4），再把成片导入 OpenChatCut 素材池继续剪辑。
---

# HyperFrames 动效桥接

地图场景使用工作室独立 starter `map-scene-sequence`。先 scene_catalog / scene_get；scene_plan({revision,commands}) 规划，scene_apply({revision,planId})应用，scene_undo撤销。先读 blocks/map-scene-sequence/README.md；按稳定sceneId局部修改，未知地名不猜坐标，精修源码仅在用户明确授权时regenerate。此能力没有GeoLayers/AE运行依赖。

本技能通过 `hyperframes_motion` 工具调用本机 `dtb_media_studio/hyperframes_worker`（默认 `127.0.0.1:8794`）。HyperFrames 不嵌进时间线引擎：工程与渲染在 worker 里，成片用 `action=import` 进入素材池。

## 前置条件

1. 已运行 `dtb_media_studio/scripts/setup-hyperframes.sh`，`opencut_os/.env.local` 含 `HYPERFRAMES_WORKER_URL` 与 `HYPERFRAMES_WORKER_TOKEN`。
2. `dtb_media_studio/launch.sh start motion` 已启动 worker。先 `hyperframes_motion(action="status")` 自检，`renderReady=false` 时提示用户安装，不要假装能制作。

## 推荐流程

1. `action="catalog"` 看模板。地图帮常用：
   - `geo-camera-story`：多地点镜头；`route-replay`：GPX/GeoJSON/CSV 轨迹；`geo-time-series`：固定尺度的时期数据地图。须读对应 README，声明坐标系与真实/示例来源；无时间不可冒充记录回放。标准模板无需模型生成视频。
   - `china-map`：全国省级分级设色 + 高亮 + 飞线 + Top 排行。
   - `province-map`：全国省市县预置边界。先 `action="map_sources", query="四川"` 查询，`props.region="510000"` 即切四川 21 市州，无需上传。切换地区清除原地区统计，先展示行政区地图；业务数据由用户提供，禁止移用原省数字或编造统计。
   - `title-card`：标题卡。`blank`：自主写 HTML。
   读 `action="library", path="blocks/<id>/README.md"` 了解 props。
2. 只换数据/文案：`action="create"`，`starter` + `props`（`title`、`subtitle`、`data`、`unit`、`highlight`、`routes`、`topN`）。之后用 `action="update"` 带 `revision` 改 props。
3. 自主创作：先读 `skills/hyperframes/SKILL.md`、`docs/compositions.md`、`docs/gsap.md`，再 `action="write_files"` 写 `index.html` / `compositions/`。只用本地 `assets/_dtb/gsap.min.js`、`assets/_dtb/fonts.css`；禁止外链、`Date.now()`、`Math.random()`。返回的 `lint.findings` 有 error 先修。
4. `action="render", kind="preview", frame=N` 出关键帧，必要时让用户看。
5. `action="render", kind="delivery"` 出 MP4；`action="job"` 查进度（间隔至少几秒，不要轮询风暴）。
6. 状态为 `rendered`/`completed` 后 `action="import", jobId=...` 导入素材池，再按需用时间线工具上轨。不要声称已自动上时间线。
7. 用户想可视化微调时 `action="editor"` 返回本机 Studio 地址；Studio 的保存会让 revision 递增，渲染前先 `action="get"`。

## 禁止

- 不使用 HeyGen 云渲染，不把本地渲染说成云端生成。
- 不把 SKILL.md 当交付：必须有真实 MP4（job 回执）并导入素材池。
