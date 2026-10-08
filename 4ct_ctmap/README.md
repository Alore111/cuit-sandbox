# 4ct_ctmap · 校园沙盘（前端）

把校园的平面轮廓、地皮与类型字典全部当作**数据**，在浏览器里堆成一个可交互的校园沙盘。
数据驱动：换学校、加建筑类型、改分辨率都只改后端 `data/*.json`，不动代码。

- 沙盘页：`/`
- 编辑器：`/editor`（纯前端路由，按 `window.location.pathname` 分流）

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript + Vite + Zustand |
| 3D | three.js 直用（无 R3F） |
| 后端 | 独立包 `../4ct_ctmap_server`（Node + Express，数据存 JSON），路由前缀 `/api/map` |
| 契约 | 前后端**各持一份逐字一致的副本**：本目录 `src/contract/` ↔ 后端 `src/contract/` |
| 主题 | 夜晚 / 白天两套色板（`night` / `day`），UI 与 3D 场景同步切换 |

## 快速开始

```bash
npm install

npm run dev:all      # 同时起后端(3001) 与前端(5173)
# 沙盘：http://localhost:5173/
# 编辑器：http://localhost:5173/editor

npm run dev          # 只起前端
npm run dev:server   # 只起后端
npm run check        # 无头自检：走 HTTP 拉数据 → 世界构建，打印统计与告警（需后端在跑）
npm run check:campus # 校园视觉自检（node --test）
npm run basemap      # 生成编辑器底图（走 HTTP 取岛面轮廓拼影像瓦片，需后端在跑）
npm run typecheck    # 类型检查
npm run build        # 构建前端到 dist/
```

**调试建议**：涉及数据、栅格化、体量、色板、岛体的改动，先跑 `npm run check`。
它走 `/api/map/*` 的 5 个读接口（与浏览器同一条链路，**后端要先起**，连不上会明确报错退出），
把网格尺寸、地皮占比、体量分布、体素规模、生成高度 Top、**形制自检**（体素是否都落在足迹内）、
倒锥岩层、路灯与装饰数量、渲染告警、主题切换耗时一次性打出来，比开浏览器截图快得多。
浏览器只在需要确认最终观感与交互时打开（用 Chrome DevTools MCP：截图 + console + network）。

**部署提示**：静态托管侧需要把未知路径回退到 `index.html`（SPA fallback），
否则直接访问 `/editor` 会 404。后端只提供接口，不托管前端产物。

## 目录结构

```
src/
  contract/   契约副本（类型 + 常量 + 纯函数，与后端同名文件必须逐字一致）
  api/        API 层：端点定义 + 响应壳解包（失败一律抛错，不兜底）
  auth/       adminKey：编辑页写接口的管理员密钥（X-Admin-Key，存 sessionStorage）
  services/   服务层：数据集编排、主题读写、编辑器取数与写回、事件代理消费
  store/      状态层：mapStore（数据/状态/告警）、selectionStore、uiStore、locateStore
  render/     渲染层：three.js 世界；只认「语义色键」，不认具体颜色
    theme/    昼夜两套色板
    sky/      天空穹顶、云、星空、日月
    view/     聚焦补间与四个预设机位
    voxel/    体素模型与 InstancedMesh 构建
    world/    栅格化、地表、岛体倒锥、路灯、装饰物、建筑体量（massing/）、世界装配
    campus/   热力光晕
  ui/         UI 层：HUD 组件、hooks、CSS 令牌（沙盘页）+ mobile/ 移动端布局
  editor/     编辑器页：图层树、编辑画布、属性面板、属性表、状态栏、撤销栈
  types/      前端跨层类型（主题名、视角预设、世界统计、渲染告警）
  utils/      坐标换算、格式化、地理计算
public/
  data/       后端不可达时的静态降级副本（加工后的 Building[]/Parcel[]）
  basemap/    编辑器卫星底图（scripts/fetch-basemap.ps1 的产物，静态资源不走接口）
scripts/
  check-world.ts       无头自检（走 HTTP 取数）
  check-campus-visuals.ts  校园视觉自检
  fetch-basemap.ps1    拼编辑器底图
```

依赖方向严格单向：`utils → api → services → store → ui`，渲染层只依赖 `utils`/`contract`，
`ui` 不得直接 `fetch`，任何一层都不 import 后端源码。

## 数据流与降级

`mapService` 优先走后端 `/api/map/*`；后端不可达时降级读 `public/data/` 下的静态 JSON。
降级副本是「真源的第 N 份快照」：改了后端 `data/` 后要在后端包跑
`scripts/export-dataset.mts` 重新导出，别让降级时读到旧数据。

## 契约与错误口径

- 响应壳统一为 `{ success, message, data }`；
- 数据非法（字段缺失、id 重复、类型不存在、`*Meters` 参数非正数…）→ 接口 `success:false`，
  前端进全屏错误遮罩，**不做任何兜底**；
- 数据合法但栅格化后一格都出不来 → 渲染层汇总为「数据告警」，HUD 右上角可展开，
  不静默丢弃（岛缘小建筑落在岛面外、碎岩跑出网格同样显性化）；
- 色板缺 `paletteKey`、地皮 / 岩层配色缺失、类型主色调不是 `#rrggbb` → 构建世界时直接抛错
  （宁可启动失败，也不静默用灰色）。

### 契约同步（改契约时必看）

`src/contract/` 与后端 `../4ct_ctmap_server/src/contract/` 是**两份逐字一致的副本**。
改一处必须两边一起改，分叉时不会有任何报错 —— 只会让校验与渲染对同一条数据理解悄悄不一样。
改完用文本比对确认：

```powershell
Compare-Object (Get-Content src/contract/types.ts) (Get-Content ../4ct_ctmap_server/src/contract/types.ts)
```

## 数据维护（改的是后端真源）

### 换学校

改后端 `../4ct_ctmap_server/data/school.json`：

```jsonc
{
  "name": "成都信息工程大学",
  "campusName": "航空港校区",
  "brandMark": "信",                    // HUD 徽标上的字
  "title": "成都信息工程大学 · 微校园沙盘",
  "voxelMeters": 2,                     // 单个体素边长（米）——分辨率
  "gridPaddingMeters": 6,               // 网格在岛面轮廓外留的余量
  "defaultTerrainTypeKey": "grass",     // 岛面内未被地皮覆盖处铺什么
  "boundary": [[lat, lon], ...],        // 数据编制范围：转换脚本据此过滤校外要素
  "island": {
    "outline": [[lat, lon], ...],       // 岛面轮廓：决定铺装范围与网格尺寸
    "noiseMeters": 55,                  // 记录用：轮廓扰动的基准幅度（轮廓已固化）
    "rockLayers": [                     // 岛面以下的岩层（自上而下）；总厚 = 岛体总深
      { "thicknessMeters": 22, "paletteKey": "soil" },
      { "thicknessMeters": 154, "paletteKey": "rockDeep" }
    ],
    "rimProps": [{ "id": "rim-1", "kind": "pavilion", "lat": 30.58, "lon": 103.98 }],
    "debris": [{ "id": "debris-1", "lat": 30.586, "lon": 103.99,
                 "depthMeters": 92.9, "sizeMeters": 15.7 }]
  }
}
```

`voxelMeters` 是唯一的分辨率开关：调小则更细（体素量按平方/立方增长），
所有质感参数（窗带间隔、天桥尺寸、路灯间距…）都按米定义，会自动折算，不需要改代码。

### 加建筑类型

在 `data/dictionaries/building-types.json` 的 `types` 里加一项，并在本包
`src/render/theme/palette.ts` 里补一组同 `paletteKey` 的配色（两套主题各一组）。
若用到新的体量做法，需要在 `src/render/world/massing/` 里加实现并注册。

### 类型主色调（墙面 / 暗部）

每个类型可给可选的 `wallColor` / `roofColor`（`#rrggbb`，契约里的 `HEX_COLOR_PATTERN`
前后端共用，格式不对后端拒绝写盘、前端抛错）：

- **只填一份日景色**：墙暗部与夜景由 `palette.ts` 的 `applyBuildingTint` 派生
  （墙暗部 = 降明度降饱和；夜景 = 压明度轻降饱和）；
- **留空 = 跟随色板**：不写（或 `null`）则完全用 `paletteKey` 配色组，两个字段可只填一个；
- **类型级、不逐栋**：同类型颜色一致，与 `floors` / `massingParams` 的逐栋覆盖无关；
- 腰线 / 矮栏（`trim`）不跟主色调走，仍由色板给。

在 `/editor` 的「类型配色」面板可直接改、看效果。

### 几何参数一律以米为单位

`massingParams` 里的长度参数必须带 `Meters` 后缀，例如天桥：

```jsonc
"skywalk": {
  "label": "天桥", "floors": 2, "floorHeight": 3, "massing": "skywalk", "paletteKey": "skywalk",
  "massingParams": {
    "deckThicknessMeters": 2,     // 桥面（顶部平板）厚度
    "pillarSpacingMeters": 16,    // 立柱沿走向的间距
    "pillarSizeMeters": 2,        // 立柱截面边长
    "railHeightMeters": 2         // 桥面边缘矮栏高度
  }
}
```

天桥高度与其他建筑同一口径（`floors × floorHeight`）；桥面水平范围即足迹范围。

## 渲染要点

### 悬空小岛：岛面以下的岩体

- **岛面轮廓**由转换脚本做确定性扰动生成后落地到 `island.outline`（230 点），
  渲染层只读不算：每次打开形状完全一致；
- **岛体只发一层表面壳，不填实心**：深 400 m（200 格），用一张**深度场**描述 ——
  `depthOf(格)` = 该格岩面在岛面以下第几层；发射规则只有两条（每格发自己岩面那片 +
  相邻格深 2 层以上时竖直补岩壁），实测岛体 33 万体素；
- **深度场 = 主轮廓 + 扇区棱面 + 崩口 + 岩根**（参数在 `src/render/constants.ts` 的 `ISLAND_BODY`）：
  幂曲线收束 + 每层底界留平台（千层岩）、18 扇区棱面、5 处崩口、锥底齿状岩根；
- **岛底云霭** `ISLAND_MIST` + **碎岩 / 云霭极慢漂移** `ISLAND_DRIFT`
  （`prefers-reduced-motion` 时完全静止）；
- 岛缘小建筑只实现了 `pavilion`（亭）与 `tower`（塔）；`rimProps` 写别的 kind 会被后端拒绝；
- 岛下碎岩数据只给方位 / 深度 / 大小，水平落点由渲染层现算，剖面改了不必重算数据。

### 路灯、花草与生物

- 路灯：地皮字典 `streetLamp` 为 true 的路（本期 `concreteRoad`），每 32 m 断面两侧各一盏，
  灯高 4 m，灯头自发光（夜里吃满 Bloom，白天压到近 0）；
- 花草长在 `groundCover` 且无树冠的地表，按坐标哈希决定落点与株高；
- 飞鸟昼夜绕岛盘旋，萤火虫只在夜里亮；
- 全部确定性散布：不使用 `Math.random`，同一份数据每次打开位置一致。

### 昼夜光影

只有 `night` / `day` 两档，刻意不做时间轴 / 自动循环：
沙盘是「看一版数据的样子」，不是天文模拟。

## 编辑器（/editor）

编辑工具按 **ArcMap 的编辑工具条**组织：先分「看」与「改」，再谈具体操作。

### 工具（顶部第二行）

| 工具 | 能做什么 |
| --- | --- |
| 浏览 | 拖拽平移、滚轮缩放、点击识别；**不改数据** |
| 选择 | 点击选中、Shift 加选、拖轮廓内部整体平移、拖空白框选 |
| 编辑顶点 | 拖顶点改点、拖线段插入并拖动新点、点击选点、Delete 删点、方向键微调、F2 完成 |
| 新建要素 | 逐点点击落顶点，双击 / F2 / Enter 完成，Backspace 退一点，Esc 取消 |

**视图在任何工具下都能用**：滚轮缩放（以光标为锚点）、中键拖拽平移、按住 **空格** 或 **Alt**
临时切到平移。双击对象直接进入顶点编辑（与 ArcMap Edit 工具一致）。

### 框选的两个方向（ArcGIS 既有习惯）

- **左→右**拖：只选中**完全落在框内**的对象（实线框）；
- **右→左**拖：**相交即选中**（虚线框），包括把整个框包住的大地皮。

### 捕捉

默认开启，状态栏可一键关。捕捉目标 = 其他对象的顶点与线段，以及**正在编辑对象自身**的
顶点与线段（相邻地皮公共边对齐靠后者）。顶点优先于线段；命中有紫色符号与十字准星提示。
【口径】「悬停的捕捉符号」与「按下去能抓到什么」用**同一个半径**，符号不会指向抓不到的点。

### 三栏 + 底部抽屉

- **左：图层树**。只列图层（建筑 / 地皮 / 岛面轮廓 / 参考网格 / 卫星底图），
  带显隐开关与「定位」；行数恒定，不随校园规模膨胀。
- **中：编辑画布**。左上角状态提示，左下角光标读数（本地米 + 经纬度 + 比例尺），右键上下文菜单。
- **右：属性面板**。改当前编辑对象的名称 / 类型 / 体量做法 / 层数 / 层高 / 逐栋参数，
  以及轮廓点数与面积周长。
- **底：属性表**（工具栏开合）。逐要素浏览与批量修改：点表头排序、点行选中（Shift 加选）、
  双击行缩放至要素、选中后顶部批量改属性。**按名称 / id / 类型找对象**也从这里走。
- **底：类型配色**（工具栏开合）。一行一个类型，墙 / 顶取色器 + 当前值 + 「跟随色板」按钮。
  改的是**类型字典**，同类型楼一次全变。
  两个底部抽屉**同一时刻只开一个**；取色过程不记撤销栈，松手时补记一次。

### 可改什么

- 建筑：轮廓、名称、类型、体量做法、层数、层高、逐栋体量参数；
- 地皮：轮廓、名称、类型；
- 建筑类型字典配色（走「类型配色」面板）；
- 岛面轮廓（`school.json` 的 `island.outline`）—— 它是地表铺装范围与网格尺寸的来源，
  改完保存后整座岛重新栅格化（建筑与地皮不动，但落在岛面外的格子不再出图）。

### 撤销 / 重做与保存

- `Ctrl+Z` / `Ctrl+Y`（或 `Ctrl+Shift+Z`），深度 60；快照存**内存文档**，与磁盘无关。
  拖动过程不记栈，抬手时记一次；
- **脏标记与撤销栈无关**：由「当前文档与后端读回的那份逐文件引用比较」得出，
  撤销回原样时「有未保存的改动」自动消失；
- 四份文件分别覆盖写回（`PUT /api/map/buildings|parcels|school|dictionaries`），**只写改过的**；
  后端先校验后写盘并留 `.bak`；
- 编辑器读**原始 JSON**（`GET /api/map/raw/:file`），不读读接口（原因见后端 README）。

> **写接口鉴权**：走 `X-Admin-Key`（与后端 `CTMAP_ADMIN_KEY` 比对），
> 密钥由用户在编辑页录入、存 sessionStorage。未配置密钥时后端写接口不鉴权并打警告，
> **部署到公网前必须在后端配置 `CTMAP_ADMIN_KEY`**。

### 卫星底图

- 底图是**离线拼接的单张影像**，`npm run basemap` 生成：按 `GET /api/map/school` 的
  `island.outline` 算范围、外扩 120 m，拉影像瓦片拼成 `public/basemap/aerial.jpg`，
  并写像素坐标系元数据 `src/editor/basemap.generated.ts`；
- 生成时需要联网，运行时不依赖外网；`scripts/.basemap-cache/` 是瓦片缓存（已忽略）；
- 底图是**前端静态资源**，不走 `/api/map` —— 删除底图不影响任何接口。

## 已知数据缺口

| 项 | 现状 |
| --- | --- |
| 沥青道路 | 类型已就绪，占比 0%；需要时补录多边形即可 |
| 天桥 | 1 条人工拟定的示例轮廓，需按实际替换或删除 |
| 建筑高度 | 按类型经验层数推定，数据源无实测高度 |
| 屋面剖面 | 由 `ROOF_EDGE_RUN` / `ROOF_CENTER_RUN` / `ROOF_MIN_LAYERS` / `ROOF_OVERHANG` 控制 |
| 昼夜光影 | 只有 `night` / `day` 两档 |

## 数据来源

后端 `data/*.json` 是唯一真源，为**一次性转换**产物（来源与重跑方式见后端 README
「数据维护」）。
