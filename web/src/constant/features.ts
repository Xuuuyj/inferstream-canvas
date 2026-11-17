// 3D 导演台的总开关（业主 2026-11-02：开）。上游只给了构建产物（web/public/director/）、没有源码，源码包里也只能放这份构建产物
// （MODIFICATIONS.md 写明，源码向作者要）。它和画布同源、能读写 localStorage：审过这份构建产物，除了自己的模型文件不请求任何地址，
// 只和画布同源 postMessage，不读 apiKey、baseUrl。换成新的构建产物时要重新审一遍（features.test.ts 有地址名单）。
// 关掉时首页功能演示、画布工具栏、添加节点和连线菜单、侧栏筛选、节点上的「打开导演台」一起隐藏，同时要在 Caddy 对 /director* 回 404。
export const DIRECTOR_ENABLED = true;
