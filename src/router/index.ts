import type { Venation } from '../utils/venation';
import auth from '../controller/auth.controller';
import frontend from '../controller/frontend.controller';
import globalping from '../controller/globalping.controller';
import sessionMid from '../middleware/session.middleware';
import traceMid from '../middleware/trace.middleware';

/** 匹配非 /api 开头的完整路径（前端页面与静态资源），排除 /api 及其子路径 */
const STATIC_PATH_REGEX = /(?!\/api(?:\/|$)).*/;

export default async (ven: Venation) => {
	await ven.router('', traceMid).then(async (root) => {
		// ===== API 组（携带会话解析中间件）=====
		await root.router('/api', sessionMid).then(async (api) => {
			// 认证
			await api.router('/auth').then((authSub) => {
				authSub.get('/status', auth.status);
				authSub.get('/login', auth.login);
				authSub.get('/callback', auth.callback);
				authSub.get('/logout', auth.logout);
			});

			// 前端配置
			api.get('/config', globalping.config);

			// 探针位置索引（位置筛选自动补全，公开数据、不消耗额度）
			api.get('/probes', globalping.probes);
			// 精简探针列表（「Probes 列表」标签页，与索引共用同一份上游缓存）
			api.get('/probe-list', globalping.probeList);

			// 服务端代币代理（本地额度用尽时的兜底通道）
			api.get('/limits', globalping.limits);
			api.post('/measurements', globalping.createMeasurement);
			api.get('/measurements/:id', globalping.getMeasurement);
		});

		// ===== 前端页面与静态资源（其余所有 GET）=====
		root.get(STATIC_PATH_REGEX, frontend.staticFiles);
	});
};
