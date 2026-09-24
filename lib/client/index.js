import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Browser half: the 「视频号下载」 button in the composer toolbar opens a
 * console mirroring the wxdown desktop client:
 *   仪表盘 / 博主(关注清单 + 待下载) / 任务 / 视频库(仅已下载) / 设置
 * Watchlist semantics: when the watchlist is non-empty the tool only
 * captures / lists / downloads videos from watched authors ("只探测提前
 * 设定的博主"); an empty watchlist captures everything.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { WEB_API_PREFIX, WEB_EVENTS_ENDPOINT } from '../shared/protocol.js';
export const NS = 'wx-channels-downloader';
const RANGES = [
    { v: 0, label: '全部时间' },
    { v: 3, label: '近 3 天' },
    { v: 7, label: '近 7 天' },
    { v: 30, label: '近 30 天' },
    { v: 90, label: '近 90 天' },
];
const TABS = [
    { id: 'dash', label: '仪表盘' },
    { id: 'probe', label: '探测' },
    { id: 'authors', label: '博主' },
    { id: 'tasks', label: '任务' },
    { id: 'library', label: '视频库' },
    { id: 'settings', label: '设置' },
];
const STATUS_COLOR = { ok: '#22c55e', warn: '#f59e0b', fail: '#ef4444', unknown: '#64748b' };
const STATUS_TEXT = { ok: '正常', warn: '注意', fail: '异常', unknown: '未知' };
function fmtTime(ts) {
    if (!ts)
        return '—';
    try {
        return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false });
    }
    catch {
        return String(ts);
    }
}
function fmtSize(bytes) {
    if (!bytes)
        return '—';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}
function groupByAuthor(rows) {
    const m = new Map();
    for (const v of rows) {
        const k = v.nickname || '未知作者';
        const arr = m.get(k);
        if (arr)
            arr.push(v);
        else
            m.set(k, [v]);
    }
    return [...m.entries()];
}
async function cmd(command, payload = {}) {
    await fetch(`${WEB_API_PREFIX}/cmd`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command, payload }),
    });
}
/* ------------------------------------------------------------------ */
function WxChannelsConsole({ onClose }) {
    const [tab, setTab] = useState('dash');
    const [state, setState] = useState(null);
    const [log, setLog] = useState([]);
    const [liveTasks, setLiveTasks] = useState({});
    const [rangeDays, setRangeDays] = useState(0);
    const [busy, setBusy] = useState(null);
    const [watchInput, setWatchInput] = useState('');
    const logRef = useRef(null);
    const refresh = useCallback(async () => {
        try {
            const r = await fetch(`${WEB_API_PREFIX}/state`, { cache: 'no-store' });
            const j = (await r.json());
            setState(j);
            const tasks = j.downloader?.tasks ?? [];
            const map = {};
            for (const t of tasks) {
                map[t.id ?? t.videoId ?? ''] = { videoId: t.id ?? t.videoId ?? '', title: t.title ?? '', state: t.state ?? 'pending', progress: t.progress ?? 0 };
            }
            setLiveTasks(map);
            if (Array.isArray(j.logs) && j.logs.length) {
                setLog((l) => (l.length ? l : j.logs.map((x) => `[${new Date(x.at).toLocaleTimeString('zh-CN', { hour12: false })}] ${x.msg}`)));
            }
        }
        catch {
            setState(null);
        }
    }, []);
    useEffect(() => {
        void refresh();
        const es = new EventSource(WEB_EVENTS_ENDPOINT);
        es.onmessage = (ev) => {
            const e = JSON.parse(ev.data);
            if (e.type === 'probe' && e.probe) {
                setState((s) => (s ? { ...s, lastProbe: e.probe } : s));
            }
            else if (e.type === 'captured' && e.video) {
                const cv = e.video;
                setState((s) => {
                    if (!s)
                        return s;
                    if (s.catalog.some((x) => x.id === cv.id))
                        return s;
                    const all = (s.catalogAll ?? s.catalog).some((x) => x.id === cv.id)
                        ? (s.catalogAll ?? s.catalog)
                        : [cv, ...(s.catalogAll ?? s.catalog)].slice(0, 600);
                    return { ...s, catalog: [cv, ...s.catalog], catalogAll: all, catalogCount: s.catalogCount + 1 };
                });
            }
            else if (e.type === 'download' && e.download) {
                setLiveTasks((m) => ({ ...m, [e.download.videoId]: { videoId: e.download.videoId, title: e.download.title, state: e.download.state, progress: e.download.progress } }));
            }
            else if (e.type === 'log' && e.log) {
                setLog((l) => [...l.slice(-200), `[${new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false })}] ${e.log}`]);
            }
        };
        es.onerror = () => {
            // EventSource auto-reconnects
        };
        return () => es.close();
    }, [refresh]);
    useEffect(() => {
        logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
    }, [log]);
    const run = async (command, payload = {}, label) => {
        setBusy(command);
        try {
            await cmd(command, payload);
        }
        finally {
            setBusy(null);
        }
        if (label)
            setLog((l) => [...l, `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] → ${label}`]);
        void refresh();
    };
    const probe = state?.lastProbe;
    const tasks = Object.values(liveTasks);
    const watchlist = state?.watchlist ?? [];
    const watchActive = state?.watchActive ?? false;
    const cutoff = rangeDays > 0 ? Date.now() / 1000 - rangeDays * 86400 : 0;
    const inRange = (v) => !cutoff || Number(v.createtime) >= cutoff;
    const allCatalog = state?.catalog ?? [];
    const pending = allCatalog.filter((v) => inRange(v) && !v.downloaded && v.url);
    const downloaded = allCatalog.filter((v) => inRange(v) && v.downloaded);
    const pendingGroups = groupByAuthor(pending);
    const libraryGroups = groupByAuthor(downloaded);
    const allProbe = state?.catalogAll ?? state?.catalog ?? [];
    const addWatch = async () => {
        const raw = watchInput.trim();
        if (!raw)
            return;
        const isUsername = /@finder|^v2_/.test(raw);
        await run('addWatch', isUsername ? { username: raw } : { nickname: raw }, `已添加关注: ${raw.slice(0, 24)}`);
        setWatchInput('');
    };
    return (_jsx("div", { style: { position: 'fixed', inset: 0, zIndex: 2147483000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }, children: _jsxs("div", { style: { width: 'min(1080px, 94vw)', height: 'min(780px, 94vh)', background: '#0f1115', color: '#e5e7eb', borderRadius: 14, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.5)', fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', fontSize: 13 }, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid #1f2937', background: '#151821' }, children: [_jsx("span", { style: { fontSize: 17 }, children: "\uD83C\uDFAC" }), _jsx("span", { style: { fontWeight: 600, fontSize: 14 }, children: "\u5FAE\u4FE1\u89C6\u9891\u53F7\u4E0B\u8F7D" }), _jsx("span", { style: { fontSize: 12, color: state?.proxyRunning ? '#22c55e' : '#ef4444' }, children: state ? `代理 ${state.proxyRunning ? `运行中 (127.0.0.1:${state.proxyPort})` : '未启动'}` : '连接中…' }), _jsxs("span", { style: { fontSize: 12, color: '#9ca3af' }, children: ["\u5173\u6CE8 ", watchlist.length, " \u00B7 \u5DF2\u91C7\u96C6 ", state?.catalogCount ?? 0, " \u00B7 \u5DF2\u4E0B\u8F7D ", state?.downloadCount ?? 0] }), _jsxs("span", { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }, children: [_jsx("button", { style: btn, onClick: () => void run('runProbe', {}, '探测完成'), children: "\uD83D\uDD04 \u8FD0\u884C\u63A2\u6D4B" }), _jsx("button", { title: "\u5173\u95ED\u9762\u677F", onClick: onClose, style: { width: 28, height: 28, borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', cursor: 'pointer', fontSize: 15, lineHeight: 1 }, children: "\u2715" })] })] }), _jsx("div", { style: { display: 'flex', gap: 4, padding: '8px 16px 0', borderBottom: '1px solid #1f2937', background: '#13161d' }, children: TABS.map((t) => (_jsx("button", { onClick: () => setTab(t.id), style: {
                            padding: '7px 14px',
                            border: 'none',
                            borderBottom: tab === t.id ? '2px solid #3b82f6' : '2px solid transparent',
                            background: 'transparent',
                            color: tab === t.id ? '#fff' : '#9ca3af',
                            cursor: 'pointer',
                            fontWeight: tab === t.id ? 600 : 400,
                            fontSize: 13,
                        }, children: t.label }, t.id))) }), _jsxs("div", { style: { flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }, children: [tab === 'dash' && (_jsxs(_Fragment, { children: [_jsx("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }, children: [
                                        { label: '关注博主', value: watchlist.length, color: '#93c5fd' },
                                        { label: '已采集视频', value: state?.catalogCount ?? 0, color: '#67e8f9' },
                                        { label: '已下载', value: state?.downloadCount ?? 0, color: '#86efac' },
                                        { label: '范围内待下载', value: pending.length, color: '#fcd34d' },
                                    ].map((c) => (_jsxs("div", { style: { ...card, textAlign: 'center', padding: '14px 10px' }, children: [_jsx("div", { style: { fontSize: 24, fontWeight: 700, color: c.color }, children: c.value }), _jsx("div", { style: { color: '#9ca3af', fontSize: 12, marginTop: 4 }, children: c.label })] }, c.label))) }), _jsxs("div", { style: card, children: [_jsx("div", { style: cardTitle, children: "\u5FEB\u6377\u64CD\u4F5C" }), _jsxs("div", { style: { display: 'flex', gap: 8, flexWrap: 'wrap' }, children: [_jsxs("button", { style: btnPrimary, disabled: busy !== null || pending.length === 0, onClick: () => void run('downloadAll', { rangeDays }, `批量下载范围内 ${pending.length} 个`), children: ["\u2B07 \u4E0B\u8F7D\u8303\u56F4\u5185\u5F85\u4E0B\u8F7D\uFF08", pending.length, "\uFF09"] }), _jsx("button", { style: btn, onClick: () => setTab('authors'), children: "\u2B50 \u7BA1\u7406\u535A\u4E3B / \u5F85\u4E0B\u8F7D" }), _jsx("button", { style: btn, onClick: () => setTab('library'), children: "\uD83C\uDF9E\uFE0F \u5DF2\u4E0B\u8F7D\u89C6\u9891\u5E93" }), _jsx("button", { style: btn, onClick: () => setTab('settings'), children: "\u2699\uFE0F \u9996\u6B21\u914D\u7F6E" })] }), _jsxs("div", { style: { color: '#9ca3af', fontSize: 12, marginTop: 10 }, children: [watchActive
                                                    ? '🔒 仅关注模式：当前只采集/显示/下载关注清单内的博主'
                                                    : '🌐 当前采集全部博主 —— 添加博主到关注清单后，将只探测设定的博主', "\u3002\u5728 PC \u5FAE\u4FE1\u6253\u5F00\u535A\u4E3B\u4E3B\u9875\u5373\u81EA\u52A8\u63A2\u6D4B\u5176\u89C6\u9891\u3002"] })] })] })), tab === 'probe' && (_jsxs("div", { style: card, children: [_jsxs("div", { style: { ...cardTitle, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, children: [_jsxs("span", { children: ["\uD83D\uDD0D \u5B9E\u65F6\u63A2\u6D4B \u00B7 \u5168\u90E8\u89C6\u9891\uFF08", allProbe.length, "\uFF09"] }), _jsx("span", { style: { color: '#9ca3af', fontWeight: 400, fontSize: 12 }, children: "\u6253\u5F00\u535A\u4E3B\u4E3B\u9875\u5373\u81EA\u52A8\u4E0A\u62A5\uFF0C\u6700\u65B0\u63A2\u6D4B\u7684\u5B9E\u65F6\u7F6E\u9876\uFF1B\u4E0D\u53D7\u5173\u6CE8\u6E05\u5355\u8FC7\u6EE4" })] }), allProbe.length === 0 ? (_jsx("div", { style: { color: '#9ca3af', padding: 8 }, children: "\u6682\u65E0\u63A2\u6D4B\u7ED3\u679C \u2014\u2014 \u5728 PC \u5FAE\u4FE1\u6253\u5F00\u4EFB\u4E00\u535A\u4E3B\u4E3B\u9875\uFF0C\u89C6\u9891\u4F1A\u5B9E\u65F6\u51FA\u73B0\u5728\u8FD9\u91CC\uFF08\u5173\u6CE8\u6E05\u5355\u53EA\u5F71\u54CD\u300C\u535A\u4E3B/\u5F85\u4E0B\u8F7D\u300D\uFF0C\u4E0D\u5F71\u54CD\u672C\u9875\u5168\u90E8\u63A2\u6D4B\uFF09" })) : (_jsxs("table", { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 }, children: [_jsx("thead", { children: _jsxs("tr", { style: { color: '#9ca3af', textAlign: 'left' }, children: [_jsx("th", { style: th, children: "\u6807\u9898" }), _jsx("th", { style: th, children: "\u535A\u4E3B" }), _jsx("th", { style: th, children: "\u53D1\u5E03\u65F6\u95F4" }), _jsx("th", { style: th, children: "\u72B6\u6001" }), _jsx("th", { style: th, children: "\u64CD\u4F5C" })] }) }), _jsx("tbody", { children: allProbe.slice(0, 400).map((v) => {
                                                const t = liveTasks[v.id];
                                                return (_jsxs("tr", { style: { borderTop: '1px solid #1f2937' }, children: [_jsx("td", { style: td, children: _jsx("span", { title: v.title, children: String(v.title ?? '').slice(0, 48) }) }), _jsx("td", { style: td, children: v.nickname || '—' }), _jsx("td", { style: td, children: fmtTime(Number(v.createtime)) }), _jsx("td", { style: td, children: v.downloaded ? _jsx("span", { style: { color: '#22c55e' }, children: "\u2713 \u5DF2\u4E0B\u8F7D" })
                                                                : t?.state === 'downloading' ? _jsxs("span", { style: { color: '#3b82f6' }, children: ["\u2193 ", Math.round(t.progress ?? 0), "%"] })
                                                                    : t?.state === 'failed' ? _jsx("span", { style: { color: '#ef4444' }, children: "\u2717 \u5931\u8D25" })
                                                                        : _jsx("span", { style: { color: '#f59e0b' }, children: "\u5F85\u4E0B\u8F7D" }) }), _jsx("td", { style: td, children: !v.downloaded && t?.state !== 'downloading' ? (_jsx("button", { style: linkBtn, disabled: busy !== null || !v.url, onClick: () => void run('download', { videoIds: [v.id ?? ''] }, `开始下载: ${String(v.title ?? '').slice(0, 20)}`), children: "\u4E0B\u8F7D" })) : (_jsx("span", { style: { color: '#4b5563' }, children: "\u2014" })) })] }, v.id));
                                            }) })] }))] })), tab === 'authors' && (_jsxs(_Fragment, { children: [_jsxs("div", { style: card, children: [_jsx("div", { style: { ...cardTitle, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, children: _jsxs("span", { children: ["\u535A\u4E3B\u5173\u6CE8\u6E05\u5355", watchActive ? '（🔒 仅关注模式）' : '（当前采集全部）'] }) }), _jsxs("div", { style: { display: 'flex', gap: 8, marginBottom: 12 }, children: [_jsx("input", { value: watchInput, onChange: (ev) => setWatchInput(ev.target.value), onKeyDown: (ev) => { if (ev.key === 'Enter')
                                                        void addWatch(); }, placeholder: "\u7C98\u8D34\u535A\u4E3B ID\uFF08v2_\u2026@finder\uFF09\u6216\u6635\u79F0\uFF0C\u56DE\u8F66\u6DFB\u52A0", style: { flex: 1, background: '#1a1e27', border: '1px solid #374151', borderRadius: 8, padding: '7px 10px', color: '#e5e7eb', fontSize: 13 } }), _jsx("button", { style: btnPrimary, onClick: () => void addWatch(), children: "\uFF0B \u6DFB\u52A0\u5173\u6CE8" })] }), watchlist.length === 0 ? (_jsx("div", { style: { color: '#9ca3af', padding: 8 }, children: "\u8FD8\u6CA1\u6709\u5173\u6CE8\u535A\u4E3B \u2014\u2014 \u6DFB\u52A0\u540E\u53EA\u63A2\u6D4B\u8FD9\u4E9B\u535A\u4E3B\uFF1B\u4E0D\u6DFB\u52A0\u5219\u91C7\u96C6\u5168\u90E8" })) : (_jsxs("table", { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 }, children: [_jsx("thead", { children: _jsxs("tr", { style: { color: '#9ca3af', textAlign: 'left' }, children: [_jsx("th", { style: th, children: "\u535A\u4E3B" }), _jsx("th", { style: th, children: "ID" }), _jsx("th", { style: th, children: "\u5DF2\u91C7\u96C6/\u4E0B\u8F7D" }), _jsx("th", { style: th, children: "\u72B6\u6001" }), _jsx("th", { style: th, children: "\u64CD\u4F5C" })] }) }), _jsx("tbody", { children: watchlist.map((w) => (_jsxs("tr", { style: { borderTop: '1px solid #1f2937' }, children: [_jsx("td", { style: td, children: w.nickname || '—' }), _jsx("td", { style: td, children: _jsx("span", { style: { color: '#9ca3af' }, children: w.username }) }), _jsxs("td", { style: td, children: [w.captured, " / ", w.downloaded] }), _jsx("td", { style: td, children: w.enabled === 1 ? _jsx("span", { style: { color: '#22c55e' }, children: "\u91C7\u96C6\u4E2D" }) : _jsx("span", { style: { color: '#f59e0b' }, children: "\u5DF2\u6682\u505C" }) }), _jsx("td", { style: td, children: _jsxs("span", { style: { display: 'inline-flex', gap: 6 }, children: [_jsx("button", { style: linkBtn, onClick: () => void run('setWatchEnabled', { username: w.username, on: w.enabled !== 1 }, ''), children: w.enabled === 1 ? '暂停' : '恢复' }), _jsx("button", { style: { ...linkBtn, color: '#fca5a5' }, onClick: () => void run('removeWatch', { username: w.username }, `已取消关注 ${w.nickname || w.username}`), children: "\u5220\u9664" })] }) })] }, w.username))) })] }))] }), _jsxs("div", { style: card, children: [_jsxs("div", { style: { ...cardTitle, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, children: [_jsxs("span", { children: ["\u5173\u6CE8\u535A\u4E3B\u7684\u66F4\u65B0\u52A8\u6001\uFF08\u5F85\u4E0B\u8F7D \u00B7 ", pending.length, "\uFF09"] }), _jsx("select", { value: rangeDays, onChange: (ev) => setRangeDays(Number(ev.target.value)), style: { ...btn, padding: '3px 8px' }, children: RANGES.map((r) => _jsx("option", { value: r.v, children: r.label }, r.v)) }), _jsxs("button", { style: { ...btnPrimary, marginLeft: 'auto' }, disabled: busy !== null || pending.length === 0, onClick: () => void run('downloadAll', { rangeDays }, `批量下载范围内 ${pending.length} 个`), children: ["\u2B07 \u5168\u90E8\u4E0B\u8F7D\uFF08", pending.length, "\uFF09"] })] }), pending.length === 0 ? (_jsx("div", { style: { color: '#9ca3af', padding: 8 }, children: "\u6682\u65E0\u5F85\u4E0B\u8F7D\u89C6\u9891 \u2014\u2014 \u6253\u5F00\u535A\u4E3B\u4E3B\u9875\u81EA\u52A8\u63A2\u6D4B\u540E\u51FA\u73B0\u5728\u8FD9\u91CC" })) : (_jsx("div", { style: { display: 'flex', flexDirection: 'column', gap: 10 }, children: pendingGroups.map(([author, rows]) => (_jsxs("div", { children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 4px', color: '#93c5fd', fontWeight: 600 }, children: [_jsxs("span", { children: ["\uD83D\uDC64 ", author] }), _jsxs("span", { style: { color: '#9ca3af', fontWeight: 400, fontSize: 12 }, children: [rows.length, " \u4E2A\u5F85\u4E0B\u8F7D"] }), _jsx("button", { style: { ...linkBtn, marginLeft: 'auto' }, disabled: busy !== null, onClick: () => void run('download', { videoIds: rows.map((r) => r.id) }, `下载「${author}」全部 ${rows.length} 个`), children: "\u2B07 \u4E0B\u8F7D\u8BE5\u535A\u4E3B\u5168\u90E8" })] }), _jsxs("table", { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 }, children: [_jsx("thead", { children: _jsxs("tr", { style: { color: '#9ca3af', textAlign: 'left' }, children: [_jsx("th", { style: th, children: "\u6807\u9898" }), _jsx("th", { style: th, children: "\u53D1\u5E03\u65F6\u95F4" }), _jsx("th", { style: th, children: "\u64CD\u4F5C" })] }) }), _jsx("tbody", { children: rows.map((v) => (_jsxs("tr", { style: { borderTop: '1px solid #1f2937' }, children: [_jsx("td", { style: td, children: _jsx("span", { title: v.title, children: String(v.title ?? '').slice(0, 60) }) }), _jsx("td", { style: td, children: fmtTime(Number(v.createtime)) }), _jsx("td", { style: td, children: _jsx("button", { style: linkBtn, disabled: busy !== null, onClick: () => void run('download', { videoIds: [v.id ?? ''] }, `开始下载: ${String(v.title ?? '').slice(0, 20)}`), children: "\u4E0B\u8F7D" }) })] }, v.id))) })] })] }, author))) }))] })] })), tab === 'tasks' && (_jsxs("div", { style: card, children: [_jsxs("div", { style: cardTitle, children: ["\u4E0B\u8F7D\u4EFB\u52A1\uFF08", state?.downloader?.total ?? tasks.length, " \u00B7 \u6210\u529F ", state?.downloader?.success ?? 0, " / \u5931\u8D25 ", state?.downloader?.failed ?? 0, " / \u8DF3\u8FC7 ", state?.downloader?.skipped ?? 0, "\uFF09"] }), tasks.length === 0 ? (_jsx("div", { style: { color: '#9ca3af' }, children: "\u6682\u65E0\u4EFB\u52A1 \u2014\u2014 \u5728\u300C\u535A\u4E3B\u300D\u9875\u70B9\u51FB\u4E0B\u8F7D\u540E\u663E\u793A\u8FDB\u5EA6" })) : (_jsx("div", { style: { display: 'flex', flexDirection: 'column', gap: 6 }, children: tasks.map((t) => (_jsxs("div", { style: { background: '#1a1e27', borderRadius: 8, padding: '6px 10px' }, children: [_jsxs("div", { style: { display: 'flex', gap: 8, alignItems: 'center' }, children: [_jsx("span", { style: { color: taskColor(t.state) }, children: taskIcon(t.state) }), _jsx("span", { style: { flex: 1 }, children: String(t.title ?? '').slice(0, 60) }), _jsxs("span", { style: { color: '#9ca3af', fontSize: 12 }, children: [t.state, " ", t.state === 'downloading' ? `${Math.round(t.progress ?? 0)}%` : ''] })] }), t.state === 'downloading' && (_jsx("div", { style: { marginTop: 4, height: 4, background: '#262b36', borderRadius: 2, overflow: 'hidden' }, children: _jsx("div", { style: { width: `${t.progress ?? 0}%`, height: '100%', background: '#3b82f6' } }) }))] }, t.videoId))) }))] })), tab === 'library' && (_jsxs("div", { style: card, children: [_jsxs("div", { style: { ...cardTitle, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, children: [_jsxs("span", { children: ["\u89C6\u9891\u5E93 \u00B7 \u5DF2\u4E0B\u8F7D\uFF08", downloaded.length, "\uFF09"] }), _jsx("select", { value: rangeDays, onChange: (ev) => setRangeDays(Number(ev.target.value)), style: { ...btn, padding: '3px 8px' }, children: RANGES.map((r) => _jsx("option", { value: r.v, children: r.label }, r.v)) }), _jsx("button", { style: { ...linkBtn, marginLeft: 'auto' }, onClick: () => void run('openDownloadsDir', {}, ''), children: "\uD83D\uDCC2 \u6253\u5F00\u5F52\u6863\u76EE\u5F55" })] }), downloaded.length === 0 ? (_jsx("div", { style: { color: '#9ca3af', padding: 8 }, children: "\u8FD8\u6CA1\u6709\u5DF2\u4E0B\u8F7D\u7684\u89C6\u9891 \u2014\u2014 \u5728\u300C\u535A\u4E3B\u300D\u9875\u70B9\u51FB\u4E0B\u8F7D\u540E\uFF0C\u6587\u4EF6\u4F1A\u5F52\u6863\u5230\u8FD9\u91CC\uFF08\u6309\u535A\u4E3B\u5206\u6587\u4EF6\u5939\uFF09" })) : (_jsx("div", { style: { display: 'flex', flexDirection: 'column', gap: 10 }, children: libraryGroups.map(([author, rows]) => (_jsxs("div", { children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 4px', color: '#93c5fd', fontWeight: 600 }, children: [_jsxs("span", { children: ["\uD83D\uDC64 ", author] }), _jsxs("span", { style: { color: '#9ca3af', fontWeight: 400, fontSize: 12 }, children: [rows.length, " \u4E2A\u5DF2\u4E0B\u8F7D"] })] }), _jsxs("table", { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 }, children: [_jsx("thead", { children: _jsxs("tr", { style: { color: '#9ca3af', textAlign: 'left' }, children: [_jsx("th", { style: th, children: "\u6807\u9898" }), _jsx("th", { style: th, children: "\u53D1\u5E03\u65F6\u95F4" }), _jsx("th", { style: th, children: "\u5927\u5C0F" }), _jsx("th", { style: th, children: "\u64CD\u4F5C" })] }) }), _jsx("tbody", { children: rows.map((v) => (_jsxs("tr", { style: { borderTop: '1px solid #1f2937' }, children: [_jsx("td", { style: td, children: _jsx("span", { title: v.title, children: String(v.title ?? '').slice(0, 52) }) }), _jsx("td", { style: td, children: fmtTime(Number(v.createtime)) }), _jsx("td", { style: td, children: fmtSize(Number(v.size ?? 0)) }), _jsx("td", { style: td, children: _jsxs("span", { style: { display: 'inline-flex', gap: 6 }, children: [_jsx("button", { style: linkBtn, disabled: !v.path, onClick: () => void run('openFolder', { path: v.path ?? '' }, ''), children: "\u6253\u5F00\u4F4D\u7F6E" }), _jsx("button", { style: { ...linkBtn, color: '#fca5a5' }, onClick: () => void run('delete', { videoIds: [v.id ?? ''] }, `已删除: ${String(v.title ?? '').slice(0, 20)}`), children: "\u5220\u9664" })] }) })] }, v.id))) })] })] }, author))) }))] })), tab === 'settings' && (_jsxs(_Fragment, { children: [_jsxs("div", { style: card, children: [_jsx("div", { style: cardTitle, children: "\u2460 \u73AF\u5883\u63A2\u6D4B" }), probe ? (_jsx("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 8 }, children: probe.items.map((item) => (_jsxs("div", { style: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', background: '#1a1e27', borderRadius: 8 }, children: [_jsx("span", { style: { color: STATUS_COLOR[item.status], marginTop: 1 }, children: "\u25CF" }), _jsxs("div", { children: [_jsxs("div", { style: { fontWeight: 600 }, children: [item.label, " ", _jsx("span", { style: { color: STATUS_COLOR[item.status], fontWeight: 400 }, children: STATUS_TEXT[item.status] })] }), _jsx("div", { style: { color: '#9ca3af', fontSize: 12 }, children: item.detail }), item.fix && (_jsx("button", { style: { ...btn, marginTop: 6, color: '#93c5fd' }, onClick: () => void run(fixCommandOf(item.fix ?? ''), {}, ''), children: fixLabelOf(item.fix ?? '') }))] })] }, item.id))) })) : (_jsx("div", { style: { color: '#9ca3af' }, children: "\u70B9\u51FB\u9876\u90E8\u300C\u8FD0\u884C\u63A2\u6D4B\u300D\u68C0\u67E5\u73AF\u5883" }))] }), _jsxs("div", { style: card, children: [_jsx("div", { style: cardTitle, children: "\u2461 \u542F\u52A8\u6D41\u7A0B\uFF08\u9996\u6B21\u4F7F\u7528\u6309\u987A\u5E8F\uFF09" }), _jsxs("div", { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }, children: [_jsx("button", { style: btn, onClick: () => void run('installCert', {}, '证书已安装'), disabled: busy !== null, children: "1. \u5B89\u88C5\u8BC1\u4E66" }), _jsx("button", { style: btn, onClick: () => void run('setProxy', { on: true }, '代理已设置'), disabled: busy !== null, children: "2. \u8BBE\u7F6E\u7CFB\u7EDF\u4EE3\u7406" }), _jsx("button", { style: btn, onClick: () => void run('clearCache', {}, '缓存已清理'), disabled: busy !== null, children: "3. \u6E05\u7406\u7F13\u5B58" }), _jsx("button", { style: btn, onClick: () => void run('restartWechat', {}, '已重启微信'), disabled: busy !== null, children: "4. \u91CD\u542F\u5FAE\u4FE1" }), _jsx("button", { style: btn, onClick: () => void run('openChannels', {}, ''), disabled: busy !== null, children: "5. \u6253\u5F00\u89C6\u9891\u53F7" })] }), _jsxs("div", { style: { color: '#9ca3af', fontSize: 12, marginTop: 8 }, children: ["\u5F52\u6863\u76EE\u5F55\uFF1A", state?.downloadsDir ?? '—'] })] }), _jsxs("div", { style: card, children: [_jsxs("div", { style: { ...cardTitle, display: 'flex', alignItems: 'center' }, children: [_jsx("span", { children: "\u2462 \u8FD0\u884C\u65E5\u5FD7" }), _jsx("button", { style: { ...linkBtn, marginLeft: 'auto' }, onClick: () => setLog([]), children: "\u6E05\u7A7A\u65E5\u5FD7" })] }), _jsx("div", { ref: logRef, style: { maxHeight: 200, overflow: 'auto', background: '#0b0e13', borderRadius: 8, padding: 8, fontFamily: 'Consolas, monospace', fontSize: 12, color: '#a5b4fc', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }, children: log.length === 0 ? _jsx("span", { style: { color: '#4b5563' }, children: "\u7B49\u5F85\u4E8B\u4EF6\u2026" }) : log.join('\n') })] })] }))] })] }) }));
}
const btn = { background: '#1f2937', color: '#e5e7eb', border: '1px solid #374151', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 12 };
const btnPrimary = { ...btn, background: '#2563eb', borderColor: '#3b82f6', color: '#fff' };
const linkBtn = { ...btn, padding: '3px 8px', fontSize: 12 };
const card = { background: '#151821', border: '1px solid #1f2937', borderRadius: 12, padding: 12 };
const cardTitle = { fontWeight: 600, marginBottom: 10, color: '#f3f4f6' };
const th = { padding: '6px 8px', fontWeight: 500 };
const td = { padding: '6px 8px', verticalAlign: 'top' };
function fixCommandOf(fix) {
    return { 'install-cert': 'installCert', 'set-proxy': 'setProxy', 'clear-cache-restart': 'clearCache' }[fix] ?? 'runProbe';
}
function fixLabelOf(fix) {
    return { 'install-cert': '安装证书', 'set-proxy': '设置代理', 'clear-cache-restart': '清理缓存' }[fix] ?? '运行探测';
}
function taskColor(s) {
    return s === 'done' ? '#22c55e' : s === 'failed' ? '#ef4444' : s === 'skipped' ? '#94a3b8' : s === 'downloading' ? '#3b82f6' : '#f59e0b';
}
function taskIcon(s) {
    return s === 'done' ? '✓' : s === 'failed' ? '✗' : s === 'skipped' ? '⏭' : s === 'downloading' ? '↓' : '…';
}
/* ------------------------------------------------------------------ */
function WxChannelsButton() {
    const [open, setOpen] = useState(false);
    return (_jsxs(_Fragment, { children: [_jsxs("button", { title: "\u5FAE\u4FE1\u89C6\u9891\u53F7\u6279\u91CF\u4E0B\u8F7D\uFF1A\u5173\u6CE8\u535A\u4E3B \u2192 \u6253\u5F00\u4E3B\u9875\u81EA\u52A8\u63A2\u6D4B \u2192 \u6309\u535A\u4E3B\u4E0B\u8F7D", onClick: () => setOpen((v) => !v), style: {
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '2px 8px',
                    height: 28,
                    borderRadius: 8,
                    border: open ? '1px solid #3b82f6' : '1px solid rgba(128,128,128,0.35)',
                    background: open ? 'rgba(37,99,235,0.15)' : 'transparent',
                    cursor: 'pointer',
                    fontSize: 13,
                    color: 'inherit',
                    whiteSpace: 'nowrap',
                }, children: [_jsx("span", { style: { fontSize: 15 }, children: "\uD83C\uDFAC" }), _jsx("span", { children: "\u89C6\u9891\u53F7" })] }), open && _jsx(WxChannelsConsole, { onClose: () => setOpen(false) })] }));
}
/* ------------------------------------------------------------------ */
/** Required client services; the shell gates service access on this list. */
export const inject = ['slots'];
export function apply(ctx) {
    try {
        const c = ctx;
        c.inject?.(['slots'], (slotsCtx) => {
            const slots = slotsCtx.slots;
            if (!slots)
                return;
            return slots.inject('conversation.input.right', () => {
                try {
                    return slots.register({ name: 'conversation.input.right', id: 'wx-channels-downloader', order: 55, locale: NS }, WxChannelsButton);
                }
                catch {
                    return () => { };
                }
            });
        });
    }
    catch {
        /* never throw during boot */
    }
}
//# sourceMappingURL=index.js.map