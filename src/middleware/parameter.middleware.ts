import type { IMiddleware } from '../utils/interface';

import formidable from 'formidable';

const parameterMid: IMiddleware = async (ctx, next) => {
	const parsedUrl = new URL(ctx.req.url ?? '', `http://${ctx.req.headers.host}`);
	ctx.getQuery = parsedUrl.searchParams;
	const form = formidable({});
	if (Number(ctx.req.headers['content-length']) > 0) {
		try {
			await new Promise((resolve, reject) => {
				form.parse(ctx.req, (err, fields, files) => {
					if (err) {
						reject(err);
					}
					ctx.requestFiles = files;
					if (ctx.req.headers['content-type']?.includes('form-data')) {
						const exchangeFields = {} as any;
						for (const key in fields) {
							if (Object.prototype.hasOwnProperty.call(fields, key)) {
								exchangeFields[key] = fields[key];
								if (Array.isArray(fields[key]) && fields[key]?.length === 1) {
									exchangeFields[key] = (fields[key] as any)[0];
								}
								else {
									exchangeFields[key] = fields[key];
								}
							}
						}
						ctx.requestParams = exchangeFields;
					}
					else {
						ctx.requestParams = fields;
					}
					resolve(null);
				});
			});
		}
		catch (err: any) {
			ctx.res.writeHead(err.httpCode || 400, { 'Content-type': 'text/plain' });
		}
	}
	await next();
};

export default parameterMid;
