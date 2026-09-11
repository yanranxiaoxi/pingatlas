import type { IMiddleware } from '../utils/interface';

import { hrtime } from 'node:process';
import { BasicException } from '../exceptions/basic.exception';

function api(): IMiddleware {
	return async (ctx, next) => {
		// ctx.logger.info(`${ctx.req.method()}`, `${ctx.req.url()}`, `${ctx.req.querystring()}`);
		const start = hrtime.bigint();
		const rsp = ctx.res;
		rsp.setHeader('content-type', 'application/json');
		// rsp.setHeader('Access-Control-Allow-Origin', '*');
		// rsp.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
		// rsp.setHeader('Access-Control-Allow-Headers', 'Content-Type');

		try {
			await next();
			if (/^application\/json/.test(rsp.getHeader('content-type') as string)) {
				const body = JSON.stringify({
					success: true,
					code: ctx.code ?? 0,
					result: ctx.body,
				});

				if (!ctx.res.writableEnded) {
					ctx.res.write(body);
				}
			}
			else {
				ctx.logger.debug('json api ignore');
			}
		}
		catch (ex: any) {
			if (!(ex instanceof BasicException)) {
				ctx.logger.error('json api', ex);
				ex.code = 500;
				ex.msg = '500 Internal Server Error !!!';
			}
			if (ex?.error === 1062) {
				ex.code = 1000001;
			}
			const body = JSON.stringify({
				success: false,
				code: ex.code,
				message: ex?.detail || ex?.msg,
			});
			ctx.res.statusCode = ex.httpCode;
			ctx.res.write(body);
		}
		const end = hrtime.bigint();
		ctx.logger.info(`Benchmark took ${end - start} nanoseconds`);
	};
}

export default api;
