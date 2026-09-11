import Parameter from 'parameter';

export class Controller {
	private parameter: Parameter;
	public constructor() {
		this.bindMethods();
		this.parameter = new Parameter();
	}

	public verifyParam(rule: Parameter.ParameterRules, value: any) {
		return this.parameter.validate(rule, value);
	}

	private bindMethods() {
		Object.getOwnPropertyNames(Object.getPrototypeOf(this))
			.filter(method => typeof (this as any)[method] === 'function')
			.forEach((method) => {
				(this as any)[method] = (this as any)[method].bind(this);
			});
	}
}
