const MIME_MAP: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.htm': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.webmanifest': 'application/manifest+json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.txt': 'text/plain; charset=utf-8',
	'.xml': 'application/xml; charset=utf-8',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.map': 'application/json; charset=utf-8',
};

/**
 * 根据扩展名获取 Content-Type
 * @param ext - 带点的扩展名（如 .html）
 * @returns Content-Type，未知类型返回 application/octet-stream
 */
export function mimeType(ext: string): string {
	return MIME_MAP[ext.toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 从文件路径提取扩展名
 * @param pathname - 文件路径
 * @returns 带点的扩展名（如 .html）
 */
export function extOf(pathname: string): string {
	const index = pathname.lastIndexOf('.');
	return index < 0 ? '' : pathname.slice(index).split('?')[0].toLowerCase();
}
