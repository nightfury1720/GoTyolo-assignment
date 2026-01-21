import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import tripsRouter from './routes/trips';
import bookingsRouter from './routes/bookings';
import paymentsRouter from './routes/payments';
import adminRouter from './routes/admin';
import { errorHandler } from './middleware/errorHandler';
import { expirePendingBookings } from './services/expiryService';
import { getDb } from './db/database';
import { logger } from './utils/logger';

const PORT = process.env.PORT || 3000;

// Initialize database
getDb();
logger.info('Database initialized');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api', tripsRouter);
app.use('/api', bookingsRouter);
app.use('/api', paymentsRouter);
app.use('/api', adminRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use(errorHandler);

// Schedule auto-expiry job to run every minute
// This expires PENDING_PAYMENT bookings that have passed their expires_at time
cron.schedule('* * * * *', () => {
  logger.debug('Running expiry job');
  expirePendingBookings().catch((err) => {
    logger.error('Expiry job failed', { 
      error: err instanceof Error ? err.message : 'Unknown error' 
    });
  });
});

// Start server
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info('Auto-expiry job scheduled to run every minute');
});

export default app;
