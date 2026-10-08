import { useCallback, useEffect, useRef, useState } from 'react';
import type { SearchResult } from '../../contract';
import { searchApi } from '../../api/searchApi';

/** 搜索节流间隔（毫秒） */
const SEARCH_THROTTLE_MS = 300;

/** 搜索最短触发长度：低于此字符数不发起请求 */
const MIN_QUERY_LENGTH = 1;

interface UseSearchReturn {
    /** 搜索结果 */
    results: SearchResult | null;
    /** 是否正在加载 */
    loading: boolean;
    /** 错误信息 */
    error: string | null;
    /** 手动触发搜索（内部会节流） */
    doSearch: (query: string) => void;
    /** 清空搜索结果 */
    clearResults: () => void;
}

/**
 * 搜索 hook：带节流的异步后端搜索
 * —— 输入变化后等待 300ms 节流窗口再发请求；
 *    窗口期内再次输入会重置计时器（即 debounce 语义）。
 *    前一次请求的结果会在新一轮请求发出后被覆盖。
 */
export function useSearch(): UseSearchReturn {
    const [results, setResults] = useState<SearchResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // 节流定时器
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // 请求序号：用于丢弃过期响应
    const seqRef = useRef(0);

    /** 清空结果 */
    const clearResults = useCallback(() => {
        setResults(null);
        setError(null);
        setLoading(false);
    }, []);

    /** 执行实际搜索 */
    const executeSearch = useCallback((query: string) => {
        const seq = ++seqRef.current;
        setLoading(true);
        setError(null);

        searchApi.search(query)
            .then((data) => {
                // 丢弃过期响应（用户已输入新的关键词）
                if (seq !== seqRef.current) return;
                setResults(data);
                setLoading(false);
            })
            .catch((err) => {
                if (seq !== seqRef.current) return;
                setError(err instanceof Error ? err.message : String(err));
                setLoading(false);
            });
    }, []);

    /** 节流触发搜索 */
    const doSearch = useCallback((query: string) => {
        // 清除上一轮定时器
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }

        const trimmed = query.trim();

        // 空查询或太短 → 直接清空结果
        if (trimmed.length < MIN_QUERY_LENGTH) {
            clearResults();
            return;
        }

        // 节流：等 300ms 再发请求
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            executeSearch(trimmed);
        }, SEARCH_THROTTLE_MS);
    }, [executeSearch, clearResults]);

    // 组件卸载时清理定时器
    useEffect(() => {
        return () => {
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
        };
    }, []);

    return { results, loading, error, doSearch, clearResults };
}
