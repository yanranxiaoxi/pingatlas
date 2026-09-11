export interface ExceptionData {
	code: number;
	msg?: string;
}

export interface ExceptionList {
	[key: string]: ExceptionData;
}

// 常用异常
export const BasicExceptionCode = {
	OK: { code: 200, msg: 'The request was successful.' },
	Created: {
		code: 201,
		msg: 'The resource was successfully created.',
	},
	Accepted: {
		code: 202,
		msg: 'The request has been received but not yet acted upon',
	},
	MultipleChoices: {
		code: 300,
		msg: 'The request has more than one possible response.',
	},
	MovedPermanently: {
		code: 301,
		msg: 'The requested resource has been permanently moved.',
	},
	Found: {
		code: 302,
		msg: 'This response code means that the URI of requested resource has been changed temporarily.',
	},
	SeeOther: {
		code: 303,
		msg: 'The server sent this response to direct the client to get the requested resource at another URI with a GET request.',
	},
	NotModified: {
		code: 304,
		msg: 'The requested resource has not been modified, and the client should use the cached version.',
	},
	BadRequest: {
		code: 400,
		msg: 'Bad Request: The client\'s request is invalid.',
	},
	Unauthorized: {
		code: 401,
		msg: 'Unauthorized: Authentication is required and has failed or not yet been provided.',
	}, // 错误的请求语法、无效的请求消息帧或欺骗性的请求路由
	Forbidden: {
		code: 403,
		msg: ' Forbidden: The client does not have permission to access the requested resource.',
	}, // 客户端没有对内容的访问权限
	NotFound: {
		code: 404,
		msg: ' Not Found: The requested resource could not be found.',
	}, // 服务器找不到请求的资源
	MethodNotAllowed: {
		code: 405,
		msg: 'Method Not Allowed: The request method is not supported for the requested resource.',
	}, // 请求方法错误
	Conflict: {
		code: 409,
		msg: 'Resource already exists.',
	}, // 当请求与服务器的当前状态冲突时，将发送此响应。
	ContentTooLarge: {
		code: 413,
		msg: 'Request entity is larger than limits defined by server. ',
	}, // 请求实体大于服务器定义的限制
	UnsupportedMediaType: {
		code: 415,
		msg: 'The media format of the requested data is not supported by the server.',
	}, // 服务器不支持请求数据的媒体格式，因此服务器拒绝请求。
	Locked: { code: 423, msg: 'The resource that is being accessed is locked.' }, // 正在访问的资源被锁定。
	FailedDependency: {
		code: 424,
		msg: 'The request failed due to failure of a previous request.',
	}, // 由于前一个请求失败，请求失败。
	TooManyRequests: {
		code: 429,
		msg: 'The user has sent too many requests in a given amount of time ("rate limiting").',
	}, // 用户在给定的时间内发送了太多的请求(“速率限制”)。
	InternalServerError: {
		code: 500,
		msg: 'The server has encountered a situation it does not know how to handle.',
	}, // 服务器遇到了不知道如何处理的情况。
	NotImplemented: {
		code: 501,
		msg: 'The request method is not supported by the server and cannot be handled.',
	}, // 服务器不支持请求方法，因此无法处理。服务器需要支持的唯二方法（因此不能返回此代码）是 GET and HEAD.
	BadGateway: {
		code: 502,
		msg: 'This error response means that the server, while working as a gateway to get a response needed to handle the request, got an invalid response.',
	}, // 此错误响应表明服务器作为网关需要得到一个处理这个请求的响应，但是得到一个错误的响应。
	ServiceUnavailable: {
		code: 503,
		msg: 'The server is not ready to handle the request.',
	}, // 服务器没有准备好处理请求。
	GatewayTimeout: {
		code: 504,
		msg: 'This error response is given when the server is acting as a gateway and cannot get a response in time.',
	}, // 当服务器充当网关且无法及时获得响应时，会给出此错误响应。
	HTTPVersionNotSupported: {
		code: 505,
		msg: 'The HTTP version used in the request is not supported by the server.',
	}, // 服务器不支持请求中使用的 HTTP 版本。
};

/**
 * 用户身份验证
 */
export const AuthExceptionCode = {
	UserNotLogin: {
		code: 1001,
		msg: 'user not logged in.',
	},
	LoginExpiration: {
		code: 1002,
		msg: 'User login expired or invalid.',
	},
	Exist: {
		code: 2002,
		msg: 'User already exists.',
	},
};

/**
 * 资源相关
 */
export const ResourceExceptionCode = {
	Nonexistent: {
		code: 2001,
		msg: 'Resource does not exist',
	},
	Exist: {
		code: 2002,
		msg: 'Resource already exists.',
	},
};

/**
 * 请求参数相关
 */
export const ParamsExceptionCode = {
	MissingParam: {
		code: 3001,
		msg: 'Necessary parameters are missing.',
	},
	InvalidOrFormatError: {
		code: 3002,
		msg: 'The parameter value is invalid or formatted incorrectly.',
	},
};

/**
 * 权限相关
 */
export const PermissionExceptionCode = {
	NotPermission: {
		code: 4001,
		msg: 'Unauthorized operation',
	},
	Exceed: {
		code: 4002,
		msg: 'Exceed quota limit.',
	},
	Forbidden: {
		code: 4002,
		msg: 'User deactivated.',
	},
	NeedLogin: {
		code: 4003,
		msg: 'You need to log in.',
	},
};

/**
 * 服务端错误
 */
export const ServerExceptionCode = {
	DatabaseError: {
		code: 5001,
		msg: 'Database error',
	},
	ServerException: {
		code: 5002,
		msg: 'Server exception.',
	},
};

export class BasicException extends Error {
	protected code: number;
	protected msg: string;
	protected httpCode: number | null = 200;
	public constructor(errorData: ExceptionData, detail = '', httpCode: number | null = null) {
		super();
		this.code = errorData.code;
		this.msg = (detail || errorData.msg) ?? '';
		this.httpCode = httpCode ?? this.httpCode;
	}
}
