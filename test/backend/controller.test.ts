import { describe, expect, it } from '@jest/globals';
import { Controller } from '../../src/controller/controller';

class DemoController extends Controller {
	public value = 0;

	public add(n: number) {
		this.value += n;
		return this.value;
	}

	public validateNumber(input: unknown) {
		return this.verifyParam({ value: { type: 'number', required: true } }, input);
	}
}

describe('Controller', () => {
	it('构造函数把原型方法绑定到实例（方法可被解构后调用）', () => {
		const controller = new DemoController();
		const add = controller.add;

		expect(add(2)).toBe(2);
		expect(controller.value).toBe(2);
	});

	it('verifyParam 校验通过时没有错误返回', () => {
		const controller = new DemoController();
		expect(controller.validateNumber({ value: 1 })).toBeFalsy();
	});

	it('verifyParam 校验失败时返回错误信息', () => {
		const controller = new DemoController();
		const result = controller.validateNumber({ value: 'not-a-number' });

		expect(Array.isArray(result)).toBe(true);
		expect((result as Array<Error>)[0]!.message).toMatch(/number/);
	});

	it('verifyParam 对缺失必填字段返回错误', () => {
		const controller = new DemoController();
		const result = controller.validateNumber({});

		expect(Array.isArray(result)).toBe(true);
		expect((result as Array<Error>)[0]!.message).toMatch(/required/);
	});

	it('解构出的方法共享同一实例状态', () => {
		const controller = new DemoController();
		const add = controller.add;
		add(1);
		add(1);
		expect(controller.value).toBe(2);
	});
});
