import { Router, Request, Response, NextFunction } from 'express';
import { body } from 'express-validator';
import { db } from '../db/database';
import { TripRow, HttpError } from '../types';
import { createTrip } from '../services/tripService';
import { handleValidation } from '../middleware/validation';

const router = Router();

router.get('/trips', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, destination } = req.query;
    
    let query = 'SELECT * FROM trips WHERE 1=1';
    const params: string[] = [];
    
    if (status && (status === 'DRAFT' || status === 'PUBLISHED')) {
      query += ' AND status = ?';
      params.push(status as string);
    } else if (!status) {
      query += ' AND status = ?';
      params.push('PUBLISHED');
    }
    
    if (destination) {
      query += ' AND destination LIKE ?';
      params.push(`%${destination}%`);
    }
    
    query += ' ORDER BY start_date ASC';
    
    const trips = await db!.all<TripRow>(query, params);
    res.json({ trips });
  } catch (err) {
    next(err);
  }
});

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

router.get('/trips/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const trip = await db!.get<TripRow>('SELECT * FROM trips WHERE id = ?', [req.params.id]);
    
    if (!trip) {
      return res.status(404).json({ error: 'Trip not found' });
    }
    
    res.json(trip);
  } catch (err) {
    next(err);
  }
});

export default router;
