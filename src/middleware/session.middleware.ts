import type { IMiddleware } from '../utils/interface';
import { CONFIG } from '../config/config';
import { parseCookies } from '../utils/cookie';
import { verifySession } from '../utils/session';

/**
 * 会话中间件：解析会话 Cookie 并写入 ctx.user
 */
const sessionMid: IMiddleware = async (ctx, next) => {
	ctx.user = null;
	const cookies = parseCookies(ctx.req.headers.cookie);
	const token = cookies[CONFIG.session.cookieName];
	if (token) {
		ctx.user = await verifySession(token);
	}
	await next();
};

export default sessionMid;
