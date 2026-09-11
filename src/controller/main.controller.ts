import type { IContext } from '../utils/interface';
import { Controller } from './controller';

class Main extends Controller {
	public async get(ctx: IContext) {
		ctx.res.setHeader('Content-Type', 'application/json; charset=utf-8');
		ctx.res.setHeader('Cache-Control', 'public, max-age=7200'); // 缓存 2 小时
		ctx.res.end('Hello world!');
	}
}

const main = new Main();
export default main;
