import { Router, Request, Response, NextFunction } from 'express';
import { body, param } from 'express-validator';
import { createBooking, getBooking, HttpError } from '../services/bookingService';
import { cancelBookingWithRefund } from '../services/refundService';
import { handleValidation } from '../middleware/validation';

const router = Router();

/**
 * POST /trips/:tripId/book
 * Create a new booking for a trip
 * 
 * Request body:
 * - user_id: string - User making the booking
 * - num_seats: number - Number of seats to book
 * 
 * Response:
 * - booking: Booking object
 * - payment_url: URL to complete payment
 */
router.post(
  '/trips/:tripId/book',
  [
    param('tripId').isString().notEmpty(),
    body('user_id').isString().notEmpty(),
    body('num_seats').isInt({ min: 1 }),
  ],
  handleValidation,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tripId } = req.params;
      const { user_id: userId, num_seats: numSeats } = req.body;
      
      const booking = await createBooking(tripId, userId, numSeats);
      const payment_url = `https://payments.example.com/pay/${booking.id}`;
      
      res.status(201).json({ booking: booking.toJSON(), payment_url });
    } catch (err) {
      if (err instanceof HttpError) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  }
);

/**
 * GET /bookings/:id
 * Get details of a specific booking
 */
router.get(
  '/bookings/:id',
  [param('id').isString().notEmpty()],
  handleValidation,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const booking = await getBooking(req.params.id);
      
      if (!booking) {
        return res.status(404).json({ error: 'Booking not found' });
      }
      
      res.json(booking);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /bookings/:id/cancel
 * Cancel a booking and process refund if applicable
 * 
 * Refund rules:
 * - Before cutoff: Refund = price × (1 - cancellation_fee_percent/100)
 * - After cutoff: Refund = $0
 */
router.post(
  '/bookings/:id/cancel',
  [param('id').isString().notEmpty()],
  handleValidation,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await cancelBookingWithRefund(req.params.id);
      res.json(updated);
    } catch (err) {
      if (err instanceof HttpError) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  }
);

export default router;
