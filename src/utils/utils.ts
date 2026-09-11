import { randomUUID } from 'node:crypto';

export function instanceValue<T>(initializer: () => T) {
	let firstRun = true;
	let value: T;
	return () => {
		if (firstRun) {
			firstRun = false;
			value = initializer();
		}
		return value;
	};
}

export function getOrInitMap<K, V>(map: Map<K, V>, key: K, initializer: (key: K) => V) {
	const value = map.get(key);
	if (value) {
		return value;
	}
	else {
		const newValue = initializer(key);
		map.set(key, newValue);
		return newValue;
	}
}

export function getUuid() {
	return randomUUID().replace(/-/g, '');
}

export function getUuidStr(uuid?: string) {
	const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	const uuidStr = uuid || getUuid();
	let str = '';
	for (let i = 0; i < uuidStr.length; i += 2) {
		const res = uuidStr.slice(i, i + 2);
		const num = Number.parseInt(res, 16);
		str += characters[num % characters.length];
	}
	return str;
}

export function traceId() {
	return `TraceId:${getUuidStr()}`;
}
