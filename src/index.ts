import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import tripsRouter from './routes/trips';
import bookingsRouter from './routes/bookings';
import paymentsRouter from './routes/payments';
import adminRouter from './routes/admin';
import { errorHandler } from './middleware/errorHandler';
import { expirePendingBookings } from './services/expiryService';
import { logger } from './utils/logger';
import { initializeDb } from './db/database';

function validateEnv(): void {
  const errors: string[] = [];

  if (process.env.PORT) {
    const port = parseInt(process.env.PORT, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      errors.push(`PORT must be a valid number between 1 and 65535, got: ${process.env.PORT}`);
    }
  }

  if (process.env.NODE_ENV && !['development', 'production', 'test'].includes(process.env.NODE_ENV)) {
    errors.push(`NODE_ENV must be one of: development, production, test. Got: ${process.env.NODE_ENV}`);
  }

  if (errors.length > 0) {
    logger.error('Environment variable validation failed', { errors });
    throw new Error(`Environment validation failed:\n${errors.join('\n')}`);
  }
}

async function startServer(): Promise<void> {
  validateEnv();

  logger.info('Initializing database...');
  await initializeDb();
  logger.info('Database initialized successfully');

  const PORT = parseInt(process.env.PORT || '3000', 10);
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use('/api', tripsRouter);
  app.use('/api', bookingsRouter);
  app.use('/api', paymentsRouter);
  app.use('/api', adminRouter);

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use(errorHandler);

  cron.schedule('* * * * *', () => {
    logger.debug('Running expiry job');
    expirePendingBookings().catch((err) => {
      logger.error('Expiry job failed', { error: err instanceof Error ? err.message : 'Unknown error' });
    });
  });

  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info('Auto-expiry job scheduled to run every minute');
  });
}

startServer().catch((err) => {
  logger.error('Failed to start server', { error: err instanceof Error ? err.message : 'Unknown error' });
  process.exit(1);
});
