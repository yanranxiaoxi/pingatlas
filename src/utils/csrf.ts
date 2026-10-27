import type { IContext } from './interface';

/**
 * 判断请求是否来自同源导航
 *
 * 登出走 `GET /api/auth/logout`，而会话 Cookie 是 `SameSite=Lax`；
 * Lax 在**跨站顶层导航**时仍会携带 Cookie，所以 `<a href>`、`img` 之外
 * 的顶层跳转、甚至地址栏粘贴链接都能让受害者被动登出。仅靠 Cookie 属性
 * 挡不住这类 CSRF，需要在服务端确认请求来源。
 *
 * 逐级判断，命中即返回：
 * 1. `Sec-Fetch-Site`（现代浏览器总会发送）：只接受 `same-origin` 与 `none`；
 *    `none` 表示用户直接在地址栏输入或从书签打开，不是跨站请求。
 * 2. `Origin`：与 `Host` 比对。
 * 3. `Referer`：与 `Host` 比对。
 * 4. 三者都没有（旧浏览器、curl、非浏览器客户端）：无法判断来源，放行，
 *    保持脚本与旧环境可用；此时已没有可被利用的浏览器上下文。
 */
export function isSameOriginRequest(ctx: IContext): boolean {
	const site = ctx.req.headers['sec-fetch-site'];
	if (typeof site === 'string' && site) {
		return site === 'same-origin' || site === 'none';
	}

	const host = ctx.req.headers.host;
	if (typeof host !== 'string' || !host) {
		// 没有 Host 头就无法比对来源（如 HTTP/1.0 请求），交给下一层判断
		return true;
	}

	const origin = ctx.req.headers.origin;
	if (typeof origin === 'string' && origin) {
		return matchesHost(origin, host);
	}

	const referer = ctx.req.headers.referer;
	if (typeof referer === 'string' && referer) {
		return matchesHost(referer, host);
	}

	return true;
}

/**
 * 比对 URL 的 authority 与请求 Host
 * @param url - 待判断的完整 URL
 * @param host - 请求的 Host 头
 */
function matchesHost(url: string, host: string): boolean {
	try {
		return new URL(url).host === host;
	}
	catch {
		return false;
	}
}
