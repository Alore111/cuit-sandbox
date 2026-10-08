/**
 * 数据问题（文件缺失、JSON 非法、字段不合法…）。
 * 抛出它表示「服务端数据有错」，对外统一 500，并把可定位的 message 原样返回，
 * 而不是悄悄返回一份空数据让前端显示空白沙盘。
 */
export class DataError extends Error {
    readonly file: string | null;

    constructor(message: string, file: string | null = null) {
        super(message);
        this.name = 'DataError';
        this.file = file;
    }
}
