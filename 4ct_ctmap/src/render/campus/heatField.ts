import type { HeatLevel, LocationHeat } from '../../contract';
import { HEAT_LEVEL_THRESHOLDS } from '../../contract/campusLive';
import type { GridSystem } from '../../utils/geo';

export const HEAT_FIELD = {
    maxHeightMeters: 100,
    radiusMeters: 52,
    groundY: 1.08,
    segments: 160,
    cutoffSigma: 3,
} as const;

export interface HeatSource {
    x: number;
    z: number;
    intensity: number;
}

export function createHeatSources(
    heats: LocationHeat[],
    grid: GridSystem,
    minLevel: HeatLevel,
): HeatSource[] {
    return heats
        .filter((heat) => HEAT_LEVEL_THRESHOLDS[heat.heatLevel] >= HEAT_LEVEL_THRESHOLDS[minLevel])
        .map((heat) => {
            const point = grid.lonLatToVoxel(...heat.position);
            return {
                ...grid.voxelToWorld(point.vx, point.vz),
                intensity: Math.max(0, Math.min(100, heat.heatValue)) / 100,
            };
        });
}

/** 高斯核平滑叠加，用概率并集限制峰高，避免同地点事件堆成无限高的尖柱。 */
export function sampleHeatField(x: number, z: number, sources: HeatSource[], radius: number): number {
    let remaining = 1;
    const cutoff = Math.exp(-0.5 * HEAT_FIELD.cutoffSigma ** 2);
    for (const source of sources) {
        const distanceSquared = ((x - source.x) ** 2 + (z - source.z) ** 2) / radius ** 2;
        if (distanceSquared >= HEAT_FIELD.cutoffSigma ** 2) continue;
        const kernel = (Math.exp(-0.5 * distanceSquared) - cutoff) / (1 - cutoff);
        remaining *= 1 - source.intensity * kernel;
    }
    return 1 - remaining;
}
