import z from 'schemastery';
/** Namespace under Settings -> 插件配置 shown for this plugin. */
export const WXCHANNELS_NAMESPACE = 'wx-channels-downloader';
/** Default proxy port (matches the reference implementation). */
export const DEFAULT_PORT = 2023;
/** CA display/subject name. */
export const CA_CN = 'DSH WxChannels CA';
export const DEFAULT_CONFIG = {
    enabled: true,
    port: DEFAULT_PORT,
    downloadsDir: '',
    autoDownload: false,
    maxConcurrent: 2,
    autoSetProxy: true,
    processInjection: true,
    secretToken: '',
};
/** Settings section schema, rendered by the built-in plugin config page. */
export const Config = z.object({
    enabled: z.boolean().default(DEFAULT_CONFIG.enabled).description('启用插件（启动本地代理与页面注入）。'),
    port: z.number().min(1024).max(65535).default(DEFAULT_CONFIG.port).description('本地 MITM 代理端口。'),
    downloadsDir: z.string().description('视频归档根目录（留空 = $DSH_HOME/wx-channels/downloads）。'),
    autoDownload: z.boolean().default(DEFAULT_CONFIG.autoDownload).description('探测到新视频后自动开始下载。'),
    maxConcurrent: z.number().min(1).max(8).default(DEFAULT_CONFIG.maxConcurrent).description('并发下载数。'),
    autoSetProxy: z.boolean().default(DEFAULT_CONFIG.autoSetProxy).description('启动时自动配置系统代理（关闭需手动设置）。'),
    processInjection: z.boolean().default(DEFAULT_CONFIG.processInjection).description('进程注入模式（B）：用 sidecar 对 WeChatAppEx.exe 做进程级拦截，可补丁 CDN bundle；需管理员。'),
    secretToken: z.string().role('secret').description('注入页面调用本地 API 的鉴权令牌（留空 = 不鉴权）。'),
});
export function resolveConfig(raw) {
    return { ...DEFAULT_CONFIG, ...raw };
}
//# sourceMappingURL=config.js.map