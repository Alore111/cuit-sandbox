import { Fragment } from 'react';
import { MASSING_LABELS } from '../../render/world/massing';
import { useMapStore } from '../../store/mapStore';
import { useSelectionStore } from '../../store/selectionStore';
import { formatCount } from '../../utils/format';
import styles from '../styles/hud.module.css';

/**
 * 选中建筑详情。
 * 高度一律给两行：「推定高度」是数据口径（层数 × 层高），「生成高度」是实际堆出来的格数 ×
 * 体素边长 —— 量化误差与冠部/矮栏超出名义高度的部分，一眼可见。
 */
export function BuildingDetailCard() {
    const selectedId = useSelectionStore((state) => state.selectedId);
    const select = useSelectionStore((state) => state.select);
    const dataset = useMapStore((state) => state.dataset);
    const world = useMapStore((state) => state.world);

    if (!selectedId || !dataset) return null;

    const building = dataset.buildings.find((item) => item.id === selectedId);
    if (!building) return null;

    const runtime = world?.buildingRuntime[building.id];
    const voxelMeters = dataset.school.voxelMeters;
    const handTuned = building.overriddenFields.some(
        (field) => field === 'floors' || field === 'floorHeight'
    );

    const rows: [string, string][] = [
        ['层数 / 层高', `${building.floors} 层 × ${building.floorHeight} m`],
        ['推定高度', `${building.heightMeters.toFixed(1)} m`],
        [
            '生成高度',
            runtime
                ? `${runtime.apexVoxels} 格 = ${(runtime.apexVoxels * voxelMeters).toFixed(0)} m`
                : '未生成（见数据告警）'
        ],
        ['高度来源', handTuned ? '数据逐栋指定' : '按建筑类型经验值'],
        ...(runtime
            ? ([
                  ['占地面宽', `${runtime.footprint.width} × ${runtime.footprint.depth} 格`],
                //   ['体素数量', `${formatCount(runtime.voxelCount)} 块`]
              ] as [string, string][])
            : []),
        ['占地面积', `${formatCount(building.areaM2)} m²`],
        // [
        //     '数据编号',
        //     building.source === 'manual' ? `人工录入 ${building.id}` : `way/${building.id}`
        // ]
    ];

    return (
        <aside className={`${styles.panel} ${styles.detail}`}>
            <button
                type="button"
                className={styles.detailClose}
                onClick={() => select(null)}
                aria-label="关闭详情"
            >
                ×
            </button>
            <div className={styles.detailType}>
                {building.typeLabel} / {MASSING_LABELS[building.massing]}
            </div>
            <h2 className={styles.detailName}>
                {building.name || `${building.typeLabel}（未命名）`}
            </h2>
            <dl className={styles.detailGrid}>
                {rows.map(([key, value]) => (
                    <Fragment key={key}>
                        <dt>{key}</dt>
                        <dd>{value}</dd>
                    </Fragment>
                ))}
            </dl>
            {/* <p className={styles.detailNote}>
                {building.source === 'manual'
                    ? '平面轮廓由人工录入。'
                    : `平面轮廓与名称来自 ${dataset.school.attribution}`}
                {dataset.school.heightNote}
            </p> */}
        </aside>
    );
}
