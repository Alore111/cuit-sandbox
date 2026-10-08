/* ================================================================
   坐标系转换：WGS-84 ↔ GCJ-02
   —— WGS-84：GPS 原始经纬度；GCJ-02（火星坐标）：高德/腾讯地图的经纬度。
      Node 端统一输出 wgs84；外部宿主（如用高德拾取坐标）通常给的是 GCJ-02，
      落地前统一转 wgs84，避免地图锚点整体偏移。
   —— 标准火星坐标纠偏算法（无外部依赖）。
      经纬度参数一律用「经度 lng、纬度 lat」两个普通 number 传入；
      项目自身的 LonLat 是 [纬度, 经度]，在调用处自行展开/组装。
================================================================ */

/** 国界粗筛：GCJ-02 只在境外≈WGS-84，境内才有偏移 */
const LNG_OUT = [72.004, 137.8347] as const;
const LAT_OUT = [0.8293, 55.8271] as const;

function outOfChina(lng: number, lat: number): boolean {
    return lng < LNG_OUT[0] || lng > LNG_OUT[1] || lat < LAT_OUT[0] || lat > LAT_OUT[1];
}

const A = 6378245.0; // 半长轴
const EE = 0.00669342162296594323; // 偏心率平方

function transformLat(x: number, y: number): number {
    let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
    ret += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
    ret += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
    return ret;
}

function transformLon(x: number, y: number): number {
    let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
    ret += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
    ret += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
    return ret;
}

/** GCJ-02 相对 WGS-84 的偏移量（经度/纬度增量） */
function delta(lng: number, lat: number): { dlng: number; dlat: number } {
    const dlat = transformLat(lng - 105, lat - 35);
    const dlng = transformLon(lng - 105, lat - 35);
    const radLat = (lat / 180) * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    return {
        dlat: (dlat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI),
        dlng: (dlng * 180) / ((A / sqrtMagic) * Math.cos(radLat) * Math.PI),
    };
}

/**
 * 参考系名：与 campusLive 的 coordSystem 字段口径一致
 * —— wgs84（默认）/ gcj02（高德）
 */
export type CoordinateSystem = 'wgs84' | 'gcj02';

/** WGS-84（GPS）→ GCJ-02（高德），返回 [经度, 纬度]；境外原样返回 */
export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
    if (outOfChina(lng, lat)) return [lng, lat];
    const { dlng, dlat } = delta(lng, lat);
    return [lng + dlng, lat + dlat];
}

/** GCJ-02（高德）→ WGS-84（GPS），返回 [经度, 纬度]；境外原样返回 */
export function gcj02ToWgs84(lng: number, lat: number): [number, number] {
    if (outOfChina(lng, lat)) return [lng, lat];
    const { dlng, dlat } = delta(lng, lat);
    return [lng - dlng, lat - dlat];
}

/**
 * 把任意参考系下的 [纬度, 经度]（项目 LonLat 口径）规整为 wgs84 的 [纬度, 经度]。
 * —— 内部统一存 wgs84，锚点换算/聚焦都用 wgs84，避免一处转换散落各处。
 */
export function normalizeToWgs84(lonLat: [number, number], coordSystem: CoordinateSystem): [number, number] {
    if (coordSystem === 'wgs84') return lonLat;
    const [lat, lng] = lonLat;
    const [lngW = 0, latW = 0] = gcj02ToWgs84(lng, lat);
    return [latW, lngW];
}

/**
 * 把内部 wgs84 的 [纬度, 经度] 转为指定参考系下的 [纬度, 经度]（用于 move 的返回值）。
 */
export function denormalizeLonLat(lonLat: [number, number], coordSystem: CoordinateSystem): [number, number] {
    if (coordSystem === 'wgs84') return lonLat;
    const [lat, lng] = lonLat;
    const [lngG = 0, latG = 0] = wgs84ToGcj02(lng, lat);
    return [latG, lngG];
}