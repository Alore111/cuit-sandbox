/** 十六进制数值 → CSS 颜色（图例色块、详情卡色标用） */
export function toCssHex(hex: number): string {
    return `#${hex.toString(16).padStart(6, '0')}`;
}

/** 千分位数字（面积、体素数这类计数用） */
export function formatCount(value: number): string {
    return Math.round(value).toLocaleString('en-US');
}

/** 米：保留指定小数位 */
export function formatMeters(value: number, digits = 1): string {
    return value.toFixed(digits);
}
