import type { VenNodeDriver } from '../../src/utils/venation/driver';
import { describe, expect, it, jest } from '@jest/globals';
import { Venation } from '../../src/utils/venation/index';
import { createMockLogger, createMockRequest, createMockResponse } from '../helpers/http';

/** 捕获 onRequest 回调的假驱动 */
class FakeDriver {
	public handlers: Array<(req: unknown, res: unknown) => unknown> = [];

	public onRequest(cb: (req: unknown, res: unknown) => unknown) {
		this.handlers.push(cb);
	}
}

function setup(logger = createMockLogger()) {
	const driver = new FakeDriver();
	const app = new Venation(logger as never);
	app.addDriver(driver as unknown as VenNodeDriver);

	const dispatch = async (url: string, method = 'GET') => {
		// 路由注册时 `get()`/`all()` 通过 promise 回调补写 method，先让微任务清空
		await new Promise(resolve => setTimeout(resolve, 0));
		const req = createMockRequest({ url, method });
		const res = createMockResponse();
		for (const handler of driver.handlers) {
			await handler(req, res);
		}
		return res;
	};

	return { app, driver, dispatch, logger };
}

describe('Venation 请求分发', () => {
	it('注册 onRequest 回调到驱动', () => {
		const { driver } = setup();
		expect(driver.handlers).toHaveLength(1);
	});

	it('未匹配路由返回 404 纯文本', async () => {
		const { app, dispatch } = setup();
		app.get('/known', async () => {});

		const res = await dispatch('/missing');

		expect(res.statusCode).toBe(404);
		expect(res.getHeader('content-type')).toBe('text/plain; charset=utf-8');
		expect(res.body).toBe('404 Not Found');
		expect(res.writableEnded).toBe(true);
	});

	it('方法不匹配同样返回 404', async () => {
		const { app, dispatch } = setup();
		app.get('/only-get', async () => {});

		const res = await dispatch('/only-get', 'POST');
		expect(res.statusCode).toBe(404);
	});

	it('匹配后执行控制器，并由 Venation 统一 end()', async () => {
		const { app, dispatch } = setup();
		app.get('/hello', async (ctx) => {
			ctx.res.statusCode = 201;
			ctx.res.setHeader('Content-Type', 'application/json');
			ctx.res.write('{"ok":true}');
		});

		const res = await dispatch('/hello');

		expect(res.statusCode).toBe(201);
		expect(res.body).toBe('{"ok":true}');
		expect(res.writableEnded).toBe(true);
		expect(res.destroyed).toBe(false);
	});

	it('控制器自己 end() 后不会重复写入', async () => {
		const { app, dispatch } = setup();
		app.get('/ended', async (ctx) => {
			ctx.res.end('done');
		});

		const res = await dispatch('/ended');
		expect(res.body).toBe('done');
		expect(res.writableEnded).toBe(true);
	});

	it('根路径 / 被规范化为空路径交给根路由', async () => {
		const { app, dispatch } = setup();
		app.get('', async (ctx) => {
			ctx.res.write('index');
		});

		const res = await dispatch('/');
		expect(res.statusCode).toBe(200);
		expect(res.body).toBe('index');
	});

	it('查询串不参与路由匹配', async () => {
		const { app, dispatch } = setup();
		app.get('/search', async (ctx) => {
			ctx.res.write('found');
		});

		const res = await dispatch('/search?q=1&x=2');
		expect(res.body).toBe('found');
	});

	it('控制器抛错且未写响应时返回 500 并记录日志', async () => {
		const logger = createMockLogger();
		const errorSpy = jest.spyOn(logger, 'error');
		const { app, dispatch } = setup(logger);
		app.get('/boom', async () => {
			throw new Error('exploded');
		});

		const res = await dispatch('/boom');

		expect(errorSpy).toHaveBeenCalledWith(expect.any(Error));
		expect(res.statusCode).toBe(500);
		expect(res.getHeader('content-type')).toBe('text/plain; charset=utf-8');
		expect(res.body).toBe('500 Internal Server Error');
		expect(res.writableEnded).toBe(true);
	});

	it('控制器写响应后抛错则销毁连接', async () => {
		const { app, dispatch } = setup();
		app.get('/partial', async (ctx) => {
			ctx.res.write('partial');
			throw new Error('late failure');
		});

		const res = await dispatch('/partial');
		expect(res.destroyed).toBe(true);
		expect(res.writableEnded).toBe(false);
	});

	it('ctx 暴露 method / routerParams / logger / res / req', async () => {
		const { app, dispatch } = setup();
		let captured: Record<string, unknown> = {};
		app.post('/measurements/:id', async (ctx) => {
			captured = {
				method: ctx.method,
				routerParams: ctx.routerParams,
				hasLogger: Boolean(ctx.logger),
				hasReq: Boolean(ctx.req),
				hasRes: Boolean(ctx.res),
			};
			ctx.res.write('ok');
		});

		await dispatch('/measurements/abc', 'POST');

		expect(captured).toEqual({
			method: 'POST',
			routerParams: { id: 'abc' },
			hasLogger: true,
			hasReq: true,
			hasRes: true,
		});
	});
});

describe('Venation 请求上下文兜底', () => {
	it('req.url 缺失时按空路径匹配并返回 404', async () => {
		const { app, driver } = setup();
		app.get('/only', async () => {});
		await new Promise(resolve => setTimeout(resolve, 0));

		const req = createMockRequest({});
		(req as unknown as { url?: string }).url = undefined;
		const res = createMockResponse();

		await driver.handlers[0]!(req, res);

		expect(res.statusCode).toBe(404);
		expect(res.body).toBe('404 Not Found');
	});

	it('req.method 缺失时 method 回退为空串', async () => {
		const { app, driver } = setup();
		let capturedMethod: unknown;
		app.all('', async (ctx) => {
			capturedMethod = ctx.method;
			ctx.res.write('ok');
		});
		await new Promise(resolve => setTimeout(resolve, 0));

		const req = createMockRequest({});
		(req as unknown as { method?: string }).method = undefined;
		const res = createMockResponse();

		await driver.handlers[0]!(req, res);

		expect(capturedMethod).toBe('');
		expect(res.body).toBe('ok');
	});

	it('请求已 end 时不会重复 end', async () => {
		const { app, driver } = setup();
		app.all('', async (ctx) => {
			ctx.res.end('once');
		});
		await new Promise(resolve => setTimeout(resolve, 0));

		const res = createMockResponse();
		await driver.handlers[0]!(createMockRequest({ url: '/' }), res);

		expect(res.body).toBe('once');
		expect(res.writableEnded).toBe(true);
	});

	it('未匹配路由但响应已开始写出时不覆盖 404', async () => {
		const { app, driver } = setup();
		app.get('/known', async () => {});
		await new Promise(resolve => setTimeout(resolve, 0));

		// 模拟上游驱动已写入响应头（例如手动 end 或代理透传）后再判定 404
		const res = createMockResponse();
		res.write('partial');
		res.statusCode = 200;

		await driver.handlers[0]!(createMockRequest({ url: '/missing' }), res);

		expect(res.statusCode).toBe(200);
		expect(res.body).toBe('partial');
		expect(res.writableEnded).toBe(false);
	});
});
