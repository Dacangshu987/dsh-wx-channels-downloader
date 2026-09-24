/** Shared types between the server and browser halves. */

/** One video as captured from a creator profile page (page-context data). */
export interface WxVideo {
  /** object_id / external_id — the dedup key. */
  id: string
  nonceId?: string
  title: string
  /** author key (username v2_xxx@finder) of the profile page. */
  username: string
  nickname: string
  /** seconds-precision publish timestamp. */
  createtime: number
  url: string
  originalUrl?: string
  urlToken?: string
  /** decrypt seed (decode_key) — present for encrypted videos. */
  key?: string
  coverUrl?: string
  thumbUrl?: string
  duration?: number
  size?: number
  type?: 'media' | 'live_replay' | 'picture'
  /** primary quality identifier, e.g. WT111 / 原始视频 */
  fileFormat?: string
  width?: number
  height?: number
  likeCount?: number
  commentCount?: number
  forwardCount?: number
  favCount?: number
}

export type ProbeStatus = 'ok' | 'warn' | 'fail' | 'unknown'

export interface ProbeItem {
  id: string
  label: string
  status: ProbeStatus
  detail: string
  /** for actions the UI can trigger (e.g. install-cert) */
  fix?: string
}

export interface ProbeResult {
  running: boolean
  at: number
  wechatRunning: boolean
  wechatInstalled: boolean
  certInstalled: boolean
  proxySet: boolean
  cachePending: boolean
  items: ProbeItem[]
}

export type DownloadState = 'pending' | 'downloading' | 'done' | 'skipped' | 'failed'

export interface DownloadEntry {
  videoId: string
  title: string
  nickname: string
  username: string
  createtime: number
  state: DownloadState
  progress: number
  path?: string
  error?: string
  startAt?: number
  endAt?: number
}

export interface ServerEvent {
  type: 'probe' | 'captured' | 'download' | 'log' | 'mouse'
  at: number
  probe?: ProbeResult
  video?: WxVideo
  download?: DownloadEntry
  log?: string
}

/** Probe actions the client can request. */
export type ClientCommand =
  | { kind: 'runProbe' }
  | { kind: 'installCert' }
  | { kind: 'setProxy'; on: boolean }
  | { kind: 'clearCache' }
  | { kind: 'restartWechat' }
  | { kind: 'openChannels' }
  | { kind: 'download'; videoIds: string[] }
  | { kind: 'downloadAll' }
  | { kind: 'setAutoDownload'; on: boolean }

export const WEB_API_PREFIX = '/wxchannels'
export const WEB_EVENTS_ENDPOINT = `${WEB_API_PREFIX}/events`