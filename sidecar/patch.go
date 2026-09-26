package main

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"embed"
	"fmt"
	"io"
	"regexp"
	"strings"

	"github.com/qtgolang/SunnyNet/SunnyNet"
)

var version = "0.1.0"

//go:embed assets/inject
var assetsFS embed.FS

var scripts map[string][]byte

func init() {
	scripts = map[string][]byte{}
	entries, err := assetsFS.ReadDir("assets/inject")
	if err == nil {
		for _, e := range entries {
			if e.IsDir() {
				sub, _ := assetsFS.ReadDir("assets/inject/" + e.Name())
				for _, f := range sub {
					b, _ := assetsFS.ReadFile("assets/inject/" + e.Name() + "/" + f.Name())
					scripts[f.Name()] = b
				}
				continue
			}
			b, _ := assetsFS.ReadFile("assets/inject/" + e.Name())
			scripts[e.Name()] = b
		}
	}
}

func asset(name string) string {
	if b, ok := scripts[name]; ok {
		return string(b)
	}
	return ""
}

func scriptTag(name string) string {
	return "<script>" + asset(name) + "</script>"
}

// autoShim：自动上报 + 网络钩子 + 兜底批量按钮（与插件端一致）。
const autoShim = `(function () {
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
  function probeTip(msg) { try { post('/__wx_channels_api/tip', { msg: msg }); } catch (e) {} }
  function collectorLen() { var c = window.__wx_channels_profile_collector; return (c && c.videos && c.videos.length) || 0; }
  (function () {
    function addFeeds(feeds, url) {
      if (!feeds || !feeds.length) return 0;
      if (typeof WXU === 'undefined' || !WXU.format_feed) return 0;
      var c = window.__wx_channels_profile_collector;
      if (!c) return 0;
      var added = 0;
      for (var i = 0; i < feeds.length; i++) {
        try { var p = WXU.format_feed(feeds[i]); if (p && p.id) { c.addVideoFromAPI(p); added++; } } catch (e) {}
      }
      if (added) probeTip('[探测] 网络钩子抓到 ' + added + ' 条 / collector=' + collectorLen() + ' (' + String(url).slice(0, 50) + ')');
      return added;
    }
    function extractFeeds(node, depth) {
      var out = [];
      if (!node || typeof node !== 'object' || depth > 7) return out;
      if (Array.isArray(node)) {
        if (node.length && node[0] && typeof node[0] === 'object' && (node[0].objectDesc || node[0].contact)) return node;
        for (var i = 0; i < node.length; i++) out = out.concat(extractFeeds(node[i], depth + 1));
        return out;
      }
      for (var k in node) { if (Object.prototype.hasOwnProperty.call(node, k)) out = out.concat(extractFeeds(node[k], depth + 1)); }
      return out;
    }
    function jsonHook(body, url) {
      try {
        if (!body || typeof body !== 'string' || body.length > 8 * 1024 * 1024) return;
        var u = String(url || '');
        if (u.indexOf('/__wx_channels_api/') !== -1) return;
        if (u.indexOf('finder') === -1 && u.indexOf('mmfinderassistant') === -1 && u.indexOf('feedlist') === -1 && u.indexOf('userpage') === -1 && u.indexOf('feed_list') === -1) return;
        var obj;
        try { obj = JSON.parse(body); } catch (e) { return; }
        var feeds = extractFeeds(obj, 0);
        if (feeds.length) addFeeds(feeds, u);
      } catch (e) {}
    }
    function hookXhr() {
      if (!window.XMLHttpRequest) return;
      var proto = XMLHttpRequest.prototype;
      if (proto.__wxdownHooked) return;
      proto.__wxdownHooked = true;
      var oOpen = proto.open, oSend = proto.send;
      proto.open = function (m, u) { this.__wxdownUrl = u; return oOpen.apply(this, arguments); };
      proto.send = function () {
        var self = this;
        this.addEventListener('load', function () {
          try { if (self.responseText) jsonHook(self.responseText, self.__wxdownUrl || ''); } catch (e) {}
        });
        return oSend.apply(this, arguments);
      };
    }
    function hookFetch() {
      var w = window;
      if (!w.fetch || w.fetch.__wxdownHooked) return;
      var orig = w.fetch;
      w.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var p = orig.apply(this, arguments);
        try {
          p.then(function (res) {
            try {
              if (res && res.ok && res.clone && res.headers && /json/.test(String(res.headers.get('content-type') || ''))) {
                res.clone().text().then(function (t) { jsonHook(t, url); }).catch(function () {});
              }
            } catch (e) {}
          });
        } catch (e) {}
        return p;
      };
      w.fetch.__wxdownHooked = true;
    }
    hookXhr();
    hookFetch();
  })();
  function hook() {
    if (typeof WXE === 'undefined') { setTimeout(hook, 500); return; }
    // Report the runtime capabilities that the collector path depends on, so
    // a missing piece is visible instead of an empty list.
    try {
      var caps = {
        wxe: true,
        wxu: typeof WXU !== 'undefined',
        format_feed: !!(typeof WXU !== 'undefined' && WXU.format_feed),
        collector: !!window.__wx_channels_profile_collector,
        addVideo: !!(window.__wx_channels_profile_collector && window.__wx_channels_profile_collector.addVideoFromAPI),
        isListPageFn: typeof __wx_is_profile_like_list_page__ === 'function',
        isListPage: (typeof __wx_is_profile_like_list_page__ === 'function') ? __wx_is_profile_like_list_page__() : null,
        path: location.pathname,
        events: (WXE.Events && Object.keys(WXE.Events).length) || 0
      };
      probeTip('[能力] ' + JSON.stringify(caps));
    } catch (e) { probeTip('[能力] 检查失败 ' + e.message); }

    WXE.onUserFeedsLoaded(function (feeds) { probeTip('[探测] UserFeedsLoaded ' + ((feeds && feeds.length) || 0) + ' 条 / collector=' + collectorLen()); });
    WXE.onUserLiveReplayLoaded(function (feeds) { probeTip('[探测] UserLiveReplayLoaded ' + ((feeds && feeds.length) || 0) + ' 条 / collector=' + collectorLen()); });
    WXE.onInteractionedFeedsLoaded(function (p) { var f = (p && p.feeds) || p || []; probeTip('[探测] InteractionedFeedsLoaded ' + (f.length || 0) + ' 条 / collector=' + collectorLen()); });
    WXE.onUserFeedsLoaded(schedule);
    WXE.onUserLiveReplayLoaded(schedule);
    WXE.onInteractionedFeedsLoaded(schedule);
    probeTip('[能力] 事件监听已注册');
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
  setTimeout(function () { post('/__wx_channels_api/inject_health', { pagePath: location.pathname, href: location.href, reason: 'load' }); }, 2000);
  setTimeout(function () {
    try {
      if (!/pages\/(profile|account\/like)/.test(location.pathname || '')) return;
      if (document.getElementById('wx-profile-download-btn') || document.getElementById('wxdown-float-batch-btn')) return;
      if (typeof __show_batch_download_ui__ !== 'function') return;
      var btn = document.createElement('button');
      btn.id = 'wxdown-float-batch-btn';
      btn.textContent = '⬇ 批量下载';
      btn.style.cssText = 'position:fixed;right:24px;bottom:120px;z-index:2147483000;background:#07c160;color:#fff;border:none;border-radius:8px;padding:10px 16px;font-size:14px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.3)';
      btn.onclick = function () {
        var c = window.__wx_channels_profile_collector;
        var videos = (c && Array.isArray(c.videos)) ? c.videos : [];
        if (!videos.length) { if (window.__wx_log) __wx_log({ msg: '⚠️ 尚未采集到视频，请确认博主主页列表已加载' }); return; }
        try {
          var list = videos.filter(function (v) { return v && (v.type === 'media' || v.type === 'live_replay'); });
          __show_batch_download_ui__(list, '博主视频 (' + list.length + ')');
        } catch (e) { console.error('[wxdown] 批量面板打开失败', e); }
      };
      document.body.appendChild(btn);
    } catch (e) { console.error('[wxdown] 悬浮按钮注入失败', e); }
  }, 8000);
})();`

const shims = `(function () {
  window.__wx_channels_pause_video__ = function () { return []; };
  window.__wx_channels_resume_video__ = function () {};
  window.__wx_channels_save_page_content = function () {};
  window.__wx_channels_record_download = function () {};
  window.__wx_channels_video_cache_monitor = { addBuffer: function () {}, startMonitoring: function () {}, stopMonitoring: function () {} };
  window.__wx_channels_setup_pending__ = true;
})();`

func buildInjectedScripts(path string) string {
	parts := []string{
		`<script>window.__WX_LOCAL_TOKEN__="";window.__WX_CHANNELS_VERSION__="` + version + `";</script>`,
		scriptTag("mitt.umd.js"),
		scriptTag("eventbus.js"),
		scriptTag("utils.js"),
		scriptTag("api_client.js"),
		scriptTag("keep_alive.js"),
		scriptTag("core.js"),
		scriptTag("decrypt.js"),
		scriptTag("download.js"),
		scriptTag("batch_download.js"),
		scriptTag("feed.js"),
		scriptTag("profile.js"),
		scriptTag("home.js"),
		"<script>" + shims + "</script>",
		"<script>" + autoShim + "</script>",
	}
	if path == "/web/pages/feed" || path == "/web/pages/home" {
		parts = append(parts, `<script>setTimeout(function(){if(typeof insert_download_btn==='function'){insert_download_btn();}},1000);</script>`)
	}
	return strings.Join(parts, "\n")
}

// decodeBody undoes the Content-Encoding a client asked for. WeChat requests
// pages and bundles with "Accept-Encoding: gzip", so the bytes reaching this
// hook are compressed: searching them for "<head>" or a function name never
// matches, and the patch silently disappears. Returns the decoded payload and
// the encoding that was applied (empty when the body was already plain).
func decodeBody(body []byte, encoding string) ([]byte, string) {
	enc := strings.ToLower(strings.TrimSpace(encoding))
	switch {
	case enc == "" || enc == "identity":
		return body, ""
	case strings.Contains(enc, "gzip"):
		r, err := gzip.NewReader(bytes.NewReader(body))
		if err != nil {
			return body, ""
		}
		defer r.Close()
		if dec, err := io.ReadAll(r); err == nil {
			return dec, "gzip"
		}
		return body, ""
	case strings.Contains(enc, "deflate"):
		r := flate.NewReader(bytes.NewReader(body))
		defer r.Close()
		if dec, err := io.ReadAll(r); err == nil {
			return dec, "deflate"
		}
		return body, ""
	default:
		// br / zstd / anything else: leave untouched (we only re-encode what
		// we can reproduce, and the caller falls back to passthrough).
		return body, ""
	}
}

// encodeBody re-applies an encoding produced by decodeBody.
func encodeBody(data []byte, encoding string) ([]byte, bool) {
	switch encoding {
	case "":
		return data, true
	case "gzip":
		var buf bytes.Buffer
		w := gzip.NewWriter(&buf)
		if _, err := w.Write(data); err != nil {
			return nil, false
		}
		if err := w.Close(); err != nil {
			return nil, false
		}
		return buf.Bytes(), true
	case "deflate":
		var buf bytes.Buffer
		w, err := flate.NewWriter(&buf, flate.DefaultCompression)
		if err != nil {
			return nil, false
		}
		if _, err := w.Write(data); err != nil {
			return nil, false
		}
		if err := w.Close(); err != nil {
			return nil, false
		}
		return buf.Bytes(), true
	default:
		return nil, false
	}
}

func rewriteResponse(conn *SunnyNet.HttpConn) bool {
	if conn.Response == nil || conn.Response.Body == nil {
		return false
	}
	host := conn.Request.URL.Hostname()
	path := conn.Request.URL.Path
	ct := strings.ToLower(conn.Response.Header.Get("content-type"))
	raw, err := io.ReadAll(conn.Response.Body)
	if err != nil {
		return false
	}
	_ = conn.Response.Body.Close()

	body, encoding := decodeBody(raw, conn.Response.Header.Get("content-encoding"))

	var out []byte
	if host == "channels.weixin.qq.com" && strings.Contains(ct, "text/html") {
		switch path {
		case "/web/pages/feed", "/web/pages/home", "/web/pages/profile", "/web/pages/account/like":
			html := string(body)
			if strings.Contains(html, "<head>") {
				html = strings.Replace(html, "<head>", "<head>\n"+buildInjectedScripts(path), 1)
				out = []byte(html)
				logln("注入页面 %s (%dB, enc=%s)", path, len(out), encoding)
			} else {
				logln("⚠️ 注入页面前缀未命中 %s (%dB, enc=%s) —— 响应可能已压缩或结构变化", path, len(body), encoding)
			}
		}
	} else if strings.Contains(ct, "javascript") || strings.Contains(ct, "ecmascript") {
		if patched, ok := patchBundle(path, string(body)); ok {
			out = patched
			logln("补丁JS %s (%dB, enc=%s)", path, len(out), encoding)
		}
	}

	if out == nil {
		conn.Response.Body = io.NopCloser(bytes.NewReader(raw))
		return false
	}

	// Disable caching for patched responses (same as nobiyou's connect.publish
	// handling): WeChat otherwise serves the pre-patch bundle from its HTTP /
	// memory cache and the injected code never runs.
	conn.Response.Header.Set("Cache-Control", "no-cache, no-store, must-revalidate")
	conn.Response.Header.Set("Pragma", "no-cache")
	conn.Response.Header.Set("Expires", "0")

	// Re-apply the original encoding so the client can still decode it.
	final, ok := encodeBody(out, encoding)
	if !ok {
		conn.Response.Body = io.NopCloser(bytes.NewReader(raw))
		return false
	}
	conn.Response.Body = io.NopCloser(bytes.NewReader(final))
	conn.Response.ContentLength = int64(len(final))
	conn.Response.Header.Set("Content-Length", fmt.Sprintf("%d", len(final)))
	if len(out) != len(final) {
		conn.Response.Header.Set("Content-Encoding", encoding)
	}
	return true
}

// ---- JS bundle 补丁（与插件端 TS 对齐，语义同 nobiyou script.go） ----

var (
	reAppend = regexp.MustCompile(`this\.sourceBuffer\.appendBuffer\(h\),`)
	reAutoCut = regexp.MustCompile(`if\(f\.cmd===re\.MAIN_THREAD_CMD\.AUTO_CUT`)
	reWorker  = regexp.MustCompile(`fmp4Index:p\.fmp4Index`)
	reExport  = regexp.MustCompile(`export\s*\{`)
	reExportBlock = regexp.MustCompile(`export\s*\{([^}]+)\}`)
)

// emitJS emits an event on BOTH buses. The injected page scripts listen on
// WXE (the mitt event bus that profile.js subscribes to via
// WXE.onUserFeedsLoaded), while WXU is WeChat's own utility object. Preferring
// WXU alone sent every event to a bus nobody consumed, so the collector stayed
// empty and the page reported "no video data".
func emitJS(event, expr string) string {
	return `(function(){var v=` + expr + `;` +
		`try{if(window.WXE&&window.WXE.emit){window.WXE.emit((window.WXE.Events&&window.WXE.Events.` + event + `)||'` + event + `',v);}}catch(e){}` +
		`try{if(window.WXU&&window.WXU.emit){window.WXU.emit((window.WXU.Events&&window.WXU.Events.` + event + `)||'` + event + `',v);}}catch(e){}` +
		`})();`
}

// patchSingleExpr wraps an `async name(args){return <expr>}` method so its
// resolved value is also emitted on the page event bus. Newer WeChat builds
// write these endpoints as single-expression bodies (no IIFE), which the
// patchFunc IIFE/return-anchor patterns do not cover.
func patchSingleExpr(content, name, event string) string {
	re := regexp.MustCompile(`(?s)async\s+` + name + `\s*\(([^)]*)\)\s*\{return\s+(.*?)\}\s*async`)
	return re.ReplaceAllStringFunc(content, func(m string) string {
		g := re.FindStringSubmatch(m)
		if g == nil {
			return m
		}
		params, expr := g[1], g[2]
		return `async ` + name + `(` + params + `){var result=await(` + expr + `);try{if(window.__wx_log){__wx_log({msg:'[补丁] ` + name + ` 返回, n='+((result&&result.data&&(result.data.object||result.data.feedList||result.data.list)&&(result.data.object||result.data.feedList||result.data.list).length)||0)});}}catch(e){}` +
			`try{var L=(result&&result.data&&(result.data.object||result.data.feedList||result.data.list))||null;if(L&&L.length){` + emitJS(event, "L") + `}}catch(e){}return result;}async`
	})
}

// patchFunc 通用：`async name(params){body}async`，带/不带 return 锚点。
func patchFunc(content, name string, anchoredReturn bool, build func(params, body string) string) string {
	var re *regexp.Regexp
	if anchoredReturn {
		re = regexp.MustCompile(`(?s)async\s+` + name + `\s*\(([^)]+)\)\s*\{return(.*?)\}\s*async`)
	} else {
		re = regexp.MustCompile(`(?s)async\s+` + name + `\s*\(([^)]+)\)\s*\{(.*?)\}\s*async`)
	}
	return re.ReplaceAllStringFunc(content, func(m string) string {
		sub := re.FindStringSubmatch(m)
		if len(sub) < 3 {
			return m
		}
		return build(sub[1], sub[2])
	})
}

func patchBundle(path, content string) ([]byte, bool) {
	switch {
	case strings.Contains(path, "/t/wx_fed/finder/web/web-finder/res/js/index.publish"):
		if reAppend.MatchString(content) {
			content = reAppend.ReplaceAllString(content, `(() => { if (window.__wx_channels_store__) { window.__wx_channels_store__.buffers.push(h); } })(),this.sourceBuffer.appendBuffer(h),`)
		}
		if reAutoCut.MatchString(content) {
			content = reAutoCut.ReplaceAllString(content, `if(f.cmd==="CUT"){ if (window.__wx_channels_store__ && window.__wx_channels_store__.profile) { window.__wx_channels_store__.keys[window.__wx_channels_store__.profile.key]=f.decryptor_array; } }`+"\n"+`if(f.cmd===re.MAIN_THREAD_CMD.AUTO_CUT`)
		}
		return []byte(content), true

	case strings.Contains(path, "/t/wx_fed/finder/web/web-finder/res/js/virtual_svg-icons-register"):
		content = patchFunc(content, "finderGetCommentDetail", false, func(p, b string) string {
			return `async finderGetCommentDetail(` + p + `){var result=await(async()=>{` + b + `})();var feed=result.data.object;if(feed){` + emitJS("FeedProfileLoaded", "feed") + `}return result;}async`
		})
		content = patchFunc(content, "finderGetCommentList", false, func(p, b string) string {
			return `async finderGetCommentList(` + p + `){var result=await(async()=>{` + b + `})();var feedList=result.data;if(feedList){` + emitJS("FeedCommentListLoaded", "feedList") + `}return result;}async`
		})
		before := content
		content = patchFunc(content, "finderUserPage", true, func(p, b string) string {
			return `async finderUserPage(` + p + `){var result=await(async()=>{return` + b + `})();try{if(window.__wx_log){__wx_log({msg:'[补丁] finderUserPage 返回, object='+!!(result&&result.data&&result.data.object)+', n='+((result&&result.data&&result.data.object&&result.data.object.length)||0)});}}catch(e){}if(result&&result.data&&result.data.object){` + emitJS("UserFeedsLoaded", "result.data.object") + `}return result;}async`
		})
		if content == before {
			content = patchFunc(content, "finderUserPage", false, func(p, b string) string {
				return `async finderUserPage(` + p + `){var result=await(async()=>{` + b + `})();try{if(window.__wx_log){__wx_log({msg:'[补丁] finderUserPage 返回(loose), object='+!!(result&&result.data&&result.data.object)});}}catch(e){}if(result&&result.data&&result.data.object){` + emitJS("UserFeedsLoaded", "result.data.object") + `}return result;}async`
			})
		}

		// WeChat moved the creator-profile feed list onto these endpoints
		// (FetchFinderMemberFeedList / FinderUserPagePreview). They are written
		// as single-expression arrow bodies, so wrap the call and emit the
		// same UserFeedsLoaded event the collector listens for.
		content = patchSingleExpr(content, "fetchFinderMemberFeedList", "UserFeedsLoaded")
		content = patchSingleExpr(content, "finderUserPagePreview", "UserFeedsLoaded")

		before = content
		content = patchFunc(content, "finderLiveUserPage", true, func(p, b string) string {			return `async finderLiveUserPage(` + p + `){var result=await(async()=>{return` + b + `})();if(result&&result.data&&result.data.object){` + emitJS("UserLiveReplayLoaded", "result.data.object") + `}return result;}async`
		})
		if content == before {
			content = patchFunc(content, "finderLiveUserPage", false, func(p, b string) string {
				return `async finderLiveUserPage(` + p + `){var result=await(async()=>{` + b + `})();if(result&&result.data&&result.data.object){` + emitJS("UserLiveReplayLoaded", "result.data.object") + `}return result;}async`
			})
		}
		if m := reExportBlock.FindStringSubmatch(content); m != nil {
			locals := []string{}
			for _, item := range strings.Split(m[1], ",") {
				item = strings.TrimSpace(item)
				if item == "" {
					continue
				}
				idx := strings.Index(item, " as ")
				if idx != -1 {
					item = strings.TrimSpace(item[:idx])
				}
				if item != "" && item != " " {
					locals = append(locals, item)
				}
			}
			if len(locals) > 0 {
				apiMethods := "{" + strings.Join(locals, ",") + "}"
				// Same dual-bus rule as emitJS: the page scripts subscribe on WXE.
				js := ";var __wx_emit_api=function(){var m=" + apiMethods + ";" +
					"try{if(window.WXE&&window.WXE.emit){window.WXE.emit((window.WXE.Events&&window.WXE.Events.APILoaded)||'APILoaded',m);}}catch(e){}" +
					"try{if(window.WXU&&window.WXU.emit){window.WXU.emit((window.WXU.Events&&window.WXU.Events.APILoaded)||'APILoaded',m);}}catch(e){}" +
					"};__wx_emit_api();export{"
				content = reExport.ReplaceAllString(content, js)
			}
		}
		return []byte(content), true

	case strings.Contains(path, "worker_release"):
		content = reWorker.ReplaceAllString(content, "decryptor_array:p.decryptor_array,fmp4Index:p.fmp4Index")
		return []byte(content), true

	case strings.Contains(path, "connect.publish"):
		// Cache-busting only; body unchanged.
		return []byte(content), true
	}
	return nil, false
}
