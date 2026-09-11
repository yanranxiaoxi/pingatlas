import type { ServerResponse } from 'node:http';
import type { Logger } from 'winston';
import http from 'node:http';

import { VenDriver } from '../interface';
import { IRequest, IResponse } from './transport';

export class VenNodeDriver extends VenDriver {
	public readonly server;
	public constructor(private readonly logger: Logger) {
		super();
		this.server = http.createServer({
			IncomingMessage: IRequest,
			ServerResponse: IResponse as typeof ServerResponse,
		});
	}

	public listen(host: string, port: number) {
		this.server.on('listening', () => {
			this.logger.info(`server is listening on http://${host}:${port}`);
		});

		// 连接健壮性守护：客户端发畸形请求/中途断开时，避免未处理事件导致进程崩溃
		this.server.on('clientError', (err, socket) => {
			this.logger.warn(`client error: ${err.message}`);
			socket.destroy();
		});

		this.server.listen(port, host);
	}

	public onRequest(cb: (req: IRequest, res: IResponse) => void) {
		this.server.on('request', (req, res) => {
			// 响应侧 error 守护：客户端断开后继续写会抛错，吞掉并记录即可
			res.on('error', (err) => {
				this.logger.warn(`response error: ${err.message}`);
			});
			cb(req, res as IResponse);
		});
	}
}
