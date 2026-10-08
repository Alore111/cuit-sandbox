import { useCallback, useRef, useState } from 'react';
import { useMapStore } from '../../store/mapStore';
import { useLocateStore } from '../../store/locateStore';
import type { SearchResultItem } from '../../contract';
import { SearchResultList } from './SearchResultList';
import { useSearch } from '../hooks/useSearch';
import styles from '../styles/hud.module.css';
import searchStyles from '../styles/search.module.css';
import { BrandPanel } from './BrandPanel';
import { BuildingDetailCard } from './BuildingDetailCard';
import { CampusLivePanel } from './CampusLivePanel';
import { DataWarningBadge } from './DataWarningBadge';
import { HoverTooltip } from './HoverTooltip';
import { HintBar } from './HintBar';
import { RosterPanel } from './RosterPanel';
import { TerrainLegendPanel } from './TerrainLegendPanel';
import { ThemeToggle } from './ThemeToggle';
import { ViewPresetBar } from './ViewPresetBar';

export function HudLayer() {
    const school = useMapStore((state) => state.dataset?.school);
    const [liveOpen, setLiveOpen] = useState(false);

    /* 搜索状态 */
    const [searchFocused, setSearchFocused] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const { results, loading, doSearch, clearResults } = useSearch();
    const searchInputRef = useRef<HTMLInputElement>(null);
    const searchPanelRef = useRef<HTMLDivElement>(null);

    const locate = useLocateStore((state) => state.locate);

    const handleSearchFocus = useCallback(() => {
        setSearchFocused(true);
    }, []);

    const handleSearchBlur = useCallback(() => {
        // 延迟判断：如果点击的是面板内部，不收起
        setTimeout(() => {
            const active = document.activeElement;
            if (
                active !== searchInputRef.current &&
                !searchPanelRef.current?.contains(active)
            ) {
                setSearchFocused(false);
            }
        }, 150);
    }, []);

    const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
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
    }, [clearResults]);

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

    if (!school) return null;

    return (
        <>
            {/* PC 端搜索框：画面正上方居中（脱离 grid 布局） */}
            <div className={searchStyles.pcSearchTopBar}>
                <div className={searchStyles.searchBox}>
                    <span className={searchStyles.searchIcon} aria-hidden="true">⌕</span>
                    <input
                        ref={searchInputRef}
                        className={searchStyles.searchInput}
                        type="search"
                        value={searchQuery}
                        onChange={handleSearchChange}
                        onFocus={handleSearchFocus}
                        onBlur={handleSearchBlur}
                        placeholder="搜索地点、活动"
                        aria-label="搜索地点、活动"
                    />
                    {searchQuery && (
                        <button
                            type="button"
                            className={searchStyles.searchClear}
                            aria-label="清空搜索"
                            onClick={handleSearchClear}
                        >
                            ×
                        </button>
                    )}
                </div>
                {/* 搜索结果面板（聚焦且有输入时展开） */}
                {searchFocused && searchQuery.trim() && (
                    <div ref={searchPanelRef} className={searchStyles.pcSearchPanel}>
                        <SearchResultList
                            items={results?.items ?? []}
                            query={searchQuery}
                            loading={loading}
                            onPlaceClick={handlePlaceClick}
                            onEventClick={handleEventClick}
                        />
                    </div>
                )}
            </div>

            <div className={styles.hudLayer}>
                <BrandPanel school={school} />
                <RosterPanel />
                <TerrainLegendPanel />
                <div className={styles.topRight}>
                    <button className={[styles.toggle, styles.liveButton].join(' ')}
                        aria-expanded={liveOpen} aria-controls="campus-live-panel"
                        onClick={() => setLiveOpen((open) => !open)}>
                        {liveOpen ? '收起实况' : '校园实况'}
                    </button>
                    <ThemeToggle />
                    <DataWarningBadge />
                </div>
                <BuildingDetailCard />
                <ViewPresetBar />
                <HintBar />
                <div id="campus-live-panel" className={[styles.panel, styles.campusLive, liveOpen ? styles.liveOpen : ''].join(' ')}>
                    <CampusLivePanel />
                </div>
            </div>
            <HoverTooltip />
        </>
    );
}
