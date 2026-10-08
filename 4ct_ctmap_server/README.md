# 4ct_ctmap_server · 校园沙盘后端

数据与接口层：**数据的唯一真源在这里**，前端只读它下发的结果。
路由 → 数据装配（类型推断 + 形制合成）→ 校验 → 落盘，全部围绕 `data/` 里的 JSON。

- 运行时：Node + Express + TypeScript（`tsx` 直跑，无需编译）
- 数据存储：纯 JSON 文件（无数据库），`data/` 是唯一真源
- 接口前缀：`/api/map`、`/api/event-config`、`/api/campus-live`、`/api/search`
- 响应壳：`{ success, message, data }`

## 快速开始

```bash
npm install

cp .env.example .env        # 按需填写，.env 已被忽略，勿提交真实密钥
npm run dev                 # tsx watch 启动，默认 http://127.0.0.1:3001

npm run typecheck           # 类型检查
npm start                   # 非 watch 启动
```

默认端口 `3001`（`PORT` 可改）。前端 vite 已把 `/api` 代理到这里，
因此**先起本服务，再起前端**，否则前端取数会失败。

启动时会做一次数据自检并把结果打进日志（建筑 / 地皮条数、体素分辨率、数据版本）；
自检失败只报错、不阻止启动 —— 修好 JSON 刷新即可生效。

## 环境变量

见 [.env.example](./.env.example)：

| 变量 | 说明 |
| --- | --- |
| `PORT` | 监听端口，默认 `3001` |
| `CTMAP_ADMIN_KEY` | 编辑页**写接口**共享密钥。请求头 `X-Admin-Key` 必须等于它 |

**鉴权口径**：密钥**没有内置默认值**（写死密钥等于假安全）。
未配置时写接口放行但启动会打印警告；一旦配置即严格校验，不匹配返回 `401`。
生产 / 公网部署**必须**设置一个足够长的随机串。

## 目录结构

```
src/
  contract/        契约副本（类型 + 常量 + 纯函数，与前端 ../4ct_ctmap/src/contract/ 逐字一致）
  loaders/         jsonStore（按 mtime 缓存 JSON 读写）、mapDataset（数据集装配）
  middleware/      auth（写接口鉴权）、response（统一响应壳与错误码）
  routes/          map / eventConfig / campusLive / search
  validate/        结构与取值校验（错误信息带 id 与字段名）
  utils/           坐标换算、地点词典
  errors.ts        数据错误类型
  index.ts         入口：装配路由 + 启动自检
data/              数据唯一真源（school / buildings / parcels / dictionaries / places / manifest / event-config）
scripts/           convert-osm.mjs（一次性数据转换）、export-dataset.mts（导出前端降级副本）
```

依赖方向单向：`routes → loaders → validate → contract`，任何一层不 import 前端源码。

## 接口一览

### `/api/map` — 地图数据

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/school` | 否 | 学校信息与岛面轮廓 |
| GET | `/buildings` | 否 | 建筑（已按类型字典**合成**） |
| GET | `/parcels` | 否 | 地皮 |
| GET | `/dictionaries` | 否 | 建筑 / 地形类型字典 |
| GET | `/manifest` | 否 | 数据版本 |
| GET | `/places` | 否 | 地点词典（地理位置匹配） |
| GET | `/auth-check` | `X-Admin-Key` | 编辑登录检测，仅鉴权不改数据 |
| GET | `/raw/:file` | 否 | 读**原始 JSON**（`file` ∈ `school` / `buildings` / `parcels` / `dictionaries`） |
| PUT | `/buildings` | `X-Admin-Key` | 整份写回，先校验后写盘，原文件备份 `.bak` |
| PUT | `/parcels` | `X-Admin-Key` | 同上 |
| PUT | `/school` | `X-Admin-Key` | 同上（岛面轮廓） |
| PUT | `/dictionaries` | `X-Admin-Key` | 同上，额外在新字典下重跑合成，拦住「删掉仍被引用的类型」 |
| PUT | `/places` | `X-Admin-Key` | 同上 |

> **为什么编辑器读 `/raw/:file` 而不是读接口**：读接口返回的是**已合成**的
> `Building`（`typeKey` / 层数 / 形制都按字典补齐），拿它回写会把「未覆盖」
> 写成「显式覆盖」，逐栋参数从此锁死。原始 JSON 才是可编辑的真源。

### `/api/event-config` — 事件接口配置

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | 否 | 读 `data/event-config.json`（不存在则 404，不兜底） |
| PUT | `/` | `X-Admin-Key` | 整份覆盖写，写前补 `savedAt`，备份 `.bak` |

### `/api/campus-live` — 校园实况事件代理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/events` | 统一事件列表（服务端代理 + 缓存）。未配置 URL → 返回空数组 |
| GET | `/events/:id` | 详情代理；未启用详情端点则回退列表缓存项 |

前端**不直连第三方**，Token 只存在于本服务的 `event-config.json`，不下发浏览器。

### `/api/search` — 统一搜索

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/?q=关键词` | 地点（建筑 / 地皮 / 词典）+ 事件，地点优先，按匹配度降序 |

## 数据维护

### 换学校 / 改数据

`data/school.json` 是学校信息与岛面轮廓的真源，`data/dictionaries/` 是类型字典。
改字段含义前先看契约 `src/contract/`（前后端各一份，必须逐字一致）。

### 重新生成数据（会覆盖）

`data/*.json` 是**一次性转换**的产物，来源为 OSM 抓取结果。重新生成：

```bash
node scripts/convert-osm.mjs
```

转换三条口径：

- **编制范围**：只保留重心落在 `school.boundary` 内的要素；
- **道路是折线**：按类型给典型宽度（或用 OSM `width` 标签）缓冲成多边形再落地皮；
- **岛面轮廓与装饰物位置**在脚本里生成后落地，渲染层只读不算 —— 形状必须每次一致。

> 编辑器保存会直接改 `buildings.json` / `parcels.json`（留 `.bak`）；
> 之后再跑转换脚本会覆盖这些人工改动。

### 导出前端静态降级副本

前端在后端不可达时会降级读 `../4ct_ctmap/public/data/` 下的静态 JSON，
副本需在本包用真源加工生成（不能直接拷贝原始条目）：

```bash
.\node_modules\.bin\tsx.cmd scripts/export-dataset.mts
```

改了 `data/` 后记得重跑一次，别让降级时读到旧数据。

## 契约同步（改契约时必看）

`src/contract/` 与前端 `../4ct_ctmap/src/contract/` 是**两份逐字一致的副本**。
代价是改一处必须两边一起改，且分叉时**不会报错** —— 只会让校验与渲染对同一数据理解不一致。
改完用文本比对确认：

```powershell
Compare-Object (Get-Content src/contract/types.ts) (Get-Content ../4ct_ctmap/src/contract/types.ts)
```

## 错误口径

- 数据非法（字段缺失、id 重复、类型不存在、`*Meters` 非正数…）→ `success:false`，
  前端进全屏错误遮罩，**不做兜底**；
- 写接口一律**先校验后写盘**，校验走与读接口相同的代码路径：
  「写盘通过」等价于「下次一定读得出来」，失败则不落盘。
