/** 移动端共用的格式化工具（时间/时长），单一来源避免各面板各写一套口径。 */

export function fmtTime(iso?: string): string {
    if (!iso) return '时间待定';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '时间待定';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtRange(start?: string, end?: string): string {
    if (!start) return '时间待定';
    if (!end) return fmtTime(start);
    return `${fmtTime(start)} — ${fmtTime(end)}`;
}

export function fmtDuration(start?: string, end?: string): string {
    if (!start || !end) return '…';
    const s = new Date(start).getTime();
    const e = new Date(end).getTime();
    if (Number.isNaN(s) || Number.isNaN(e)) return '…';
    const mins = Math.max(1, Math.round((e - s) / 60000));
    if (mins < 60) return `${mins} 分钟`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}小时${m}分` : `${h} 小时`;
}