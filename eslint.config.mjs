import antfu from '@antfu/eslint-config';

export default antfu(
	{
		stylistic: {
			indent: 'tab',
			quotes: 'single',
			semi: true,
		},

		typescript: true,

		ignores: [
			'public/**',
			'dist/**',
			'coverage/**',
			'node_modules/**',
			'.eslintcache',
			'debug.log',
		],
	},
	{
		// 测试代码运行在 Node / jsdom 全局环境下，允许直接使用这些全局对象
		files: ['test/**/*.ts'],
		rules: {
			'node/prefer-global/buffer': 'off',
			'node/prefer-global/process': 'off',
		},
	},
);
