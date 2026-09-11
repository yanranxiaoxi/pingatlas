import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { VenNodeDriver } from '../../src/utils/venation/driver';
import { IRequest, IResponse } from '../../src/utils/venation/transport';
import { createMockLogger } from '../helpers/http';

/** 启动真实 node:http 驱动并等待可连接 */
async function startDriver(logger = createMockLogger()): Promise<{ driver: VenNodeDriver; baseUrl: string }> {
	const driver = new VenNodeDriver(logger as never);
	driver.listen('127.0.0.1', 0);
	await new Promise<void>((resolve) => {
		if (driver.server.listening) {
			resolve();
			return;
		}
		driver.server.once('listening', () => resolve());
	});
	const address = driver.server.address() as AddressInfo;
	return { driver, baseUrl: `http://127.0.0.1:${address.port}` };
}

const open: VenNodeDriver[] = [];

afterEach(async () => {
	await Promise.all(open.splice(0).map(driver => new Promise<void>((resolve) => {
		driver.server.close(() => resolve());
		driver.server.closeAllConnections?.();
	})));
});

describe('IResponse.addHeader', () => {
	it('首次写入标量，重复写入累积为数组', () => {
		const res = new IResponse({} as IRequest);

		res.addHeader('set-cookie', 'a=1');
		expect(res.getHeader('set-cookie')).toBe('a=1');

		res.addHeader('set-cookie', 'b=2');
		expect(res.getHeader('set-cookie')).toEqual(['a=1', 'b=2']);

		res.addHeader('set-cookie', 'c=3');
		expect(res.getHeader('set-cookie')).toEqual(['a=1', 'b=2', 'c=3']);
	});

	it('已存在的数组头继续就地追加', () => {
		const res = new IResponse({} as IRequest);
		res.setHeader('x-multi', ['a']);

		res.addHeader('x-multi', 'b');

		expect(res.getHeader('x-multi')).toEqual(['a', 'b']);
	});
});

describe('VenNodeDriver', () => {
	it('listen 打印监听地址', async () => {
		const logger = createMockLogger();
		const infoSpy = jest.spyOn(logger, 'info');

		const { driver } = await startDriver(logger);
		open.push(driver);

		expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('server is listening on http://127.0.0.1:'));
	});

	it('把原生 req/res 交给 onRequest 回调（自定义 IRequest/IResponse 类型）', async () => {
		const { driver, baseUrl } = await startDriver();
		open.push(driver);
		let seenReq: unknown;
		let seenRes: unknown;
		driver.onRequest((req, res) => {
			seenReq = req;
			seenRes = res;
			res.statusCode = 200;
			res.setHeader('Content-Type', 'text/plain');
			res.end('pong');
		});

		const res = await fetch(`${baseUrl}/ping?x=1`);

		expect(res.status).toBe(200);
		expect(await res.text()).toBe('pong');
		expect(seenReq).toBeInstanceOf(IRequest);
		expect(seenRes).toBeInstanceOf(IResponse);
		expect((seenReq as IRequest).url).toBe('/ping?x=1');
		expect((seenReq as IRequest).method).toBe('GET');
	});

	it('addHeader 通过真实响应写出多个 Set-Cookie', async () => {
		const { driver, baseUrl } = await startDriver();
		open.push(driver);
		driver.onRequest((_req, res) => {
			res.addHeader('set-cookie', 'a=1; Path=/');
			res.addHeader('set-cookie', 'b=2; Path=/');
			res.end('ok');
		});

		const res = await fetch(`${baseUrl}/cookies`);
		const cookies = res.headers.getSetCookie();

		expect(res.status).toBe(200);
		expect(cookies).toEqual(['a=1; Path=/', 'b=2; Path=/']);
	});

	it('POST 请求体可被读取', async () => {
		const { driver, baseUrl } = await startDriver();
		open.push(driver);
		driver.onRequest((req, res) => {
			let body = '';
			req.on('data', (chunk: Buffer) => {
				body += chunk.toString('utf8');
			});
			req.on('end', () => {
				res.setHeader('Content-Type', 'application/json');
				res.end(JSON.stringify({ received: body, method: req.method }));
			});
		});

		const res = await fetch(`${baseUrl}/echo`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{"a":1}',
		});

		expect(await res.json()).toEqual({ received: '{"a":1}', method: 'POST' });
	});

	it('畸形请求触发 clientError 守护，进程不崩溃', async () => {
		const logger = createMockLogger();
		const warnSpy = jest.spyOn(logger, 'warn');
		const { driver } = await startDriver(logger);
		open.push(driver);

		const address = driver.server.address() as AddressInfo;
		await new Promise<void>((resolve) => {
			const socket = connect(address.port, '127.0.0.1', () => {
				// 非法请求行 + 超长 header 组合会让 Node 抛 HPE_*
				socket.write('GET / HTTP/1.1\r\nHost: x\r\nBad Header Line\r\n\r\n');
			});
			socket.on('close', () => resolve());
			socket.on('error', () => resolve());
			setTimeout(() => {
				socket.destroy();
				resolve();
			}, 500);
		});

		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('client error:'));
		expect(driver.server.listening).toBe(true);
	});

	it('响应侧 error 被记录而不抛出', async () => {
		const logger = createMockLogger();
		const warnSpy = jest.spyOn(logger, 'warn');
		const { driver, baseUrl } = await startDriver(logger);
		open.push(driver);
		driver.onRequest((_req, res) => {
			res.emit('error', new Error('socket hang up'));
			if (!res.writableEnded) {
				res.end('ok');
			}
		});

		const res = await fetch(`${baseUrl}/err`);

		expect(await res.text()).toBe('ok');
		expect(warnSpy).toHaveBeenCalledWith('response error: socket hang up');
	});
});
