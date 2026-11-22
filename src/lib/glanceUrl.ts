/** 把形如 "image/42" 的路由拼成 WebView 可请求的 glance 协议 URL（只携带 FileId）。 */
export function glanceUrl(route: string, userAgent: string = navigator.userAgent): string {
  const path = route.replace(/^\/+/, "");
  // Windows（WebView2）把自定义协议映射成 http://<scheme>.localhost。
  return /Windows/i.test(userAgent)
    ? `http://glance.localhost/${path}`
    : `glance://localhost/${path}`;
}
