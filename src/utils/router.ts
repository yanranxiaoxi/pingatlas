import type { IContext, IMiddleware } from './interface';

export type TNode = string | RegExp;

export class Router {
	private node: TNode;
	private childRouterList: Array<Router> = [];
	private mids: Array<IMiddleware>;
	private method = ''; // 路由末端节点请求类型

	public constructor(node: TNode = '', ...mids: Array<IMiddleware>) {
		this.node = node;
		this.mids = mids;
	}

	/**
	 * 创建子路由
	 * @param node - 路由节点
	 * @param mids - 路由中间
	 * @returns 子路由
	 */
	public router(node: TNode, ...mids: Array<IMiddleware>) {
		const childRouter = new Router(node, ...mids);
		this.childRouterList.push(childRouter);
		return Promise.resolve(childRouter);
	}

	public get(node: TNode, ...mids: Array<IMiddleware>) {
		this.router(node, ...mids).then((child) => {
			child.method = 'get';
		});
		return this;
	}

	public post(node: TNode, ...mids: Array<IMiddleware>) {
		this.router(node, ...mids).then((child) => {
			child.method = 'post';
		});
		return this;
	}

	public put(node: TNode, ...mids: Array<IMiddleware>) {
		this.router(node, ...mids).then((child) => {
			child.method = 'put';
		});
		return this;
	}

	public patch(node: TNode, ...mids: Array<IMiddleware>) {
		this.router(node, ...mids).then((child) => {
			child.method = 'patch';
		});
		return this;
	}

	public delete(node: TNode, ...mids: Array<IMiddleware>) {
		this.router(node, ...mids).then((child) => {
			child.method = 'delete';
		});
		return this;
	}

	public all(node: TNode, ...mids: Array<IMiddleware>) {
		this.router(node, ...mids).then((child) => {
			child.method = 'all';
		});
		return this;
	}

	/**
	 * 通过 path 匹配是否以 node 开头
	 * @param ctx - 路由上下文
	 * @param node - 路由节点
	 * @param path - 路由路径
	 * @returns 匹配结果，如果匹配返回下一级 path, 未匹配返回 false
	 */
	public match(ctx: IContext, node: TNode | null, path: string): string | false {
		if (typeof node === 'string') {
			if (node === '') {
				return path;
			}
			// 当前字符串路由分析出的参数 匹配路径：/a/:name1/b/:name2  路径：/a/value1/b/value2  解析结果： {name1:value1, name2:value2}
			if (node.includes('/:')) {
				const regex = new RegExp(`^${node.replace(/\/:[^/]+/g, '/([^/]+)')}`);
				if (regex.exec(path)) {
					return path.replace(regex, '');
				}
				else {
					return false;
				}
			}
			if (path.startsWith(node)) {
				const nextUrl = path.slice(node.length);
				if (nextUrl.startsWith('/') || nextUrl === '') {
					return nextUrl;
				}
				return false;
			}
		}
		else if (node instanceof RegExp) {
			const reg = new RegExp(`^${node.source}`);
			if (reg.test(path)) {
				return path.replace(reg, '');
			}
		}
		return false;
	}

	/**
	 * 路由拼接
	 * @param router - 根路由
	 * @param node - 拼接路由节点
	 */
	public merge(router: Router, node: TNode = '') {
		router.node = node;
		this.childRouterList.push(router);
	}

	/**
	 * 校验路由是否存在、设置路由参数、获取路由路径列表
	 * @param ctx - 路由上下文
	 * @param url - 路由地址
	 * @param routeIndex - 存放路由路径列表
	 * @returns 是否存在路由
	 */
	public checkRoute(ctx: IContext, url: string, routeIndex: Array<number>) {
		const nextUrl = this.match(ctx, this.node, url);
		if (nextUrl === false) {
			return false;
		}
		if (nextUrl === '' && !this.childRouterList.length) {
			const method = ctx.method.toLocaleLowerCase();
			// 校验请求方法
			if (method === this.method || this.method === 'all') {
				return true;
			}
			return false;
		}

		if (this.childRouterList.length) {
			for (let index = 0; index < this.childRouterList.length; index++) {
				const match = this.childRouterList[index].checkRoute(ctx, nextUrl, routeIndex);
				if (match) {
					routeIndex.push(index);
					return true;
				}
			}
			return false;
		}
		return false;
	}

	/**
	 * 提取路由中的参数
	 * @param ctx - 路由上下文
	 * @param node - 路由节点
	 * @param path - 路由路径
	 * @returns 提取后的路由路径
	 */
	public parseRouteParams(ctx: IContext, node: TNode, path: string) {
		if (typeof node === 'string') {
			if (node.includes('/:')) {
				const regex = new RegExp(`^${node.replace(/\/:[^/]+/g, '/([^/]+)')}`);
				const values = path.match(regex);
				const keys: Array<string> = [];
				node.replace(/\/:([^/]+)/g, (match, key) => {
					keys.push(key);
					return '';
				});
				const nextUrl = values?.input?.replace(values[0], '');
				if (values?.length === keys.length + 1) {
					for (let i = 0; i < keys.length; i++) {
						ctx.routerParams[keys[i]] = values[i + 1];
					}
				}
				return nextUrl ?? '';
			}
			else {
				const nextUrl = path.slice(node.length);
				if (nextUrl.startsWith('/') || nextUrl === '') {
					return nextUrl;
				}
				return '';
			}
		}
		else if (node instanceof RegExp) {
			const reg = new RegExp(`^${node.source}`);
			if (reg.test(path)) {
				return path.replace(reg, '');
			}
		}
		return '';
	}

	/**
	 * 路由执行器
	 * @param ctx - 路由上下文
	 * @param path - 路由路径
	 * @param routeIndex - 路由索引
	 * @returns 路由执行器
	 */
	public async run(ctx: IContext, path: string, routeIndex: Array<number>) {
		const subindex = routeIndex.pop();
		const nextPath = this.parseRouteParams(ctx, this.node, path);
		const execute = async (router: Router, index: number) => {
			if (index >= router.mids.length) {
				if (subindex !== undefined) {
					await this.childRouterList[subindex].run(ctx, nextPath, routeIndex);
				}
			}
			else {
				const currentMid = router.mids[index];
				await currentMid(ctx, async () => await execute(router, index + 1)); // 执行当前中间件并调用下一个
			}
		};

		await execute(this, 0); // 从第一个中间件开始执行
	}
}
