import { CONFIG } from '../config/config';
import venRouter from '../router';
import logger from '../utils/logger';
import { Venation } from '../utils/venation';
import { VenNodeDriver } from '../utils/venation/driver';

(async () => {
	const driver = new VenNodeDriver(logger);
	const venation = new Venation(logger);
	venation.addDriver(driver);
	await venRouter(venation);

	// 启动服务器
	driver.listen(CONFIG.host, CONFIG.port);
	logger.info(`Server started on ${CONFIG.host}:${CONFIG.port}`);
})();
