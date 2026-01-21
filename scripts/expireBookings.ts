/**
 * Manual script to trigger booking expiration.
 * Can be run via: npm run expire
 * 
 * This is useful for testing or manual cleanup.
 * In production, the cron job in index.ts handles this automatically.
 */

import { getDb } from '../src/db/database';
import { expirePendingBookings } from '../src/services/expiryService';
import { logger } from '../src/utils/logger';

async function main(): Promise<void> {
  // Initialize database
  getDb();
  
  logger.info('Running manual expiry job...');
  
  try {
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
