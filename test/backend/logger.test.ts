import { describe, expect, it } from '@jest/globals';
import { CONFIG } from '../../src/config/config';
import logger from '../../src/utils/logger';

/** winston 使用的消息符号（等价于 triple-beam 的 MESSAGE） */
const MESSAGE = Symbol.for('message');
const LEVEL = Symbol.for('level');

interface FormattedInfo {
	[MESSAGE]?: string;
	[LEVEL]?: string;
	timestamp?: string;
	level?: string;
	message?: string;
	traceId?: string;
}

/** 直接驱动 logger 的 format，避免依赖传输层与日志级别；时间戳由 format 自行生成 */
function format(info: FormattedInfo): string {
	const out = logger.format.transform(
		{ [LEVEL]: 'info', level: 'info', ...info } as never,
		{} as never,
	) as FormattedInfo;
	return String(out[MESSAGE]);
}

const TIMESTAMP = String.raw`\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]`;

describe('logger', () => {
	it('默认元数据包含服务名、应用名与标签', () => {
		expect(logger.defaultMeta).toMatchObject({ app: CONFIG.projectName, label: CONFIG.projectName });
		expect(typeof logger.defaultMeta.serverName).toBe('string');
	});

	it('为 winston 注册了控制台与滚动文件两个传输', () => {
		expect(logger.transports).toHaveLength(2);
		const names = logger.transports.map(transport => transport.constructor.name);
		expect(names).toContain('Console');
		expect(names).toContain('DailyRotateFile');
	});

	it('带 traceId 的日志行包含中括号包裹的链路标识', () => {
		expect(format({ message: 'hello', traceId: 'TraceId:abc123' }))
			.toMatch(new RegExp(`^${TIMESTAMP} \\[info\\] \\[TraceId:abc123\\]: hello$`));
	});

	it('缺少 traceId 时占位为空而不输出 undefined', () => {
		const line = format({ message: 'hello' });
		expect(line).toMatch(new RegExp(`^${TIMESTAMP} \\[info\\] : hello$`));
		expect(line).not.toContain('undefined');
		expect(line).not.toContain('[]');
	});

	it('traceId 为空字符串时同样视为缺少', () => {
		expect(format({ message: 'hi', traceId: '' })).toMatch(new RegExp(`^${TIMESTAMP} \\[info\\] : hi$`));
	});
});
