import { Router, Request, Response, NextFunction } from 'express';
import { body, param } from 'express-validator';
import { createBooking, getBooking, HttpError } from '../services/bookingService';
import { cancelBookingWithRefund } from '../services/refundService';
import { handleValidation } from '../middleware/validation';

const router = Router();

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
