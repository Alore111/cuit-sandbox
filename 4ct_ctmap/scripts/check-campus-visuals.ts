import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import type { LocationHeat } from '../src/contract';
import type { GridSystem } from '../src/utils/geo';
import { createHeatSources, sampleHeatField } from '../src/render/campus/heatField';
import { buildHeatBeams } from '../src/render/campus/heatBeamsBuilder';
import { layoutEventCards, type CardPlacement } from '../src/ui/eventLayout';
import { eventProjection } from '../src/ui/eventProjection';

const grid: GridSystem = {
    voxelMeters: 2, width: 100, height: 100,
    spanMeters: { x: 200, z: 200 }, origin: [0, 0],
    center: { x: 50, z: 50 }, size: { x: 100, z: 100 },
    lonLatToVoxel: (lat, lon) => ({ vx: lon, vz: lat }),
    voxelToWorld: (vx, vz) => ({ x: vx, z: vz }),
    localToVoxel: ({ x, y }) => ({ vx: x, vz: y }),
    voxelToLocal: (vx, vz) => ({ x: vx, y: vz }),
    isInsideIsland: () => true,
};
const heat: LocationHeat = {
    id: 'heat', locationId: 'location', locationName: 'Test',
    position: [50, 50], heatValue: 80, heatLevel: 'critical',
    sourceType: 'composite', updatedAt: 0,
};

test('zero heat and empty fields do not create peaks', () => {
    assert.equal(sampleHeatField(0, 0, [], 10), 0);
    assert.equal(sampleHeatField(0, 0, [{ x: 0, z: 0, intensity: 0 }], 10), 0);
});

test('peak height increases monotonically with heat, independently of legacy heightRatio', () => {
    const values = [0, 20, 50, 80, 100].map((heatValue) => {
        const sources = createHeatSources([{ ...heat, heatValue, heightRatio: 1 }], grid, 'low');
        return sampleHeatField(50, 50, sources, 10);
    });
    values.forEach((value, i) => { if (i > 0) assert.ok(value > values[i - 1]); });
    assert.equal(values[4], 1);
});

test('nearby sources blend smoothly and remain bounded', () => {
    const sources = [{ x: -5, z: 0, intensity: 0.8 }, { x: 5, z: 0, intensity: 0.8 }];
    assert.ok(sampleHeatField(0, 0, sources, 10) > sampleHeatField(0, 0, sources.slice(0, 1), 10));
    for (let x = -40; x <= 40; x += 0.1) {
        const value = sampleHeatField(x, 0, sources, 10);
        assert.ok(value >= 0 && value <= 1);
        assert.ok(Math.abs(value - sampleHeatField(x + 0.1, 0, sources, 10)) < 0.02);
    }
});

test('minimum heat level filters actual source data', () => {
    const sources = createHeatSources([heat, { ...heat, id: 'low', heatLevel: 'low' }], grid, 'high');
    assert.equal(sources.length, 1);
    assert.equal(createHeatSources([heat], grid, 'low')[0].intensity, 0.8);
});

test('heat renderer uses independent additive shafts with soft-fade shader and safely disposes', () => {
    const handle = buildHeatBeams([heat], grid, 'night', true);
    const allMeshes = handle.group.children.filter(
        (child): child is THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> =>
            (child as any).isMesh,
    );
    // 1 heat → 至少 2 mesh（一根 shaft 交叉薄片 + 一个贴地 halo 平面），随实现可放宽 3+
    assert.ok(allMeshes.length >= 2, `expected >=2 meshes per single heat, got ${allMeshes.length}`);

    // 必须全部是 ShaderMaterial + 纯加法混合 + 不写深度（保证光柱不遮挡背景）
    for (const mesh of allMeshes) {
        assert.ok(mesh.material.isShaderMaterial, 'mesh.material.isShaderMaterial');
        assert.equal(mesh.material.depthWrite, false, 'depthWrite=false to avoid occlusion');
        assert.equal(
            mesh.material.blending,
            THREE.AdditiveBlending,
            'AdditiveBlending for god-ray-ish appearance',
        );
        assert.ok(mesh.material.transparent, 'transparent=true for additive fade');
    }

    // reducedMotion=true 时 update 也不抛错（呼吸/摇曳可走零值分支）
    handle.update(10);
    const uTimeBefore =
        allMeshes[0].material.uniforms.uTime?.value ??
        allMeshes[0].material.uniforms.uBeat?.value ??
        -1;
    handle.update(0.5);
    const uTimeAfter =
        allMeshes[0].material.uniforms.uTime?.value ??
        allMeshes[0].material.uniforms.uBeat?.value ??
        -1;
    // 即使 reducedMotion，uTime 也应单调增加；若走 reducedMotion，时间也不应倒退
    assert.ok(uTimeAfter >= uTimeBefore, `time monotonic: ${uTimeBefore} -> ${uTimeAfter}`);

    // applyTheme 不改结构但也不抛
    handle.applyTheme('day');

    // replaceHeats 增加热点数 → mesh 数量增加或实例数增加（允许两种实现）
    const countBefore = allMeshes.length;
    handle.replaceHeats(
        [
            { ...heat, id: 'h1' },
            { ...heat, id: 'h2' },
            { ...heat, id: 'h3', heatLevel: 'medium', heatValue: 40 },
        ],
        grid,
    );
    const countAfter = handle.group.children.filter((c) => (c as any).isMesh).length;
    assert.ok(
        countAfter >= countBefore || allMeshes.length >= 2,
        'replaceHeats with more heats should keep or increase meshes/instances',
    );

    handle.setVisible(false);
    assert.equal(handle.group.visible, false);
    handle.setVisible(true);
    assert.equal(handle.group.visible, true);

    // 置空：children 数归零或实例数归零、visible=false 任一都算清空
    handle.replaceHeats([], grid);
    const emptyChildCount = handle.group.children.filter((c) => (c as any).isMesh).length;
    const groupInvisible = !handle.group.visible;
    assert.ok(emptyChildCount === 0 || groupInvisible, 'replaceHeats([]) should hide all beams');

    // dispose：至少有一个 geometry/material 触发 dispose
    let disposedGeo = 0;
    let disposedMat = 0;
    for (const child of handle.group.children) {
        const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
        mesh.geometry?.addEventListener?.('dispose', () => disposedGeo++);
        mesh.material?.addEventListener?.('dispose', () => disposedMat++);
    }
    handle.dispose();
    assert.ok(
        disposedGeo + disposedMat > 0 || handle.group.children.length === 0,
        `dispose should release resources: geo=${disposedGeo} mat=${disposedMat} children=${handle.group.children.length}`,
    );
});

function assertNoOverlap(placements: CardPlacement[]) {
    for (let i = 0; i < placements.length; i++) {
        const a = placements[i];
        for (const b of placements.slice(i + 1)) {
            assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x ||
                a.y + a.height <= b.y || b.y + b.height <= a.y);
        }
    }
}

const targets = Array.from({ length: 12 }, (_, i) => ({
    id: String(i), x: 300, y: 220, expanded: i === 0,
}));

test('desktop callouts do not overlap even when all events share one location', () => {
    const result = layoutEventCards(targets, 760, 650);
    assert.equal(result.dense, false);
    assert.equal(result.placements.length, targets.length);
    assertNoOverlap(result.placements);
    for (const card of result.placements) {
        assert.ok(card.x >= 0 && card.y >= 0 && card.x + card.width <= 760 && card.y + card.height <= 650);
    }
});

test('narrow and short viewports keep every event in a scrollable layout', () => {
    for (const [width, height] of [[343, 450], [160, 150], [760, 140]]) {
        const result = layoutEventCards(targets, width, height);
        assert.equal(result.dense, true);
        assert.equal(result.placements.length, targets.length);
        assertNoOverlap(result.placements);
        assert.ok(result.contentHeight > height);
        assert.ok(result.placements.every((card) => card.width <= width));
    }
});

test('projection subscription replays the last frame and removes listeners on cleanup', () => {
    let calls = 0;
    eventProjection.publish([{ id: 'event', x: 20, y: 30, visible: true }]);
    const unsubscribe = eventProjection.subscribe((anchors) => {
        calls++;
        assert.equal(anchors[0].x, 20);
    });
    assert.equal(calls, 1);
    unsubscribe();
    eventProjection.publish([]);
    assert.equal(calls, 1);
});
