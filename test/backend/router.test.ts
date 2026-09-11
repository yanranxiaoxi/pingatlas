import type { IContext } from '../../src/utils/interface';
import { describe, expect, it } from '@jest/globals';
import { Router } from '../../src/utils/router';
import { createMockLogger } from '../helpers/http';

function createCtx(options: { method?: string; routerParams?: Record<string, unknown> } = {}): IContext {
	return {
		method: options.method ?? 'GET',
		routerParams: options.routerParams ?? {},
		logger: createMockLogger(),
	} as unknown as IContext;
}

/** `Router.get()` 等方法通过 promise 回调设置 method，需要等一个宏任务 */
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** 与 src/router/index.ts 中静态资源兜底路由相同的正则 */
const STATIC_PATH_REGEX = /(?!\/api(?:\/|$)).*/;

describe('Router.match', () => {
	it('空节点匹配任意路径并原样返回', () => {
		const router = new Router('');
		expect(router.match(createCtx(), '', '/anything')).toBe('/anything');
		expect(router.match(createCtx(), '', '')).toBe('');
	});

	it('字符串节点前缀匹配，剩余部分以 / 开头', () => {
		const router = new Router('/api');
		expect(router.match(createCtx(), '/api', '/api')).toBe('');
		expect(router.match(createCtx(), '/api', '/api/v1/limits')).toBe('/v1/limits');
	});

	it('不匹配时返回 false', () => {
		const router = new Router('/api');
		expect(router.match(createCtx(), '/api', '/apix')).toBe(false);
		expect(router.match(createCtx(), '/api', '/other')).toBe(false);
	});

	it('带 :param 的节点按段匹配并支持后续路径', () => {
		const node = '/measurements/:id';
		const router = new Router(node);
		expect(router.match(createCtx(), node, '/measurements/abc')).toBe('');
		expect(router.match(createCtx(), node, '/measurements/abc/extra')).toBe('/extra');
		expect(router.match(createCtx(), node, '/measurements')).toBe(false);
		expect(router.match(createCtx(), node, '/measurements/')).toBe(false);
	});

	it('RegExp 节点使用其 source 进行前缀匹配', () => {
		const node = /\/static\/.*/;
		const router = new Router(node);
		expect(router.match(createCtx(), node, '/static/a.js')).toBe('');
		expect(router.match(createCtx(), node, '/other')).toBe(false);
	});
});

describe('Router.parseRouteParams', () => {
	it('提取 :param 到 ctx.routerParams', () => {
		const ctx = createCtx({ routerParams: {} });
		const router = new Router('/measurements/:id');
		const next = router.parseRouteParams(ctx, '/measurements/:id', '/measurements/abc-123/extra');

		expect(ctx.routerParams).toEqual({ id: 'abc-123' });
		expect(next).toBe('/extra');
	});

	it('多个参数按顺序提取', () => {
		const ctx = createCtx({ routerParams: {} });
		const router = new Router('/a/:first/b/:second');
		expect(router.parseRouteParams(ctx, '/a/:first/b/:second', '/a/1/b/2')).toBe('');
		expect(ctx.routerParams).toEqual({ first: '1', second: '2' });
	});

	it('普通字符串节点只切分路径', () => {
		const router = new Router('/api');
		expect(router.parseRouteParams(createCtx(), '/api', '/api/v1')).toBe('/v1');
		expect(router.parseRouteParams(createCtx(), '/api', '/nope')).toBe('');
	});

	it('RegExp 节点切掉匹配到的前缀', () => {
		const node = /\/assets/;
		const router = new Router(node);
		expect(router.parseRouteParams(createCtx(), node, '/assets/main.js')).toBe('/main.js');
	});
});

describe('Router.checkRoute', () => {
	it('末端节点校验请求方法', async () => {
		const root = new Router('');
		root.get('/only-get', async () => {});
		await tick();

		expect(root.checkRoute(createCtx({ method: 'GET' }), '/only-get', [])).toBe(true);
		expect(root.checkRoute(createCtx({ method: 'POST' }), '/only-get', [])).toBe(false);
	});

	it('方法大小写不敏感', async () => {
		const root = new Router('');
		root.post('/only-post', async () => {});
		await tick();

		expect(root.checkRoute(createCtx({ method: 'POST' }), '/only-post', [])).toBe(true);
		expect(root.checkRoute(createCtx({ method: 'post' }), '/only-post', [])).toBe(true);
	});

	it('all() 接受任意方法', async () => {
		const root = new Router('');
		root.all('/any', async () => {});
		await tick();

		for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
			expect(root.checkRoute(createCtx({ method }), '/any', [])).toBe(true);
		}
	});

	it('未注册的路径返回 false', async () => {
		const root = new Router('');
		root.get('/known', async () => {});
		await tick();
		expect(root.checkRoute(createCtx(), '/missing', [])).toBe(false);
	});

	it('只匹配到中间节点（无末端控制器）时返回 false', async () => {
		const root = new Router('');
		await root.router('/api');
		expect(root.checkRoute(createCtx(), '/api', [])).toBe(false);
	});

	it('routeIndex 按浅到深记录匹配到的子节点下标', async () => {
		const root = new Router('');
		const api = await root.router('/api');
		const v1 = await api.router('/v1');
		v1.get('/limits', async () => {});
		await tick();

		const routeIndex: number[] = [];
		expect(root.checkRoute(createCtx(), '/api/v1/limits', routeIndex)).toBe(true);
		expect(routeIndex).toEqual([0, 0, 0]);
	});

	it('兄弟节点中命中第二个时下标为 1', async () => {
		const root = new Router('');
		root.get('/first', async () => {});
		root.get('/second', async () => {});
		await tick();

		const routeIndex: number[] = [];
		expect(root.checkRoute(createCtx(), '/second', routeIndex)).toBe(true);
		expect(routeIndex).toEqual([1]);
	});
});

describe('Router.run', () => {
	it('按注册顺序执行中间件并最终执行控制器', async () => {
		const calls: string[] = [];
		const root = new Router('');
		root.get(
			'/api/limits',
			async (_ctx, next) => {
				calls.push('api-mw');
				await next();
			},
			async (_ctx, next) => {
				calls.push('limits-mw');
				await next();
			},
			async () => {
				calls.push('controller');
			},
		);
		await tick();

		const routeIndex: number[] = [];
		const ctx = createCtx();
		expect(root.checkRoute(ctx, '/api/limits', routeIndex)).toBe(true);
		await root.run(ctx, '/api/limits', routeIndex);

		expect(calls).toEqual(['api-mw', 'limits-mw', 'controller']);
	});

	it('中间件不调用 next 时控制器不执行', async () => {
		const calls: string[] = [];
		const root = new Router('');
		root.get(
			'/blocked',
			async () => {
				calls.push('blocking-mw');
			},
			async () => {
				calls.push('controller');
			},
		);
		await tick();

		const routeIndex: number[] = [];
		expect(root.checkRoute(createCtx(), '/blocked', routeIndex)).toBe(true);
		await root.run(createCtx(), '/blocked', routeIndex);

		expect(calls).toEqual(['blocking-mw']);
	});

	it('跨层级执行：父级中间件先于子路由', async () => {
		const calls: string[] = [];
		const root = new Router('', async (_ctx, next) => {
			calls.push('root');
			await next();
		});
		const sub = await root.router('/sub', async (_ctx, next) => {
			calls.push('sub');
			await next();
		});
		sub.get('/leaf', async () => {
			calls.push('leaf');
		});
		await tick();

		const routeIndex: number[] = [];
		expect(root.checkRoute(createCtx(), '/sub/leaf', routeIndex)).toBe(true);
		await root.run(createCtx(), '/sub/leaf', routeIndex);

		expect(calls).toEqual(['root', 'sub', 'leaf']);
	});

	it('中间件可以在控制器之后追加逻辑', async () => {
		const calls: string[] = [];
		const root = new Router('');
		root.get(
			'/after',
			async (_ctx, next) => {
				calls.push('before');
				await next();
				calls.push('after');
			},
			async () => {
				calls.push('controller');
			},
		);
		await tick();

		const routeIndex: number[] = [];
		const ctx = createCtx();
		expect(root.checkRoute(ctx, '/after', routeIndex)).toBe(true);
		await root.run(createCtx(), '/after', routeIndex);
		expect(calls).toEqual(['before', 'controller', 'after']);
	});
});

describe('Router.merge', () => {
	it('替换节点并挂到子路由列表', async () => {
		const root = new Router('');
		const sub = new Router('');
		sub.all('', async () => {});
		await tick();
		root.merge(sub, '/merged');

		const routeIndex: number[] = [];
		expect(root.checkRoute(createCtx(), '/merged', routeIndex)).toBe(true);
	});
});

describe('Router 方法链', () => {
	it('每个动词注册方法都返回自身以支持链式调用', async () => {
		const root = new Router('');

		expect(root.get('/a', async () => {})).toBe(root);
		expect(root.post('/b', async () => {})).toBe(root);
		expect(root.put('/c', async () => {})).toBe(root);
		expect(root.patch('/d', async () => {})).toBe(root);
		expect(root.delete('/e', async () => {})).toBe(root);
		expect(root.all('/f', async () => {})).toBe(root);
		await tick();
	});

	it.each([
		['PUT', '/verb-put', 'put'],
		['PATCH', '/verb-patch', 'patch'],
		['DELETE', '/verb-delete', 'delete'],
	])('%s 请求命中对应动词路由', async (method, path) => {
		const root = new Router('');
		root.put('/verb-put', async () => {});
		root.patch('/verb-patch', async () => {});
		root.delete('/verb-delete', async () => {});
		await tick();

		const routeIndex: number[] = [];
		expect(root.checkRoute(createCtx({ method }), path, routeIndex)).toBe(true);
	});

	it('动词不匹配时返回 false', async () => {
		const root = new Router('');
		root.put('/only-put', async () => {});
		await tick();

		const routeIndex: number[] = [];
		expect(root.checkRoute(createCtx({ method: 'GET' }), '/only-put', routeIndex)).toBe(false);
	});

	it('router() 返回子路由且不设置 method', async () => {
		const root = new Router('');
		const child = await root.router('/child');

		expect(child).toBeInstanceOf(Router);
		await tick();
		const routeIndex: number[] = [];
		// method 为空字符串，任何请求方法都不匹配
		expect(root.checkRoute(createCtx({ method: 'GET' }), '/child', routeIndex)).toBe(false);
	});
});

describe('Router 边界分支', () => {
	it('字符串节点前缀相同但下一段不是 / 时不匹配', () => {
		const router = new Router('/api');
		expect(router.match(createCtx(), '/api', '/apidocs')).toBe(false);
	});

	it('parseRouteParams 对前缀相同但非路径的字符串返回空串', () => {
		const router = new Router('/api');
		expect(router.parseRouteParams(createCtx(), '/api', '/apidocs')).toBe('');
	});

	it('parseRouteParams 对 RegExp 不匹配时返回空串', () => {
		const router = new Router(/^\/api/);
		expect(router.parseRouteParams(createCtx(), /^\/api/, '/other')).toBe('');
	});

	it('checkRoute 对 RegExp 节点匹配成功', async () => {
		const root = new Router('');
		const catchAll = new Router('');
		catchAll.all('', async () => {});
		await tick();
		root.merge(catchAll, STATIC_PATH_REGEX);

		const routeIndex: number[] = [];
		expect(root.checkRoute(createCtx(), '/hello', routeIndex)).toBe(true);
	});

	it('checkRoute 对 RegExp 节点不匹配时返回 false', async () => {
		const root = new Router('');
		const catchAll = new Router('');
		catchAll.all('', async () => {});
		await tick();
		root.merge(catchAll, STATIC_PATH_REGEX);

		const routeIndex: number[] = [];
		expect(root.checkRoute(createCtx(), '/api', routeIndex)).toBe(false);
	});

	it('run 在 routeIndex 为空时仍执行自身中间件', async () => {
		const calls: Array<string> = [];
		const root = new Router('', async (_ctx, next) => {
			calls.push('mid');
			await next();
		});

		await root.run(createCtx(), '/whatever', []);

		expect(calls).toEqual(['mid']);
	});

	it('merge 不传节点时默认使用空字符串节点', async () => {
		const root = new Router('/api');
		const child = new Router('');
		child.all('', async () => {});
		await tick();
		root.merge(child);

		const routeIndex: number[] = [];
		expect(root.checkRoute(createCtx(), '/api', routeIndex)).toBe(true);
	});

	it('parseRouteParams 在匹配结果缺少 input 时返回空串', () => {
		const router = new Router('');
		// 构造一个只有 match 的伪字符串，模拟 values.input 缺失的极端情况
		const fakePath = { match: () => ({ 0: '/api/1', length: 1, input: undefined }) } as unknown as string;

		expect(router.parseRouteParams(createCtx(), '/api/:id', fakePath)).toBe('');
	});

	it('match 对既非字符串也非正则的节点返回 false', () => {
		const router = new Router('');
		expect(router.match(createCtx(), 42 as never, '/any')).toBe(false);
	});

	it('parseRouteParams 对既非字符串也非正则的节点返回空串', () => {
		const router = new Router('');
		expect(router.parseRouteParams(createCtx(), 42 as never, '/any')).toBe('');
	});
});
