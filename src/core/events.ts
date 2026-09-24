/** Minimal typed event hub driving the client SSE stream, with a recent-log ring buffer. */
import type { ProbeResult, ServerEvent, WxVideo } from '../shared/protocol.js'

export interface LogLine {
  at: number
  msg: string
}

export class Hub {
  private listeners = new Set<(e: ServerEvent) => void>()
  private buffer: LogLine[] = []

  subscribe(fn: (e: ServerEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit(e: ServerEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e)
      } catch {
        // swallow listener errors
      }
    }
  }

  emitProbe(probe: ProbeResult): void {
    this.emit({ type: 'probe', at: Date.now(), probe })
  }

  emitCaptured(video: WxVideo): void {
    this.emit({ type: 'captured', at: Date.now(), video })
  }

  emitDownload(state: { videoId: string; title: string; nickname: string; username: string; createtime: number; state: 'pending' | 'downloading' | 'done' | 'skipped' | 'failed'; progress: number; path?: string; error?: string }): void {
    this.emit({ type: 'download', at: Date.now(), download: { ...state } })
  }

  emitLog(log: string): void {
    const line: LogLine = { at: Date.now(), msg: log }
    this.buffer.push(line)
    if (this.buffer.length > 200) this.buffer.splice(0, this.buffer.length - 200)
    this.emit({ type: 'log', at: Date.now(), log })
  }

  recentLogs(limit = 120): LogLine[] {
    return this.buffer.slice(-limit)
  }
}