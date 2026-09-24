# Vendored injection assets

These page-side scripts are copied from **nobiyou/wx_channel** (MIT License,
https://github.com/nobiyou/wx_channel) — the reference implementation this plugin
re-implements. They run inside WeChat's channels pages after the local proxy injects
them (HTML injection on channels.weixin.qq.com/web/pages/* + JS bundle patches).
Only the scripts needed by this plugin are kept; service side is native TypeScript.

Source directory: D:\ds-harness-test\cz\wxdown\tools\nobiyou-src\internal\assets\inject
