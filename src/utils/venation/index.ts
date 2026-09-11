import type { Logger } from 'winston';
import type { VenNodeDriver } from './driver';
import { Router } from '../router';

export class Venation extends Router {
	public constructor(public readonly logger: Logger) {
		super();
	}

	public addDriver(driver: VenNodeDriver) {
		driver.onRequest(async (req, res) => {
			const ctx: any = {
				req,
				res,
				method: req.method ?? '',
				requestParams: {},
				requestFiles: {},
				getQuery: {},
				routerParams: {},
				logger: this.logger,
			};
			const path = req.url ? req.url.split('?')[0] : '';
			try {
				const routeIndex: Array<number> = [];
				const matched = this.checkRoute(ctx, path === '/' ? '' : path, routeIndex);
				if (!matched) {
					if (!res.headersSent) {
						res.statusCode = 404;
						res.setHeader('Content-Type', 'text/plain; charset=utf-8');
						res.end('404 Not Found');
					}
				}
				else {
					await this.run(ctx as any, path === '/' ? '' : path, routeIndex);
					// 控制器只负责 res.write() 写响应体，统一由这里收尾 end()。
					// 注意：不能用 !headersSent 判断——write 后 headersSent 已为 true，
					// 会导致响应永不终止（连接挂起）。应用 !writableEnded 判断是否已 end。
					if (!res.writableEnded) {
						res.end();
					}
				}
			}
			catch (ex) {
				ctx.logger.error(ex);
				if (!res.headersSent) {
					res.statusCode = 500;
					res.setHeader('Content-Type', 'text/plain; charset=utf-8');
					res.end('500 Internal Server Error');
				}
				else {
					// 响应已开始写出时无法再改状态码，只能断开连接
					res.destroy();
				}
			}
		});
	}
}
