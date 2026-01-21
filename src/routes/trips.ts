import { Router, Request, Response, NextFunction } from 'express';
import { body } from 'express-validator';
import { getDb } from '../db/database';
import { all, get } from '../services/transaction';
import { TripRow } from '../types';
import { createTrip } from '../services/tripService';
import { HttpError } from '../types';
import { handleValidation } from '../middleware/validation';

const router = Router();

/**
 * GET /trips
 * List all published trips sorted by start date
 * Optional query parameters:
 * - status: Filter by status (DRAFT or PUBLISHED)
 * - destination: Filter by destination (partial match)
 */
router.get('/trips', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = getDb();
    const { status, destination } = req.query;
    
    let query = 'SELECT * FROM trips WHERE 1=1';
    const params: string[] = [];
    
    if (status && (status === 'DRAFT' || status === 'PUBLISHED')) {
      query += ' AND status = ?';
      params.push(status as string);
    } else if (!status) {
      // Default to PUBLISHED if no status filter
      query += ' AND status = ?';
      params.push('PUBLISHED');
    }
    
    if (destination) {
      query += ' AND destination LIKE ?';
      params.push(`%${destination}%`);
    }
    
    query += ' ORDER BY start_date ASC';
    
    const trips = await all<TripRow>(db, query, params);
    res.json({ trips });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /trips
 * Create a new trip (admin only, optional auth)
 * 
 * Request body:
 * - title: string - Trip name
 * - destination: string - Travel destination
 * - start_date: string - Trip start date (ISO 8601)
 * - end_date: string - Trip end date (ISO 8601)
 * - price: number - Price per seat
 * - max_capacity: number - Total seats available
 * - refundable_until_days_before: number - Days before trip when refund cutoff applies
 * - cancellation_fee_percent: number - Fee percentage (0-100)
 * - status: string (optional) - 'DRAFT' or 'PUBLISHED' (defaults to 'DRAFT')
 * 
 * Response:
 * - trip: Trip object
 */
router.post(
  '/trips',
  [
    body('title').isString().notEmpty().withMessage('title is required'),
    body('destination').isString().notEmpty().withMessage('destination is required'),
    body('start_date').isISO8601().withMessage('start_date must be a valid ISO 8601 date'),
    body('end_date').isISO8601().withMessage('end_date must be a valid ISO 8601 date'),
    body('price').isFloat({ min: 0.01 }).withMessage('price must be a positive number'),
    body('max_capacity').isInt({ min: 1 }).withMessage('max_capacity must be a positive integer'),
    body('refundable_until_days_before').isInt({ min: 0 }).withMessage('refundable_until_days_before must be a non-negative integer'),
    body('cancellation_fee_percent').isInt({ min: 0, max: 100 }).withMessage('cancellation_fee_percent must be between 0 and 100'),
    body('status').optional().isIn(['DRAFT', 'PUBLISHED']).withMessage('status must be either DRAFT or PUBLISHED'),
  ],
  handleValidation,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const trip = await createTrip(req.body);
      res.status(201).json({ trip: trip.toJSON() });
    } catch (err) {
      if (err instanceof HttpError) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  }
);

/**
 * GET /trips/:id
 * Get details of a specific trip
 */
router.get('/trips/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = getDb();
    const trip = await get<TripRow>(db, 'SELECT * FROM trips WHERE id = ?', [req.params.id]);
    
    if (!trip) {
      return res.status(404).json({ error: 'Trip not found' });
    }
    
    res.json(trip);
  } catch (err) {
    next(err);
  }
});

export default router;
