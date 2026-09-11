import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'winston';
import type { IRequest, IResponse } from './venation/transport';

export abstract class VenDriver {
	/**
	 * 向驱动注册请求狗子，当一个请求送达后，执行一次回调
	 * @param cb - 回调函数
	 */
	public abstract onRequest(cb: (req: IncomingMessage, res: ServerResponse) => void): void;
}

export interface IContext extends ITransports {
	method: string;
	requestParams: Record<string, unknown>;
	requestFiles: Record<string, unknown>;
	getQuery: URLSearchParams;
	routerParams: Record<string, unknown>;
	logger: Logger;
	body: unknown;
	user: unknown;
	code: number;
}

export interface ITransports {
	req: IRequest;
	res: IResponse;
}

export type IController = (ctx: IContext) => Promise<void>;

export type INext = () => Promise<void>;

export type IMiddleware = (ctx: IContext, next: INext) => Promise<void>;
