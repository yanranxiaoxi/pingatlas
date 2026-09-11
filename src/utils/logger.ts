import os from 'node:os';
import path from 'node:path';
import winston from 'winston';
import { CONFIG } from '../config/config';
import 'winston-daily-rotate-file';

const dailyRotateFileTransport = new winston.transports.DailyRotateFile({
	filename: path.join('./logs/', CONFIG.projectName),
	extension: '.log',
	datePattern: 'YYYY-MM-DD',
	maxSize: '1g',
	maxFiles: '7d',
});

function createLogger(label: string) {
	return winston.createLogger({
		defaultMeta: { serverName: os.hostname(), app: CONFIG.projectName, label },
		level: CONFIG.logLevel,
		format: winston.format.combine(
			winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
			winston.format.printf(
				info => `[${info.timestamp}] [${info.level}] ${[info.traceId ? `[${info.traceId}]` : '']}: ${info.message}`,
			),
		),
		transports: [new winston.transports.Console(), dailyRotateFileTransport],
	});
}

const logger = createLogger(CONFIG.projectName);
export default logger;
