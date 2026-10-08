# 4ct_map · 校园沙盘（微校园 3D 可视化）

把一所校园的建筑、地皮与地形当作**数据**，在浏览器里堆成一座可交互的 3D 沙盘岛屿：
拖拽浏览、点击看建筑详情、搜索定位、昼夜切换，还带一个 **ArcMap 风格的在线编辑器**，
不写代码就能改建筑轮廓、类型与配色。换学校只改 JSON，不动代码。

**在线浏览**：<https://cuit.can6.top/>

**本地预览**：克隆后 `cd 4ct_ctmap && npm install && npm run dev:all`，
浏览器打开 <http://localhost:5173/>（编辑器在 `/editor`）。

## 特性

- **数据驱动**：学校信息、建筑轮廓、地皮、类型字典全部由后端 JSON 下发，换学校只改数据；
- **体素沙盘渲染**：three.js 直用（无 R3F），悬空小岛 + 千层岩倒锥岛体 + 路灯花草飞鸟，
  全部确定性散布（不使用 `Math.random`，每次打开形状一致）；
- **昼夜双主题**：`night` / `day` 两套色板，UI 与 3D 场景同步切换；
- **在线编辑器**（`/editor`）：图层树 + 编辑画布 + 属性面板 + 属性表 + 类型配色，
  支持顶点编辑、吸附捕捉、框选（ArcGIS 左右拖方向语义）、撤销重做（深度 60）；
- **无头自检**：`npm run check` 走 HTTP 拉数据构建世界，打印统计与告警，不开浏览器；
- **校园实况**：可配置第三方事件接口，由后端代理拉取（Token 不进浏览器）。

## 仓库结构

```
4ct_map/
├─ 4ct_ctmap/           前端：React 18 + TypeScript + Vite + Zustand + three.js
│  └─ README.md         开发者文档（分层架构、渲染要点、编辑器交互口径）
├─ 4ct_ctmap_server/    后端：Node + Express + TypeScript，数据存 JSON
│  └─ README.md         开发者文档（接口一览、鉴权、数据维护）
└─ README.md            本文件
```

| 目录 | 说明 |
| --- | --- |
| [`4ct_ctmap/`](./4ct_ctmap/) | 沙盘页 + 编辑器，分层 `utils → api → services → store → ui`，渲染层独立 |
| [`4ct_ctmap_server/`](./4ct_ctmap_server/) | 数据唯一真源 `data/`，接口前缀 `/api/map` 等，先校验后写盘 |

## 快速开始

```bash
cd 4ct_ctmap
npm install
npm run dev:all      # 同时起后端(3001) 与前端(5173)
```

- 沙盘：<http://localhost:5173/>
- 编辑器：<http://localhost:5173/editor>
- 接口自测：<http://localhost:3001/api/map/school>

想单独运行某一层、了解目录结构、开发新建筑类型，看对应包的 README：

- 前端：[4ct_ctmap/README.md](./4ct_ctmap/README.md)
- 后端：[4ct_ctmap_server/README.md](./4ct_ctmap_server/README.md)

## 技术选型

| 层 | 选型 |
| --- | --- |
| 前端 | React 18 · TypeScript · Vite · Zustand · three.js |
| 后端 | Node · Express · TypeScript（tsx 直跑）· JSON 文件存储 |
| 契约 | 前后端各持一份逐字一致的 `src/contract/`，独立安装、独立部署 |

## 注意事项

- **先起后端再起前端**，否则前端取数失败（自检 `npm run check` 同样需要后端在跑）；
- 编辑页写接口靠 `X-Admin-Key` 鉴权，密钥来自后端环境变量 `CTMAP_ADMIN_KEY`，
  未配置时写接口不鉴权（仅限本地开发）—— **公网部署前必须配置**，见后端 `.env.example`；
- 编辑器保存会直接覆盖后端 `data/*.json`（写前自动备份 `.bak`）；
- 静态部署前端时需配置 SPA fallback（未知路径回退 `index.html`），否则直接访问 `/editor` 会 404。
