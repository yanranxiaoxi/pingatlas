import type { IResponse } from './venation/transport';

/**
 * 统一的响应安全头
 *
 * 三个项目共用同一实现，仅 `extraConnectSources` 不同：
 * 未登录时前端会直连上游 API，该源必须出现在 `connect-src` 中。
 *
 * 不设置 `Strict-Transport-Security`：TLS 通常在反向代理终止，
 * HSTS 应由代理层统一下发，避免在未启用 HTTPS 的部署中误锁浏览器。
 */

/** 上游源归一化：只取 origin，忽略路径；非法或空值直接丢弃 */
function toOrigin(value: string | undefined): string | null {
	if (!value) {
		return null;
	}
	try {
		return new URL(value).origin;
	}
	catch {
		return null;
	}
}

/**
 * 构建 Content-Security-Policy
 * @param extraConnectSources - 额外允许直连的上游地址（可为空）
 */
function buildCsp(extraConnectSources: string[]): string {
	const connect = ['\'self\''];
	for (const item of extraConnectSources) {
		const origin = toOrigin(item);
		if (origin && !connect.includes(origin)) {
			connect.push(origin);
		}
	}

	const directives: Record<string, string[]> = {
		'default-src': ['\'self\''],
		// 无内联脚本：首屏主题脚本是独立文件
		'script-src': ['\'self\''],
		// 无内联样式：<noscript> 提示已改为 class
		'style-src': ['\'self\''],
		'img-src': ['\'self\'', 'data:'],
		'font-src': ['\'self\''],
		'connect-src': connect,
		'manifest-src': ['\'self\''],
		'object-src': ['\'none\''],
		'base-uri': ['\'none\''],
		'form-action': ['\'self\''],
		'frame-ancestors': ['\'none\''],
	};

	return Object.entries(directives)
		.map(([name, values]) => `${name} ${values.join(' ')}`)
		.join('; ');
}

/**
 * 为响应写入安全头
 *
 * 使用 setHeader 而非 append，避免上游透传的响应覆盖或叠加出多份策略。
 * @param res - 响应对象
 * @param extraConnectSources - 额外允许直连的上游地址
 */
export function applySecurityHeaders(res: IResponse, extraConnectSources: string[] = []): void {
	res.setHeader('Content-Security-Policy', buildCsp(extraConnectSources));
	// 阻止 MIME 嗅探：避免被当作脚本/样式执行
	res.setHeader('X-Content-Type-Options', 'nosniff');
	// 跨站不发送 Referer，同站只发 origin
	res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
	// 与 CSP frame-ancestors 双保险，覆盖不认 CSP 的旧环境
	res.setHeader('X-Frame-Options', 'DENY');
	// 页面不需要这些能力，直接关闭
	res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
}
