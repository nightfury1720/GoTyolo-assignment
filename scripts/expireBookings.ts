import { expirePendingBookings } from '../src/services/expiryService';
import { logger } from '../src/utils/logger';
import { initializeDb } from '../src/db/database';

async function main(): Promise<void> {
  logger.info('Running manual expiry job...');
  
  try {
    await initializeDb();
    await expirePendingBookings();
    logger.info('Expiry job completed successfully');
  } catch (err) {
    logger.error('Expiry job failed', {
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    process.exit(1);
  }
}

main();
