/**
 * Browser half: the 「视频号下载」 button in the composer toolbar opens a
 * console mirroring the wxdown desktop client:
 *   仪表盘 / 博主(关注清单 + 待下载) / 任务 / 视频库(仅已下载) / 设置
 * Watchlist semantics: when the watchlist is non-empty the tool only
 * captures / lists / downloads videos from watched authors ("只探测提前
 * 设定的博主"); an empty watchlist captures everything.
 */
import { useEffect, useRef, useState, useCallback, type CSSProperties } from 'react'
import type { ProbeItem, ProbeResult, ServerEvent, WxVideo } from '../shared/protocol.js'
import { WEB_API_PREFIX, WEB_EVENTS_ENDPOINT } from '../shared/protocol.js'

export const NS = 'wx-channels-downloader'

interface LogLine {
  at: number
  msg: string
}

interface WatchedRow {
  username: string
  nickname: string
  enabled: number
  captured: number
  downloaded: number
}

type CatalogRow = WxVideo & { downloaded?: boolean; path?: string }

interface StateJson {
  ok: boolean
  proxyRunning: boolean
  proxyPort: number
  processInjection?: boolean
  downloadsDir: string
  catalogCount: number
  downloadCount: number
  lastProbe: ProbeResult | null
  logs?: LogLine[]
  watchlist: WatchedRow[]
  watchActive: boolean
  downloader: { running: boolean; total: number; success: number; failed: number; skipped: number; tasks: unknown[] }
  catalog: CatalogRow[]
  catalogAll?: CatalogRow[]
  downloads: unknown[]
}

const RANGES: { v: number; label: string }[] = [
  { v: 0, label: '全部时间' },
  { v: 3, label: '近 3 天' },
  { v: 7, label: '近 7 天' },
  { v: 30, label: '近 30 天' },
  { v: 90, label: '近 90 天' },
]

const TABS = [
  { id: 'dash', label: '仪表盘' },
  { id: 'probe', label: '探测' },
  { id: 'authors', label: '博主' },
  { id: 'tasks', label: '任务' },
  { id: 'library', label: '视频库' },
  { id: 'settings', label: '设置' },
] as const
type TabId = (typeof TABS)[number]['id']

const STATUS_COLOR: Record<string, string> = { ok: '#22c55e', warn: '#f59e0b', fail: '#ef4444', unknown: '#64748b' }
const STATUS_TEXT: Record<string, string> = { ok: '正常', warn: '注意', fail: '异常', unknown: '未知' }

function fmtTime(ts: number): string {
  if (!ts) return '—'
  try {
    return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return String(ts)
  }
}

function fmtSize(bytes: number): string {
  if (!bytes) return '—'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

function groupByAuthor(rows: CatalogRow[]): [string, CatalogRow[]][] {
  const m = new Map<string, CatalogRow[]>()
  for (const v of rows) {
    const k = v.nickname || '未知作者'
    const arr = m.get(k)
    if (arr) arr.push(v)
    else m.set(k, [v])
  }
  return [...m.entries()]
}

async function cmd(command: string, payload: Record<string, unknown> = {}): Promise<void> {
  await fetch(`${WEB_API_PREFIX}/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, payload }),
  })
}

/* ------------------------------------------------------------------ */

function WxChannelsConsole({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<TabId>('dash')
  const [state, setState] = useState<StateJson | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [liveTasks, setLiveTasks] = useState<Record<string, { videoId: string; title: string; state: string; progress: number }>>({})
  const [rangeDays, setRangeDays] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [watchInput, setWatchInput] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${WEB_API_PREFIX}/state`, { cache: 'no-store' })
      const j = (await r.json()) as StateJson
      setState(j)
      const tasks = j.downloader?.tasks ?? []
      const map: Record<string, { videoId: string; title: string; state: string; progress: number }> = {}
      for (const t of tasks as { id?: string; videoId?: string; title?: string; state?: string; progress?: number }[]) {
        map[t.id ?? t.videoId ?? ''] = { videoId: t.id ?? t.videoId ?? '', title: t.title ?? '', state: t.state ?? 'pending', progress: t.progress ?? 0 }
      }
      setLiveTasks(map)
      if (Array.isArray(j.logs) && j.logs.length) {
        setLog((l) => (l.length ? l : (j.logs as LogLine[]).map((x) => `[${new Date(x.at).toLocaleTimeString('zh-CN', { hour12: false })}] ${x.msg}`)))
      }
    } catch {
      setState(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const es = new EventSource(WEB_EVENTS_ENDPOINT)
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data as string) as ServerEvent
      if (e.type === 'probe' && e.probe) {
        setState((s) => (s ? { ...s, lastProbe: e.probe! } : s))
      } else if (e.type === 'captured' && e.video) {
        const cv = e.video as CatalogRow
        setState((s) => {
          if (!s) return s
          if (s.catalog.some((x) => x.id === cv.id)) return s
          const all = (s.catalogAll ?? s.catalog).some((x) => x.id === cv.id)
            ? (s.catalogAll ?? s.catalog)
            : ([cv, ...(s.catalogAll ?? s.catalog)] as CatalogRow[]).slice(0, 600)
          return { ...s, catalog: [cv, ...s.catalog], catalogAll: all, catalogCount: s.catalogCount + 1 }
        })
      } else if (e.type === 'download' && e.download) {
        setLiveTasks((m) => ({ ...m, [e.download!.videoId]: { videoId: e.download!.videoId, title: e.download!.title, state: e.download!.state, progress: e.download!.progress } }))
      } else if (e.type === 'log' && e.log) {
        setLog((l) => [...l.slice(-200), `[${new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false })}] ${e.log}`])
      }
    }
    es.onerror = () => {
      // EventSource auto-reconnects
    }
    return () => es.close()
  }, [refresh])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log])

  const run = async (command: string, payload: Record<string, unknown> = {}, label?: string) => {
    setBusy(command)
    try {
      await cmd(command, payload)
    } finally {
      setBusy(null)
    }
    if (label) setLog((l) => [...l, `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] → ${label}`])
    void refresh()
  }

  const probe = state?.lastProbe
  const tasks = Object.values(liveTasks)
  const watchlist = state?.watchlist ?? []
  const watchActive = state?.watchActive ?? false

  const cutoff = rangeDays > 0 ? Date.now() / 1000 - rangeDays * 86400 : 0
  const inRange = (v: CatalogRow): boolean => !cutoff || Number(v.createtime) >= cutoff
  const allCatalog = state?.catalog ?? []
  const pending = allCatalog.filter((v) => inRange(v) && !v.downloaded && v.url)
  const downloaded = allCatalog.filter((v) => inRange(v) && v.downloaded)
  const pendingGroups = groupByAuthor(pending)
  const libraryGroups = groupByAuthor(downloaded)
  const allProbe = state?.catalogAll ?? state?.catalog ?? []

  const addWatch = async () => {
    const raw = watchInput.trim()
    if (!raw) return
    const isUsername = /@finder|^v2_/.test(raw)
    await run('addWatch', isUsername ? { username: raw } : { nickname: raw }, `已添加关注: ${raw.slice(0, 24)}`)
    setWatchInput('')
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 2147483000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 'min(1080px, 94vw)', height: 'min(780px, 94vh)', background: '#0f1115', color: '#e5e7eb', borderRadius: 14, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.5)', fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', fontSize: 13 }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid #1f2937', background: '#151821' }}>
          <span style={{ fontSize: 17 }}>🎬</span>
          <span style={{ fontWeight: 600, fontSize: 14 }}>微信视频号下载</span>
          <span style={{ fontSize: 12, color: state?.proxyRunning ? '#22c55e' : '#ef4444' }}>
            {state
              ? state.processInjection
                ? `🧬 注入器 ${state.lastProbe?.items?.find((i) => i.id === 'sidecar')?.status === 'ok' ? '运行中' : '未启动'}`
                : `代理 ${state.proxyRunning ? `运行中 (127.0.0.1:${state.proxyPort})` : '未启动'}`
              : '连接中…'}
          </span>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>
            关注 {watchlist.length} · 已采集 {state?.catalogCount ?? 0} · 已下载 {state?.downloadCount ?? 0}
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <button style={btn} onClick={() => void run('runProbe', {}, '探测完成')}>🔄 运行探测</button>
            <button title="关闭面板" onClick={onClose} style={{ width: 28, height: 28, borderRadius: 8, border: '1px solid #374151', background: 'transparent', color: '#9ca3af', cursor: 'pointer', fontSize: 15, lineHeight: 1 }}>
              ✕
            </button>
          </span>
        </div>

        {/* tab bar */}
        <div style={{ display: 'flex', gap: 4, padding: '8px 16px 0', borderBottom: '1px solid #1f2937', background: '#13161d' }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: '7px 14px',
                border: 'none',
                borderBottom: tab === t.id ? '2px solid #3b82f6' : '2px solid transparent',
                background: 'transparent',
                color: tab === t.id ? '#fff' : '#9ca3af',
                cursor: 'pointer',
                fontWeight: tab === t.id ? 600 : 400,
                fontSize: 13,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* body */}
        <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {tab === 'dash' && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                {[
                  { label: '关注博主', value: watchlist.length, color: '#93c5fd' },
                  { label: '已采集视频', value: state?.catalogCount ?? 0, color: '#67e8f9' },
                  { label: '已下载', value: state?.downloadCount ?? 0, color: '#86efac' },
                  { label: '范围内待下载', value: pending.length, color: '#fcd34d' },
                ].map((c) => (
                  <div key={c.label} style={{ ...card, textAlign: 'center', padding: '14px 10px' }}>
                    <div style={{ fontSize: 24, fontWeight: 700, color: c.color }}>{c.value}</div>
                    <div style={{ color: '#9ca3af', fontSize: 12, marginTop: 4 }}>{c.label}</div>
                  </div>
                ))}
              </div>
              <div style={card}>
                <div style={cardTitle}>快捷操作</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button style={btnPrimary} disabled={busy !== null || pending.length === 0} onClick={() => void run('downloadAll', { rangeDays }, `批量下载范围内 ${pending.length} 个`)}>
                    ⬇ 下载范围内待下载（{pending.length}）
                  </button>
                  <button style={btn} onClick={() => setTab('authors')}>⭐ 管理博主 / 待下载</button>
                  <button style={btn} onClick={() => setTab('library')}>🎞️ 已下载视频库</button>
                  <button style={btn} onClick={() => setTab('settings')}>⚙️ 首次配置</button>
                </div>
                <div style={{ color: '#9ca3af', fontSize: 12, marginTop: 10 }}>
                  {watchActive
                    ? '🔒 仅关注模式：当前只采集/显示/下载关注清单内的博主'
                    : '🌐 当前采集全部博主 —— 添加博主到关注清单后，将只探测设定的博主'}
                  。在 PC 微信打开博主主页即自动探测其视频。
                </div>
              </div>
            </>
          )}

          {tab === 'probe' && (
            <div style={card}>
              <div style={{ ...cardTitle, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span>🔍 实时探测 · 全部视频（{allProbe.length}）</span>
                <span style={{ color: '#9ca3af', fontWeight: 400, fontSize: 12 }}>打开博主主页即自动上报，最新探测的实时置顶；不受关注清单过滤</span>
              </div>
              {allProbe.length === 0 ? (
                <div style={{ color: '#9ca3af', padding: 8 }}>暂无探测结果 —— 在 PC 微信打开任一博主主页，视频会实时出现在这里（关注清单只影响「博主/待下载」，不影响本页全部探测）</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: '#9ca3af', textAlign: 'left' }}>
                      <th style={th}>标题</th>
                      <th style={th}>博主</th>
                      <th style={th}>发布时间</th>
                      <th style={th}>状态</th>
                      <th style={th}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allProbe.slice(0, 400).map((v) => {
                      const t = liveTasks[v.id]
                      return (
                        <tr key={v.id} style={{ borderTop: '1px solid #1f2937' }}>
                          <td style={td}><span title={v.title}>{String(v.title ?? '').slice(0, 48)}</span></td>
                          <td style={td}>{v.nickname || '—'}</td>
                          <td style={td}>{fmtTime(Number(v.createtime))}</td>
                          <td style={td}>
                            {v.downloaded ? <span style={{ color: '#22c55e' }}>✓ 已下载</span>
                              : t?.state === 'downloading' ? <span style={{ color: '#3b82f6' }}>↓ {Math.round(t.progress ?? 0)}%</span>
                                : t?.state === 'failed' ? <span style={{ color: '#ef4444' }}>✗ 失败</span>
                                  : <span style={{ color: '#f59e0b' }}>待下载</span>}
                          </td>
                          <td style={td}>
                            {!v.downloaded && t?.state !== 'downloading' ? (
                              <button style={linkBtn} disabled={busy !== null || !v.url} onClick={() => void run('download', { videoIds: [v.id ?? ''] }, `开始下载: ${String(v.title ?? '').slice(0, 20)}`)}>
                                下载
                              </button>
                            ) : (
                              <span style={{ color: '#4b5563' }}>—</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {tab === 'authors' && (
            <>
              <div style={card}>
                <div style={{ ...cardTitle, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span>博主关注清单{watchActive ? '（🔒 仅关注模式）' : '（当前采集全部）'}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <input
                    value={watchInput}
                    onChange={(ev) => setWatchInput(ev.target.value)}
                    onKeyDown={(ev) => { if (ev.key === 'Enter') void addWatch() }}
                    placeholder="粘贴博主 ID（v2_…@finder）或昵称，回车添加"
                    style={{ flex: 1, background: '#1a1e27', border: '1px solid #374151', borderRadius: 8, padding: '7px 10px', color: '#e5e7eb', fontSize: 13 }}
                  />
                  <button style={btnPrimary} onClick={() => void addWatch()}>＋ 添加关注</button>
                </div>
                {watchlist.length === 0 ? (
                  <div style={{ color: '#9ca3af', padding: 8 }}>还没有关注博主 —— 添加后只探测这些博主；不添加则采集全部</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ color: '#9ca3af', textAlign: 'left' }}>
                        <th style={th}>博主</th>
                        <th style={th}>ID</th>
                        <th style={th}>已采集/下载</th>
                        <th style={th}>状态</th>
                        <th style={th}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {watchlist.map((w) => (
                        <tr key={w.username} style={{ borderTop: '1px solid #1f2937' }}>
                          <td style={td}>{w.nickname || '—'}</td>
                          <td style={td}><span style={{ color: '#9ca3af' }}>{w.username}</span></td>
                          <td style={td}>{w.captured} / {w.downloaded}</td>
                          <td style={td}>{w.enabled === 1 ? <span style={{ color: '#22c55e' }}>采集中</span> : <span style={{ color: '#f59e0b' }}>已暂停</span>}</td>
                          <td style={td}>
                            <span style={{ display: 'inline-flex', gap: 6 }}>
                              <button style={linkBtn} onClick={() => void run('setWatchEnabled', { username: w.username, on: w.enabled !== 1 }, '')}>
                                {w.enabled === 1 ? '暂停' : '恢复'}
                              </button>
                              <button style={{ ...linkBtn, color: '#fca5a5' }} onClick={() => void run('removeWatch', { username: w.username }, `已取消关注 ${w.nickname || w.username}`)}>
                                删除
                              </button>
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div style={card}>
                <div style={{ ...cardTitle, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span>关注博主的更新动态（待下载 · {pending.length}）</span>
                  <select value={rangeDays} onChange={(ev) => setRangeDays(Number(ev.target.value))} style={{ ...btn, padding: '3px 8px' }}>
                    {RANGES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
                  </select>
                  <button
                    style={{ ...btnPrimary, marginLeft: 'auto' }}
                    disabled={busy !== null || pending.length === 0}
                    onClick={() => void run('downloadAll', { rangeDays }, `批量下载范围内 ${pending.length} 个`)}
                  >
                    ⬇ 全部下载（{pending.length}）
                  </button>
                </div>
                {pending.length === 0 ? (
                  <div style={{ color: '#9ca3af', padding: 8 }}>暂无待下载视频 —— 打开博主主页自动探测后出现在这里</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {pendingGroups.map(([author, rows]) => (
                      <div key={author}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 4px', color: '#93c5fd', fontWeight: 600 }}>
                          <span>👤 {author}</span>
                          <span style={{ color: '#9ca3af', fontWeight: 400, fontSize: 12 }}>{rows.length} 个待下载</span>
                          <button
                            style={{ ...linkBtn, marginLeft: 'auto' }}
                            disabled={busy !== null}
                            onClick={() => void run('download', { videoIds: rows.map((r) => r.id) }, `下载「${author}」全部 ${rows.length} 个`)}
                          >
                            ⬇ 下载该博主全部
                          </button>
                        </div>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                          <thead>
                            <tr style={{ color: '#9ca3af', textAlign: 'left' }}>
                              <th style={th}>标题</th>
                              <th style={th}>发布时间</th>
                              <th style={th}>操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((v) => (
                              <tr key={v.id} style={{ borderTop: '1px solid #1f2937' }}>
                                <td style={td}><span title={v.title}>{String(v.title ?? '').slice(0, 60)}</span></td>
                                <td style={td}>{fmtTime(Number(v.createtime))}</td>
                                <td style={td}>
                                  <button style={linkBtn} disabled={busy !== null} onClick={() => void run('download', { videoIds: [v.id ?? ''] }, `开始下载: ${String(v.title ?? '').slice(0, 20)}`)}>
                                    下载
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {tab === 'tasks' && (
            <div style={card}>
              <div style={cardTitle}>下载任务（{state?.downloader?.total ?? tasks.length} · 成功 {state?.downloader?.success ?? 0} / 失败 {state?.downloader?.failed ?? 0} / 跳过 {state?.downloader?.skipped ?? 0}）</div>
              {tasks.length === 0 ? (
                <div style={{ color: '#9ca3af' }}>暂无任务 —— 在「博主」页点击下载后显示进度</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {tasks.map((t) => (
                    <div key={t.videoId} style={{ background: '#1a1e27', borderRadius: 8, padding: '6px 10px' }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span style={{ color: taskColor(t.state) }}>{taskIcon(t.state)}</span>
                        <span style={{ flex: 1 }}>{String(t.title ?? '').slice(0, 60)}</span>
                        <span style={{ color: '#9ca3af', fontSize: 12 }}>{t.state} {t.state === 'downloading' ? `${Math.round(t.progress ?? 0)}%` : ''}</span>
                      </div>
                      {t.state === 'downloading' && (
                        <div style={{ marginTop: 4, height: 4, background: '#262b36', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{ width: `${t.progress ?? 0}%`, height: '100%', background: '#3b82f6' }} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'library' && (
            <div style={card}>
              <div style={{ ...cardTitle, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span>视频库 · 已下载（{downloaded.length}）</span>
                <select value={rangeDays} onChange={(ev) => setRangeDays(Number(ev.target.value))} style={{ ...btn, padding: '3px 8px' }}>
                  {RANGES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
                </select>
                <button style={{ ...linkBtn, marginLeft: 'auto' }} onClick={() => void run('openDownloadsDir', {}, '')}>
                  📂 打开归档目录
                </button>
              </div>
              {downloaded.length === 0 ? (
                <div style={{ color: '#9ca3af', padding: 8 }}>还没有已下载的视频 —— 在「博主」页点击下载后，文件会归档到这里（按博主分文件夹）</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {libraryGroups.map(([author, rows]) => (
                    <div key={author}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 4px', color: '#93c5fd', fontWeight: 600 }}>
                        <span>👤 {author}</span>
                        <span style={{ color: '#9ca3af', fontWeight: 400, fontSize: 12 }}>{rows.length} 个已下载</span>
                      </div>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ color: '#9ca3af', textAlign: 'left' }}>
                            <th style={th}>标题</th>
                            <th style={th}>发布时间</th>
                            <th style={th}>大小</th>
                            <th style={th}>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((v) => (
                            <tr key={v.id} style={{ borderTop: '1px solid #1f2937' }}>
                              <td style={td}><span title={v.title}>{String(v.title ?? '').slice(0, 52)}</span></td>
                              <td style={td}>{fmtTime(Number(v.createtime))}</td>
                              <td style={td}>{fmtSize(Number(v.size ?? 0))}</td>
                              <td style={td}>
                                <span style={{ display: 'inline-flex', gap: 6 }}>
                                  <button style={linkBtn} disabled={!v.path} onClick={() => void run('openFolder', { path: v.path ?? '' }, '')}>
                                    打开位置
                                  </button>
                                  <button style={{ ...linkBtn, color: '#fca5a5' }} onClick={() => void run('delete', { videoIds: [v.id ?? ''] }, `已删除: ${String(v.title ?? '').slice(0, 20)}`)}>
                                    删除
                                  </button>
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'settings' && (
            <>
              <div style={card}>
                <div style={cardTitle}>① 环境探测</div>
                {probe ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 8 }}>
                    {probe.items.map((item: ProbeItem) => (
                      <div key={item.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', background: '#1a1e27', borderRadius: 8 }}>
                        <span style={{ color: STATUS_COLOR[item.status], marginTop: 1 }}>●</span>
                        <div>
                          <div style={{ fontWeight: 600 }}>{item.label} <span style={{ color: STATUS_COLOR[item.status], fontWeight: 400 }}>{STATUS_TEXT[item.status]}</span></div>
                          <div style={{ color: '#9ca3af', fontSize: 12 }}>{item.detail}</div>
                          {item.fix && (
                            <button style={{ ...btn, marginTop: 6, color: '#93c5fd' }} onClick={() => void run(fixCommandOf(item.fix ?? ''), {}, '')}>{fixLabelOf(item.fix ?? '')}</button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ color: '#9ca3af' }}>点击顶部「运行探测」检查环境</div>
                )}
              </div>

              <div style={card}>
                <div style={cardTitle}>② 启动流程</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button style={{ ...btnPrimary }} onClick={() => void run('startSidecar', {}, '已请求启动注入器（如弹 UAC 请允许）')} disabled={busy !== null}>
                    🧬 启动进程注入器（需管理员）
                  </button>
                  <span style={{ color: '#9ca3af' }}>（进程注入模式默认开启，可补丁 CDN bundle）</span>
                  <button style={btn} onClick={() => void run('clearCache', {}, '缓存已清理')} disabled={busy !== null}>清缓存</button>
                  <button style={btn} onClick={() => void run('restartWechat', {}, '已重启微信')} disabled={busy !== null}>重启微信</button>
                  <button style={btn} onClick={() => void run('openChannels', {}, '')} disabled={busy !== null}>打开视频号</button>
                </div>
                <div style={{ color: '#9ca3af', fontSize: 12, marginTop: 8 }}>归档目录：{state?.downloadsDir ?? '—'}</div>
              </div>

              <div style={card}>
                <div style={{ ...cardTitle, display: 'flex', alignItems: 'center' }}>
                  <span>③ 运行日志</span>
                  <button style={{ ...linkBtn, marginLeft: 'auto' }} onClick={() => setLog([])}>清空日志</button>
                </div>
                <div ref={logRef} style={{ maxHeight: 200, overflow: 'auto', background: '#0b0e13', borderRadius: 8, padding: 8, fontFamily: 'Consolas, monospace', fontSize: 12, color: '#a5b4fc', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {log.length === 0 ? <span style={{ color: '#4b5563' }}>等待事件…</span> : log.join('\n')}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const btn: CSSProperties = { background: '#1f2937', color: '#e5e7eb', border: '1px solid #374151', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 12 }
const btnPrimary: CSSProperties = { ...btn, background: '#2563eb', borderColor: '#3b82f6', color: '#fff' }
const linkBtn: CSSProperties = { ...btn, padding: '3px 8px', fontSize: 12 }
const card: CSSProperties = { background: '#151821', border: '1px solid #1f2937', borderRadius: 12, padding: 12 }
const cardTitle: CSSProperties = { fontWeight: 600, marginBottom: 10, color: '#f3f4f6' }
const th: CSSProperties = { padding: '6px 8px', fontWeight: 500 }
const td: CSSProperties = { padding: '6px 8px', verticalAlign: 'top' }

function fixCommandOf(fix: string): string {
  return { 'install-cert': 'installCert', 'set-proxy': 'setProxy', 'clear-cache-restart': 'clearCache', 'start-sidecar': 'startSidecar' }[fix] ?? 'runProbe'
}
function fixLabelOf(fix: string): string {
  return { 'install-cert': '安装证书', 'set-proxy': '设置代理', 'clear-cache-restart': '清理缓存', 'start-sidecar': '启动进程注入器' }[fix] ?? '运行探测'
}
function taskColor(s: string): string {
  return s === 'done' ? '#22c55e' : s === 'failed' ? '#ef4444' : s === 'skipped' ? '#94a3b8' : s === 'downloading' ? '#3b82f6' : '#f59e0b'
}
function taskIcon(s: string): string {
  return s === 'done' ? '✓' : s === 'failed' ? '✗' : s === 'skipped' ? '⏭' : s === 'downloading' ? '↓' : '…'
}

/* ------------------------------------------------------------------ */

function WxChannelsButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        title="微信视频号批量下载：关注博主 → 打开主页自动探测 → 按博主下载"
        onClick={() => setOpen((v) => !v)}
        style={{
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
        }}
      >
        <span style={{ fontSize: 15 }}>🎬</span>
        <span>视频号</span>
      </button>
      {open && <WxChannelsConsole onClose={() => setOpen(false)} />}
    </>
  )
}

/* ------------------------------------------------------------------ */

/** Required client services; the shell gates service access on this list. */
export const inject = ['slots']

export function apply(ctx: unknown): void {
  try {
    const c = ctx as { inject?: (names: string[], fn: (sub: Record<string, unknown>) => unknown) => unknown }
    c.inject?.(['slots'], (slotsCtx) => {
      const slots = (slotsCtx as { slots?: SlotsLike }).slots
      if (!slots) return
      return slots.inject('conversation.input.right', () => {
        try {
          return slots.register({ name: 'conversation.input.right', id: 'wx-channels-downloader', order: 55, locale: NS }, WxChannelsButton)
        } catch {
          return () => {}
        }
      })
    })
  } catch {
    /* never throw during boot */
  }
}

interface SlotsLike {
  inject(name: string, fn: () => unknown): unknown
  register(spec: { name: string; id: string; order: number; locale: string }, comp: unknown): () => void
}