export class Hub {
    listeners = new Set();
    buffer = [];
    subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
    emit(e) {
        for (const fn of this.listeners) {
            try {
                fn(e);
            }
            catch {
                // swallow listener errors
            }
        }
    }
    emitProbe(probe) {
        this.emit({ type: 'probe', at: Date.now(), probe });
    }
    emitCaptured(video) {
        this.emit({ type: 'captured', at: Date.now(), video });
    }
    emitDownload(state) {
        this.emit({ type: 'download', at: Date.now(), download: { ...state } });
    }
    emitLog(log) {
        const line = { at: Date.now(), msg: log };
        this.buffer.push(line);
        if (this.buffer.length > 200)
            this.buffer.splice(0, this.buffer.length - 200);
        this.emit({ type: 'log', at: Date.now(), log });
    }
    recentLogs(limit = 120) {
        return this.buffer.slice(-limit);
    }
}
//# sourceMappingURL=events.js.map