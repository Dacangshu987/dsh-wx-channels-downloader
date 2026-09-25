// wxchannels-inject —— 微信视频号下载进程级拦截器（B 方案）
//
// 自研最小 sidecar：用 SunnyNet（MIT 库）对 WeChatAppEx.exe 做进程级
// HTTPS 拦截（所有域名的 bundle 都能看到），在响应阶段做：
//   1) channels.weixin.qq.com 目标页面 HTML 注入脚本（go:embed 自带页面脚本 + autoShim）
//   2) JS bundle 补丁（index.publish / virtual_svg-icons-register / worker_release）
//   3) /__wx_channels_api/* 本地请求中继到 DSH 插件（http://127.0.0.1:3080/wxchannels/ingest）
// 需要管理员权限（进程注入）。不包含 nobiyou 应用本体。
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"

	"github.com/qtgolang/SunnyNet/SunnyNet"
	"github.com/qtgolang/SunnyNet/public"
)

const pluginBase = "http://127.0.0.1:3080"

func logln(format string, args ...any) {
	fmt.Printf("[wxinject] "+format+"\n", args...)
}

type relayRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body,omitempty"`
}

type relayResponse struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body,omitempty"`
}

// relayToPlugin 把页面脚本的本地 API 调用转发给 DSH 插件处理。
func relayToPlugin(conn *SunnyNet.HttpConn) bool {
	path := conn.Request.URL.Path
	if len(path) < 16 || path[:16] != "/__wx_channels_api/" {
		return false
	}
	body, err := io.ReadAll(conn.Request.Body)
	if err != nil {
		body = nil
	}
	_ = conn.Request.Body.Close()

	headers := map[string]string{}
	for k, vs := range conn.Request.Header {
		if len(vs) > 0 {
			headers[k] = vs[0]
		}
	}

	payload, _ := json.Marshal(relayRequest{
		Method:  conn.Request.Method,
		Path:    path,
		Headers: headers,
		Body:    string(body),
	})

	resp, err := http.Post(pluginBase+"/wxchannels/ingest", "application/json", bytes.NewReader(payload))
	if err != nil {
		logln("relay %s failed: %v", path, err)
		h := http.Header{}
		h.Set("Content-Type", "application/json")
		conn.StopRequest(503, `{"success":false,"error":"plugin unreachable"}`, h)
		return true
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)

	var rr relayResponse
	if err := json.Unmarshal(rb, &rr); err != nil || rr.Status == 0 {
		h := http.Header{}
		h.Set("Content-Type", "application/json")
		conn.StopRequest(resp.StatusCode, string(rb), h)
		return true
	}
	h := http.Header{}
	for k, v := range rr.Headers {
		h.Set(k, v)
	}
	if h.Get("Content-Type") == "" {
		h.Set("Content-Type", "application/json")
	}
	conn.StopRequest(rr.Status, rr.Body, h)
	logln("relay %s %s -> %d (%dB)", conn.Request.Method, path, rr.Status, len(rr.Body))
	return true
}

func handleRequest(conn *SunnyNet.HttpConn) {
	switch conn.Type {
	case public.HttpSendRequest:
		if relayToPlugin(conn) {
			return
		}
	case public.HttpResponseOK:
		if rewriteResponse(conn) {
			return
		}
	}
}

func main() {
	port := 2026
	if len(os.Args) > 1 && os.Args[1] == "-p" && len(os.Args) > 2 {
		fmt.Sscanf(os.Args[2], "%d", &port)
	}
	sunny := SunnyNet.NewSunny()
	sunny.SetPort(port)
	err := sunny.Start().Error
	if err != nil {
		logln("proxy start error: %v", err)
		os.Exit(1)
	}
	sunny.SetGoCallback(handleRequest, nil, nil, nil)
	sunny.ProcessAddName("WeChatAppEx.exe")
	if ok := sunny.StartProcess(); ok {
		logln("✅ 进程注入成功: WeChatAppEx.exe (port %d)", port)
	} else {
		logln("⚠️ 进程注入失败（需要管理员权限）")
	}
	logln("运行中，Ctrl+C 退出")
	select {}
}
