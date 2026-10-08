import { useCallback, useEffect, useRef, useState } from 'react';
import { useMapStore } from '../../store/mapStore';
import { useCampusLiveStore } from '../../store/campusLiveStore';
import { useSelectionStore } from '../../store/selectionStore';
import { useUiStore } from '../../store/uiStore';
import { useLocateStore } from '../../store/locateStore';
import { MobileDrawer } from './MobileDrawer';
import { HomeView } from './HomeView';
import { EventDetailPanel, BuildingDetailPanel } from './DetailPanels';
import { SearchResultList } from '../components/SearchResultList';
import { useSearch } from '../hooks/useSearch';
import type { SearchResultItem } from '../../contract';
import styles from './mobile.module.css';

/** 抽屉当前内容阶段（由 store 派生，避免与 3D/选中状态各存一份而失同步）。 */
type Phase = 'home' | 'event' | 'building';

/**
 * 移动端独立 UI 外壳（高德/百度地图式布局）：
 *   顶部标题栏（含搜索框）→ 铺满的背景 3D 地图 → 单一可拖拽底部抽屉（磁吸四档）。
 * 搜索框在顶部，聚焦时抽屉展开为独立搜索页面。
 */
export function MobileLayout() {
    const school = useMapStore((state) => state.dataset?.school);
    const schoolLoaded = !!school;

    const detailEventId = useCampusLiveStore((state) => state.detailEventId);
    const openDetail = useCampusLiveStore((state) => state.openDetail);
    const selectedBuildingId = useSelectionStore((state) => state.selectedId);
    const selectBuilding = useSelectionStore((state) => state.select);

    const theme = useUiStore((state) => state.theme);
    const toggleTheme = useUiStore((state) => state.toggleTheme);
    const showEvents = useCampusLiveStore((state) => state.showEvents);
    const setShowEvents = useCampusLiveStore((state) => state.setShowEvents);

    /* 统一地图定位 */
    const locate = useLocateStore((state) => state.locate);

    /* 搜索状态 */
    const [searchFocused, setSearchFocused] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const { results, loading, doSearch, clearResults } = useSearch();
    const searchInputRef = useRef<HTMLInputElement>(null);

    /* 搜索框聚焦时自增，通知抽屉升到 3/4 屏 */
    const [expandSeq, setExpandSeq] = useState(0);
    const handleSearchFocus = useCallback(() => {
        setSearchFocused(true);
        setExpandSeq((s) => s + 1);
    }, []);

    const handleSearchBlur = useCallback(() => {
        // 延迟判断：如果点击的是清空按钮，不立即收起
        setTimeout(() => {
            if (!searchInputRef.current?.contains(document.activeElement)) {
                setSearchFocused(false);
            }
        }, 150);
    }, []);

    const handleSearchChange = useCallback((value: string) => {
        setSearchQuery(value);
        doSearch(value);
    }, [doSearch]);

    const handleSearchClear = useCallback(() => {
        setSearchQuery('');
        clearResults();
        searchInputRef.current?.focus();
    }, [clearResults]);

    const handleSearchClose = useCallback(() => {
        setSearchFocused(false);
        setSearchQuery('');
        clearResults();
        searchInputRef.current?.blur();
    }, [clearResults]);

    /* 搜索结果点击 */
    const handlePlaceClick = useCallback((item: SearchResultItem) => {
        /* 统一地图定位：信标 + 铭牌 + 导航 */
        locate({
            kind: 'place',
            position: item.position,
            buildingId: item.placeData?.buildingIds?.[0],
            name: item.name,
        });
        handleSearchClose();
    }, [locate, handleSearchClose]);

    const handleEventClick = useCallback((item: SearchResultItem) => {
        /* 统一地图定位：事件类型走详情抽屉（自带信标 + 导航 + 铭牌） */
        locate({
            kind: 'event',
            position: item.position,
            eventId: item.eventData?.id,
            name: item.name,
        });
        handleSearchClose();
    }, [locate, handleSearchClose]);

    /* 离开移动端布局（切桌面/卸载）时，清掉地图底部占位，恢复满幅取景 */
    useEffect(() => {
        return () => useUiStore.getState().setBottomInset(0);
    }, []);

    if (!schoolLoaded) return null;

    /* 单一真相：详情优先级高于建筑，建筑高于首页 */
    const phase: Phase = detailEventId ? 'event' : selectedBuildingId ? 'building' : 'home';

    const handleBack = () => {
        if (phase === 'event') openDetail(null);
        else if (phase === 'building') selectBuilding(null);
    };

    return (
        <div className={styles.mobileRoot}>
            {/* 顶部标题栏 */}
            <header className={styles.topBar}>
                {/* 取像规则统一在 global.css 的 .schoolEmblem，这里只声明展示尺寸 */}
                <span className={`schoolEmblem ${styles.topBarMark}`} aria-hidden="true" />
                <div className={styles.topBarText}>
                    <div className={styles.topBarTitle}>{school.name}</div>
                    <div className={styles.topBarSub}>{school.title || school.subtitle}</div>
                </div>
                <div className={styles.topBarActions}>
                    <span className={styles.topBadge}>{school.campusName}</span>
                    <button
                        type="button"
                        className={styles.themeBtn}
                        aria-label={theme === 'night' ? '切换到白天' : '切换到夜晚'}
                        onClick={toggleTheme}
                    >
                        {theme === 'night' ? '☾' : '☀'}
                    </button>
                </div>
            </header>

            {/* 搜索框：位于标题栏下方，地图上方 */}
            <div className={styles.searchBarOuter}>
                <div className={styles.searchBox}>
                    <span className={styles.searchIcon} aria-hidden="true">⌕</span>
                    <input
                        ref={searchInputRef}
                        className={styles.searchInput}
                        type="search"
                        value={searchQuery}
                        onChange={(e) => handleSearchChange(e.target.value)}
                        onFocus={handleSearchFocus}
                        onBlur={handleSearchBlur}
                        placeholder="搜索地点、活动"
                        inputMode="search"
                        enterKeyHint="search"
                        aria-label="搜索地点、活动"
                    />
                    {searchQuery && (
                        <button
                            type="button"
                            className={styles.searchClear}
                            aria-label="清空搜索"
                            onClick={handleSearchClear}
                        >
                            ×
                        </button>
                    )}
                </div>
            </div>

            {/* 标题栏下方、画面右上角：事件显示/隐藏切换 */}
            <button
                type="button"
                className={[styles.eventsToggle, showEvents ? styles.isOn : ''].join(' ')}
                aria-pressed={showEvents}
                aria-label={showEvents ? '隐藏事件标记' : '显示事件标记'}
                onClick={() => setShowEvents(!showEvents)}
            >
                <span className={styles.eventsToggleDot} aria-hidden="true" />
                {showEvents ? '事件显示中' : '事件已隐藏'}
            </button>

            {/* 单一抽屉：承载正文；搜索聚焦时展示搜索页面 */}
            <MobileDrawer view={searchFocused ? 'home' : phase} expandSeq={expandSeq}>
                <div className={styles.viewStage}>
                    {searchFocused ? (
                        /* 搜索页面：搜索框已在顶部固定，下面直接展示结果 */
                        <div className={styles.searchPage}>
                            <SearchResultList
                                items={results?.items ?? []}
                                query={searchQuery}
                                loading={loading}
                                onPlaceClick={handlePlaceClick}
                                onEventClick={handleEventClick}
                            />
                        </div>
                    ) : (
                        <div className={styles.view} key={phase}>
                            {phase === 'home' && (
                                <HomeView
                                    onOpenEvent={openDetail}
                                    onOpenBuilding={selectBuilding}
                                />
                            )}
                            {phase === 'event' && detailEventId && (
                                <EventDetailPanel id={detailEventId} onBack={handleBack} />
                            )}
                            {phase === 'building' && selectedBuildingId && (
                                <BuildingDetailPanel id={selectedBuildingId} onBack={handleBack} />
                            )}
                        </div>
                    )}
                </div>
            </MobileDrawer>
        </div>
    );
}
