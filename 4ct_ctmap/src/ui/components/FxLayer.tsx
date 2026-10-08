/** 电影质感叠加层：颗粒 + 暗角。数值由主题令牌给（浅色下减淡） */
export function FxLayer() {
    return (
        <>
            <div className="fxGrain" aria-hidden="true" />
            <div className="fxVignette" aria-hidden="true" />
        </>
    );
}
