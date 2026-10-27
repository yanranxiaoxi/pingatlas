/* 首屏主题：在样式表之前同步执行，避免闪白，并让 Dark Reader 等扩展读出原生暗色。
 * 独立文件而非内联脚本，以便 CSP 使用严格的 script-src 'self'。 */
(function () {
	var stored = null;
	try {
		stored = localStorage.getItem('pa-theme');
	}
	catch {
		// 隐私模式下读取失败，按系统偏好处理
	}
	var theme = stored === 'dark' || (stored !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
	document.documentElement.setAttribute('data-theme', theme);
	var scheme = document.querySelector('meta[name="color-scheme"]');
	if (scheme) {
		scheme.setAttribute('content', theme);
	}
	var chromeColor = document.querySelector('meta[name="theme-color"]');
	if (chromeColor) {
		chromeColor.setAttribute('content', theme === 'dark' ? '#0e1116' : '#ffffff');
	}
})();
