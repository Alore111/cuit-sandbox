/* ================================================================
   撤销 / 重做（Ctrl+Z / Ctrl+Y）
   —— 【口径】快照式：栈里存的是「编辑**之前**的整份文档」。
      数据规模是千级顶点，整份快照远比逐操作写反向补丁简单可靠，
      也不会出现「补丁算错一次、后面全乱」的问题。

      关键设计：**拖拽过程中不记栈**。一次拖动会发出几十上百次变更，
      若每次都记，撤销一次只退一个像素。因此调用方在「手势开始」时
      拿到 before 快照，在手势结束时才 record 一次 —— 见 EditorCanvas 的拖动收尾。

      文档必须是不可变快照（每次编辑都产生新对象），否则撤销会退回到
      被就地改过的同一份引用上。
================================================================ */

import { useCallback, useMemo, useRef, useState } from 'react';

/** 历史深度：够回退一长串误操作，又不至于把内存撑起来 */
export const HISTORY_LIMIT = 60;

export interface EditorHistory<T> {
    /** 记录一次可撤销的时刻：把「编辑前的值」压栈（应用新值之后调用也行） */
    record: (before: T) => void;
    /** 撤销：把 current 收进重做栈，返回要恢复的值；无历史时返回 null */
    undo: (current: T) => T | null;
    /** 重做：返回值同上 */
    redo: (current: T) => T | null;
    /** 重新从后端读数据后清空历史（旧快照已经对不上磁盘了） */
    clear: () => void;
    canUndo: boolean;
    canRedo: boolean;
    /** 栈深，供状态栏显示 */
    past: number;
    future: number;
}

export function useEditorHistory<T>(limit = HISTORY_LIMIT): EditorHistory<T> {
    const pastRef = useRef<T[]>([]);
    const futureRef = useRef<T[]>([]);
    /* 栈内容放在 ref 里（拖动时不引起重渲染），用版本号计数驱动 canUndo/canRedo 的刷新 */
    const [, setBumpVersion] = useState(0);

    const bump = useCallback(() => setBumpVersion((value) => value + 1), []);

    const record = useCallback(
        (before: T) => {
            pastRef.current = [...pastRef.current, before].slice(-limit);
            futureRef.current = [];
            bump();
        },
        [bump, limit]
    );

    const undo = useCallback(
        (current: T): T | null => {
            const past = pastRef.current;
            if (past.length === 0) return null;

            futureRef.current = [...futureRef.current, current];
            pastRef.current = past.slice(0, -1);
            bump();
            return past[past.length - 1];
        },
        [bump]
    );

    const redo = useCallback(
        (current: T): T | null => {
            const future = futureRef.current;
            if (future.length === 0) return null;

            pastRef.current = [...pastRef.current, current].slice(-limit);
            futureRef.current = future.slice(0, -1);
            bump();
            return future[future.length - 1];
        },
        [bump, limit]
    );

    const clear = useCallback(() => {
        pastRef.current = [];
        futureRef.current = [];
        bump();
    }, [bump]);

    /* 返回的对象必须是稳定引用：调用方会把它放进 load/effect 的依赖里，
       每次渲染都换新对象会让「读取数据」这类副作用反复触发 */
    const canUndo = pastRef.current.length > 0;
    const canRedo = futureRef.current.length > 0;
    const past = pastRef.current.length;
    const future = futureRef.current.length;

    return useMemo(
        () => ({ record, undo, redo, clear, canUndo, canRedo, past, future }),
        [record, undo, redo, clear, canUndo, canRedo, past, future]
    );
}
