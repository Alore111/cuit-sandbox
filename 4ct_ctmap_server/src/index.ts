/* dotenv 必须在读取任何 process.env 之前加载，使 .env 里的变量生效 */
import 'dotenv/config';
import express from 'express';
import { loadMapDataset } from './loaders/mapDataset';
import { errorHandler, notFound } from './middleware/response';
import { campusLiveRouter } from './routes/campusLive';
import { mapRouter } from './routes/map';
import { eventConfigRouter } from './routes/eventConfig';
import { searchRouter } from './routes/search';

const PORT = Number(process.env.PORT ?? 3001);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32mb' }));

app.use('/api/map', mapRouter);
app.use('/api/event-config', eventConfigRouter);
/* 校园实况事件代理：前端统一从这里取，不再直连第三方（防 Token 泄露） */
app.use('/api/campus-live', campusLiveRouter);
/* 统一搜索：地点（建筑/地皮/词典）+ 事件，地点优先，按匹配度排序 */
app.use('/api/search', searchRouter);

/* 只提供接口，不托管前端：前端由 vite dev server 或独立静态部署承担 */
app.use(notFound);
app.use(errorHandler);

app.listen(PORT, () => {
    console.info(`[4ct-map] 服务已启动：http://127.0.0.1:${PORT}/api/map`);
});

/* 启动自检：数据有问题立刻打在日志里。不阻止服务启动 —— 修好 JSON 刷新页面即可生效 */
loadMapDataset()
    .then((dataset) => {
        console.info(
            `[4ct-map] 数据就绪：${dataset.school.name}${dataset.school.campusName}` +
                ` · 建筑 ${dataset.buildings.length} 条 · 地皮 ${dataset.parcels.length} 条` +
                ` · 体素 ${dataset.school.voxelMeters}m · 数据版本 ${dataset.manifest.version}`
        );
    })
    .catch((error: unknown) => {
        console.error(
            '[4ct-map] 启动自检失败：',
            error instanceof Error ? error.message : String(error)
        );
    });
