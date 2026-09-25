/**
 * Page injection: HTML rewrite on channels.weixin.qq.com pages + JS bundle
 * patches (ported verbatim from nobiyou/wx_channel's script.go, MIT), plus
 * our own auto-export shim so opening a creator profile auto-captures the
 * full video list (the "打开博主主页自动探测" step).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'inject');
export const TARGET_PAGES = new Set([
    '/web/pages/feed',
    '/web/pages/home',
    '/web/pages/profile',
    '/web/pages/account/like',
]);
const INDEX_PUBLISH_MARKER = '/t/wx_fed/finder/web/web-finder/res/js/index.publish';
const SVG_ICONS_MARKER = '/t/wx_fed/finder/web/web-finder/res/js/virtual_svg-icons-register';
const WORKER_RELEASE_MARKER = 'worker_release';
const CONNECT_PUBLISH_MARKER = 'connect.publish';
const ASSET_FILES = [
    'lib/mitt.umd.js',
    'mitt.umd.js',
    'core.js',
    'decrypt.js',
    'download.js',
    'eventbus.js',
    'utils.js',
    'api_client.js',
    'keep_alive.js',
    'feed.js',
    'profile.js',
    'home.js',
    'batch_download.js',
];
function loadAsset(name) {
    const tries = [join(ASSETS, name)];
    if (name.startsWith('lib/'))
        tries.unshift(join(ASSETS, name.replace('lib/', '')));
    for (const p of tries) {
        if (existsSync(p))
            return readFileSync(p, 'utf8');
    }
    throw new Error(`injection asset missing: ${name} (${ASSETS})`);
}
/** The auto-capture shim: hooks collector events and posts save_video_list. */
function autoShim() {
    return `(function () {
  var TOKEN = window.__WX_LOCAL_TOKEN__ || '';
  function post(path, body) {
    var h = { 'Content-Type': 'application/json' };
    if (TOKEN) h['X-Local-Auth'] = TOKEN;
    return fetch(path, { method: 'POST', headers: h, body: JSON.stringify(body) }).catch(function (e) { console.error('[wxdown]', path, e); });
  }
  function mapVideo(v) {
    if (!v) return null;
    var objDesc = v.objectDesc || {};
    var media = (v.media) || (objDesc.media && objDesc.media[0]) || {};
    var spec = (v.spec && v.spec.length) ? v.spec : (media.spec || []);
    var s0 = spec[0] || {};
    var url = v.url || (media.url + (media.urlToken || ''));
    return {
      id: v.id || v.object_id || media.objectId || '',
      nonceId: v.nonce_id || v.objectNonceId || '',
      title: v.title || objDesc.description || '',
      url: url || v.originalUrl || media.url || '',
      key: v.key || (media.decodeKey || media.decryptKey) || '',
      coverUrl: v.coverUrl || v.thumbUrl || media.thumbUrl || media.coverUrl || '',
      duration: v.duration || (media.videoPlayLen ? media.videoPlayLen * 1000 : media.durationMs) || 0,
      size: v.size || media.fileSize || 0,
      nickname: v.nickname || (v.contact && v.contact.nickname) || '',
      username: (v.contact && v.contact.username) || '',
      createtime: v.createtime || v.create_time || 0,
      type: v.type === 'live_replay' ? 'live_replay' : (v.type === 'picture' ? 'picture' : 'media'),
      fileFormat: s0.fileFormat || s0.qualityType || '',
      width: v.width || s0.width || media.width || 0,
      height: v.height || s0.height || media.height || 0
    };
  }
  function collect() {
    var c = window.__wx_channels_profile_collector;
    if (c && Array.isArray(c.videos) && c.videos.length) {
      return { username: (c.context && c.context.username) || c.username || '', author: (c.videos[0].nickname || ''), videos: c.videos };
    }
    var b = window.__wx_batch_download_manager__;
    if (b && Array.isArray(b.videos) && b.videos.length) {
      return { username: (b.context && b.context.username) || '', author: (b.videos[0].nickname || b.title || ''), videos: b.videos };
    }
    return null;
  }
  var timer = null;
  function flush() {
    timer = null;
    var src = collect();
    if (!src) return;
    var mapped = { username: src.username, author: src.author, videos: src.videos.map(mapVideo).filter(function (v) { return v && v.id && v.url; }) };
    if (!mapped.videos.length) return;
    post('/__wx_channels_api/save_video_list', mapped);
  }
  function schedule() { if (timer) clearTimeout(timer); timer = setTimeout(flush, 1500); }
  function hook() {
    if (typeof WXE === 'undefined') { setTimeout(hook, 500); return; }
    WXE.onUserFeedsLoaded(schedule);
    WXE.onUserLiveReplayLoaded(schedule);
    WXE.onInteractionedFeedsLoaded(schedule);
  }
  setTimeout(hook, 0);
  setInterval(function () {
    var c = window.__wx_channels_profile_collector;
    if (c) {
      var n = (c.videos || []).length;
      if (c._wx_auto_last === undefined) c._wx_auto_last = 0;
      if (n > c._wx_auto_last) { c._wx_auto_last = n; schedule(); }
    }
  }, 3000);
  setTimeout(function () {
    post('/__wx_channels_api/inject_health', { pagePath: location.pathname, href: location.href, reason: 'load' });
  }, 2000);

  // 兜底「批量下载」悬浮按钮：若页面 DOM 选择器变化导致原按钮未注入，8 秒后补一个
  setTimeout(function () {
    try {
      if (!/pages\\/(profile|account\\/like)/.test(location.pathname || '')) return;
      if (document.getElementById('wx-profile-download-btn') || document.getElementById('wxdown-float-batch-btn')) return;
      if (typeof __show_batch_download_ui__ !== 'function') return;
      var btn = document.createElement('button');
      btn.id = 'wxdown-float-batch-btn';
      btn.textContent = '⬇ 批量下载';
      btn.style.cssText = 'position:fixed;right:24px;bottom:120px;z-index:2147483000;background:#07c160;color:#fff;border:none;border-radius:8px;padding:10px 16px;font-size:14px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.3)';
      btn.onclick = function () {
        var c = window.__wx_channels_profile_collector;
        var videos = (c && Array.isArray(c.videos)) ? c.videos : [];
        if (!videos.length) {
          if (window.__wx_log) __wx_log({ msg: '⚠️ 尚未采集到视频，请确认博主主页列表已加载（可下拉刷新）' });
          return;
        }
        try {
          var list = videos.filter(function (v) { return v && (v.type === 'media' || v.type === 'live_replay'); });
          __show_batch_download_ui__(list, '博主视频 (' + list.length + ')');
        } catch (e) { console.error('[wxdown] 批量面板打开失败', e); }
      };
      document.body.appendChild(btn);
    } catch (e) { console.error('[wxdown] 悬浮按钮注入失败', e); }
  }, 8000);
})();`;
}
/** Shims for helpers living in scripts this plugin intentionally omits. */
function shims() {
    return `(function () {
  window.__wx_channels_pause_video__ = function () { return []; };
  window.__wx_channels_resume_video__ = function () {};
  window.__wx_channels_save_page_content = function () {};
  window.__wx_channels_record_download = function () {};
  window.__wx_channels_video_cache_monitor = { addBuffer: function () {}, startMonitoring: function () {}, stopMonitoring: function () {} };
  window.__wx_channels_setup_pending__ = true;
})();`;
}
export class Injector {
    log;
    mitt = '';
    core = '';
    decrypt = '';
    download = '';
    eventbus = '';
    utils = '';
    apiClient = '';
    keepAlive = '';
    feed = '';
    profile = '';
    home = '';
    batchDownload = '';
    constructor(log = () => { }) {
        this.log = log;
        this.mitt = loadAsset('lib/mitt.umd.js');
        this.core = loadAsset('core.js');
        this.decrypt = loadAsset('decrypt.js');
        this.download = loadAsset('download.js');
        this.eventbus = loadAsset('eventbus.js');
        this.utils = loadAsset('utils.js');
        this.apiClient = loadAsset('api_client.js');
        this.keepAlive = loadAsset('keep_alive.js');
        this.feed = loadAsset('feed.js');
        this.profile = loadAsset('profile.js');
        this.home = loadAsset('home.js');
        this.batchDownload = loadAsset('batch_download.js');
    }
    /** Build the <script> block injected into <head> for the given page path. */
    buildPageScripts(path, opts) {
        const tag = (s) => `<script>${s}<\/script>`;
        const parts = [
            `<script>window.__WX_LOCAL_TOKEN__=${JSON.stringify(opts.token)};window.__WX_CHANNELS_VERSION__=${JSON.stringify(opts.version)};<\/script>`,
            tag(this.mitt),
            tag(this.eventbus),
            tag(this.utils),
            tag(this.apiClient),
            tag(this.keepAlive),
            tag(this.core),
            tag(this.decrypt),
            tag(this.download),
            tag(this.batchDownload),
            tag(this.feed),
            tag(this.profile),
            tag(this.home),
            tag(shims()),
            tag(autoShim()),
        ];
        if (path === '/web/pages/feed' || path === '/web/pages/home') {
            parts.push(`<script>setTimeout(function(){if(typeof insert_download_btn==='function'){insert_download_btn();}},1000);<\/script>`);
        }
        return parts.join('\n');
    }
    /** Rewrite one HTML page. Returns null when not a target. */
    rewriteHtml(host, path, html, opts) {
        if (host !== 'channels.weixin.qq.com' || !TARGET_PAGES.has(path))
            return null;
        const scripts = this.buildPageScripts(path, opts);
        return html.replace('<head>', `<head>\n${scripts}`);
    }
    /** Patch one JS bundle. Returns {content, handled}. */
    patchJavaScript(path, content) {
        if (path.includes(INDEX_PUBLISH_MARKER)) {
            const r1 = /this\.sourceBuffer\.appendBuffer\(h\),/;
            const r1Hits = content.match(new RegExp(r1.source, 'g'))?.length ?? 0;
            if (r1Hits > 0) {
                content = content.replace(r1, `(() => { if (window.__wx_channels_store__) { window.__wx_channels_store__.buffers.push(h); } })(),this.sourceBuffer.appendBuffer(h),`);
            }
            const r2 = /if\(f\.cmd===re\.MAIN_THREAD_CMD\.AUTO_CUT/;
            const r2Hits = content.match(new RegExp(r2.source, 'g'))?.length ?? 0;
            if (r2Hits > 0) {
                content = content.replace(r2, `if(f.cmd==="CUT"){ if (window.__wx_channels_store__ && window.__wx_channels_store__.profile) { window.__wx_channels_store__.keys[window.__wx_channels_store__.profile.key]=f.decryptor_array; } }\nif(f.cmd===re.MAIN_THREAD_CMD.AUTO_CUT`);
            }
            this.log(r1Hits > 0 && r2Hits > 0 ? '🩹 index.publish 命中 appendBuffer + AUTO_CUT' : `⚠️ index.publish 部分未命中（appendBuffer=${r1Hits}, AUTO_CUT=${r2Hits}）`);
            return { content, handled: true };
        }
        if (path.includes(SVG_ICONS_MARKER)) {
            // Emits re-target the global event bus (window.WXU || window.WXE) so the
            // patch works no matter which global the bus landed on.
            const emit = (event, expr) => {
                return `var T=window.WXU||window.WXE;if(T&&T.emit){T.emit(T.Events?(T.Events.${event}||'${event}'):'${event}',${expr});}`;
            };
            // Mirrors nobiyou script.go handleVirtualSvgIcons. The `s` flag and
            // `\}\s*async` tail are load-bearing: minified bundles may contain
            // whitespace between methods, and a `\}` + `async` match that ignores
            // it silently misses (the original bug of the indexOf-based port).
            const patch = (label, re, build) => {
                let count = 0;
                content = content.replace(re, (...args) => {
                    count++;
                    const groups = args.slice(0, Math.max(0, args.length - 2));
                    return build(groups);
                });
                this.log(count > 0 ? `🩹 补丁命中 ${label}（${count} 处）` : `⚠️ 补丁未命中 ${label}`);
                return count;
            };
            // Go original: `(?s)async\s+finderGetCommentDetail\s*\(([^)]+)\)\s*\{(.*?)\}\s*async`
            patch('finderGetCommentDetail', /async\s+finderGetCommentDetail\s*\(([^)]+)\)\s*\{(.*?)\}\s*async/gs, (m) => {
                return `async finderGetCommentDetail(${m[1]}){var result=await(async()=>{${m[2]}})();var feed=result.data.object;if(feed){${emit('FeedProfileLoaded', 'feed')}}return result;}async`;
            });
            patch('finderGetCommentList', /async\s+finderGetCommentList\s*\(([^)]+)\)\s*\{(.*?)\}\s*async/gs, (m) => {
                return `async finderGetCommentList(${m[1]}){var result=await(async()=>{${m[2]}})();var feedList=result.data;if(feedList){${emit('FeedCommentListLoaded', 'feedList')}}return result;}async`;
            });
            // Go original anchors on `\{return` for the page-list functions; keep that
            // exact pattern first, with a looser fallback in case the body shape changes.
            const userPageHits = patch('finderUserPage', /async\s+finderUserPage\s*\(([^)]+)\)\s*\{return(.*?)\}\s*async/gs, (m) => {
                return `async finderUserPage(${m[1]}){var result=await(async()=>{return${m[2]}})();if(result&&result.data&&result.data.object){${emit('UserFeedsLoaded', 'result.data.object')}}return result;}async`;
            });
            if (userPageHits === 0) {
                patch('finderUserPage(loose)', /async\s+finderUserPage\s*\(([^)]+)\)\s*\{(.*?)\}\s*async/gs, (m) => {
                    return `async finderUserPage(${m[1]}){var result=await(async()=>{${m[2]}})();if(result&&result.data&&result.data.object){${emit('UserFeedsLoaded', 'result.data.object')}}return result;}async`;
                });
            }
            const livePageHits = patch('finderLiveUserPage', /async\s+finderLiveUserPage\s*\(([^)]+)\)\s*\{return(.*?)\}\s*async/gs, (m) => {
                return `async finderLiveUserPage(${m[1]}){var result=await(async()=>{return${m[2]}})();if(result&&result.data&&result.data.object){${emit('UserLiveReplayLoaded', 'result.data.object')}}return result;}async`;
            });
            if (livePageHits === 0) {
                patch('finderLiveUserPage(loose)', /async\s+finderLiveUserPage\s*\(([^)]+)\)\s*\{(.*?)\}\s*async/gs, (m) => {
                    return `async finderLiveUserPage(${m[1]}){var result=await(async()=>{${m[2]}})();if(result&&result.data&&result.data.object){${emit('UserLiveReplayLoaded', 'result.data.object')}}return result;}async`;
                });
            }
            // Expose the module's exported API functions via APILoaded (guarded).
            const exportRe = /export\s*\{/;
            if (exportRe.test(content)) {
                const m = /export\s*\{([^}]+)\}/.exec(content);
                if (m) {
                    const locals = m[1].split(',').map((s) => s.trim().split(' as ')[0].trim()).filter(Boolean);
                    if (locals.length) {
                        const apiMethods = `{${locals.join(',')}}`;
                        content = content.replace(exportRe, `;var __wx_emit_api=function(){var T=window.WXU||window.WXE;if(T&&T.emit){T.emit(T.Events?(T.Events.APILoaded||'APILoaded'):'APILoaded',${apiMethods});}};__wx_emit_api();export{`);
                    }
                }
                this.log('🩹 补丁命中 export/APILoaded');
            }
            else {
                this.log('⚠️ 补丁未命中 export/APILoaded —— 微信 bundle 可能已改版');
            }
            return { content, handled: true };
        }
        if (path.includes(WORKER_RELEASE_MARKER)) {
            const hits = content.match(/fmp4Index:p\.fmp4Index/g)?.length ?? 0;
            content = content.replace(/fmp4Index:p\.fmp4Index/g, 'decryptor_array:p.decryptor_array,fmp4Index:p.fmp4Index');
            this.log(hits > 0 ? `🩹 worker_release 命中 fmp4Index（${hits} 处）` : '⚠️ worker_release 未命中 fmp4Index');
            return { content, handled: true };
        }
        if (path.includes(CONNECT_PUBLISH_MARKER)) {
            // Cache-busting only; body unchanged.
            return { content, handled: true };
        }
        return { content, handled: false };
    }
}
//# sourceMappingURL=inject.js.map