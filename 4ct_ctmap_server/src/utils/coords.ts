/* ================================================================
   坐标转换：GCJ-02（高德/腾讯）→ WGS-84（前端 Esri 底图基准）
   —— 二课系统的事件经纬度取自高德（GCJ-02），而前端沙盘底图是
      Esri World Imagery，按 WGS-84 勾勒。为让事件点对齐地图，
      需在 Node 代理端把 position 反算回 WGS-84。
   精度：火星坐标反算多用迭代逼近，校园尺度下误差亚米级，
        远小于一个体素，无需更高阶算法。
================================================================ */

const EARTH_RADIUS = 6378245.0;
/** 地球偏心率平方 */
const EE = 0.00669342162296594323;

/** 纬度偏移计算（WGS-84 → GCJ-02 正算算法内核） */
function _transformLat(x: number, y: number): number {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
    ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320.0 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
    return ret;
}

/** 经度偏移计算（WGS-84 → GCJ-02 正算算法内核） */
function _transformLon(x: number, y: number): number {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
    ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
    return ret;
}

/** 中国国界外不适用火星偏移（高德对境外坐标不做纠偏） */
function _outOfChina(lat: number, lon: number): boolean {
    return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

/** 以给定 WGS-84 点为基准，返回从该点到 GCJ-02 的偏移量（gcj = wgs + delta） */
function _delta(lat: number, lon: number): { lat: number; lon: number } {
    let dLat = _transformLat(lon - 105.0, lat - 35.0);
    let dLon = _transformLon(lon - 105.0, lat - 35.0);
    const radLat = (lat / 180.0) * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / (((EARTH_RADIUS * (1 - EE)) / (magic * sqrtMagic)) * Math.PI);
    dLon = (dLon * 180.0) / ((EARTH_RADIUS / sqrtMagic) * Math.cos(radLat) * Math.PI);
    return { lat: dLat, lon: dLon };
}

/** 返回 [wgsLat, wgsLon]；国界外或输入非法时原样透传 */
export function gcj02ToWgs84(gcjLat: number, gcjLon: number): [number, number] {
    if (!Number.isFinite(gcjLat) || !Number.isFinite(gcjLon)) {
        return [gcjLat, gcjLon];
    }
    if (_outOfChina(gcjLat, gcjLon)) {
        return [gcjLat, gcjLon];
    }
    // 迭代反算两次即收敛到亚米级精度
    let wLat = gcjLat;
    let wLon = gcjLon;
    for (let i = 0; i < 2; i++) {
        const d = _delta(wLat, wLon);
        wLat = gcjLat - d.lat;
        wLon = gcjLon - d.lon;
    }
    return [wLat, wLon];
}