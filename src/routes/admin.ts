import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../db/database';
import { TripRow, TripMetricsResponse, AtRiskTripsResponse } from '../types';
import { expirePendingBookings } from '../services/expiryService';

const router = Router();

interface StateAggregation {
  state: string;
  seats: number;
  count: number;
}

interface FinancialAggregation {
  gross: number | null;
  refunds: number | null;
}


router.get('/admin/trips/:tripId/metrics', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const trip = await db.get<TripRow>('SELECT * FROM trips WHERE id = ?', [req.params.tripId]);

      if (!trip) {
        return res.status(404).json({ error: 'Trip not found' });
      }

      const stateAgg = await db.all<StateAggregation>(
        `SELECT state, SUM(num_seats) as seats, COUNT(*) as count
         FROM bookings WHERE trip_id = ? GROUP BY state`,
        [req.params.tripId]
      );

      const reservedSeatsResult = await db.get<{ total_reserved: number }>(
        `SELECT COALESCE(SUM(num_seats), 0) as total_reserved
         FROM bookings
         WHERE trip_id = ? AND state = ? AND expires_at > ?`,
        [req.params.tripId, 'PENDING_PAYMENT', new Date().toISOString()]
      );

      const reservedSeats = reservedSeatsResult?.total_reserved || 0;

      const financial = await db.get<FinancialAggregation>(
        `SELECT
           SUM(CASE WHEN state IN ('CONFIRMED','CANCELLED') THEN price_at_booking ELSE 0 END) as gross,
           SUM(COALESCE(refund_amount, 0)) as refunds
         FROM bookings WHERE trip_id = ?`,
        [req.params.tripId]
      );

      const summary = { confirmed: 0, pending_payment: 0, cancelled: 0, expired: 0 };

      stateAgg.forEach((row) => {
        if (row.state === 'CONFIRMED') summary.confirmed = row.count;
        if (row.state === 'PENDING_PAYMENT') summary.pending_payment = row.count;
        if (row.state === 'CANCELLED') summary.cancelled = row.count;
        if (row.state === 'EXPIRED') summary.expired = row.count;
      });

      const confirmedSeats = stateAgg.find(row => row.state === 'CONFIRMED')?.seats || 0;
      const bookedSeats = confirmedSeats + reservedSeats;
      const availableSeats = trip.max_capacity - bookedSeats;
      const occupancyPercent = trip.max_capacity > 0 ? Math.round((bookedSeats / trip.max_capacity) * 100) : 0;

      const response: TripMetricsResponse = {
        trip_id: trip.id,
        title: trip.title,
        occupancy_percent: occupancyPercent,
        total_seats: trip.max_capacity,
        booked_seats: bookedSeats,
        available_seats: Math.max(0, availableSeats),
        booking_summary: summary,
        financial: {
          gross_revenue: financial?.gross || 0,
          refunds_issued: financial?.refunds || 0,
          net_revenue: (financial?.gross || 0) - (financial?.refunds || 0),
        },
      };

      res.json(response);
    } catch (err) {
      next(err);
    }
});

router.get('/admin/trips/at-risk', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const now = new Date();
      const inSevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const todayIso = now.toISOString();

      const trips = await db.all<TripRow>(
        `SELECT * FROM trips
         WHERE start_date <= ? AND start_date >= ? AND status = 'PUBLISHED'`,
        [inSevenDays, todayIso]
      );

      const atRisk = await Promise.all(trips.map(async (trip) => {
        const confirmedResult = await db.get<{ confirmed_seats: number }>(
          `SELECT COALESCE(SUM(num_seats), 0) as confirmed_seats
           FROM bookings
           WHERE trip_id = ? AND state = 'CONFIRMED'`,
          [trip.id]
        );

        const reservedResult = await db.get<{ reserved_seats: number }>(
          `SELECT COALESCE(SUM(num_seats), 0) as reserved_seats
           FROM bookings
           WHERE trip_id = ? AND state = ? AND expires_at > ?`,
          [trip.id, 'PENDING_PAYMENT', now.toISOString()]
        );

        const confirmedSeats = confirmedResult?.confirmed_seats || 0;
        const reservedSeats = reservedResult?.reserved_seats || 0;
        const totalOccupied = confirmedSeats + reservedSeats;
        const occupancyPercent = trip.max_capacity > 0 ? Math.round((totalOccupied / trip.max_capacity) * 100) : 0;

        return {
          trip_id: trip.id,
          title: trip.title,
          departure_date: trip.start_date,
          occupancy_percent: occupancyPercent,
          reason: 'Low occupancy with imminent departure',
        };
      }));

      const filteredAtRisk = atRisk.filter(trip => trip.occupancy_percent < 50);

      const response: AtRiskTripsResponse = { at_risk_trips: filteredAtRisk };
      res.json(response);
    } catch (err) {
      next(err);
    }
});

router.get('/admin/metrics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const trips = await db.all<TripRow>('SELECT * FROM trips WHERE status = ?', ['PUBLISHED']);

    const metrics = await Promise.all(trips.map(async (trip) => {
      const stateAgg = await db.all<StateAggregation>(
        `SELECT state, SUM(num_seats) as seats, COUNT(*) as count
       FROM bookings WHERE trip_id = ? GROUP BY state`,
        [trip.id]
      );

      const financial = await db.get<FinancialAggregation>(
        `SELECT
           SUM(CASE WHEN state IN ('CONFIRMED','CANCELLED') THEN price_at_booking ELSE 0 END) as gross,
           SUM(COALESCE(refund_amount, 0)) as refunds
       FROM bookings WHERE trip_id = ?`,
        [trip.id]
      );

      const summary = { confirmed: 0, pending_payment: 0, cancelled: 0, expired: 0 };

      stateAgg.forEach((row) => {
        if (row.state === 'CONFIRMED') summary.confirmed = row.count;
        if (row.state === 'PENDING_PAYMENT') summary.pending_payment = row.count;
        if (row.state === 'CANCELLED') summary.cancelled = row.count;
        if (row.state === 'EXPIRED') summary.expired = row.count;
      });

      const bookedSeats = trip.max_capacity - trip.available_seats;
      const occupancyPercent = Math.round((bookedSeats / trip.max_capacity) * 100);

      return {
        trip_id: trip.id,
        title: trip.title,
        occupancy_percent: occupancyPercent,
        total_seats: trip.max_capacity,
        booked_seats: bookedSeats,
        available_seats: trip.available_seats,
        booking_summary: summary,
        financial: {
          gross_revenue: financial?.gross || 0,
          refunds_issued: financial?.refunds || 0,
          net_revenue: (financial?.gross || 0) - (financial?.refunds || 0),
        },
      };
    }));

    res.json({ trips: metrics });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/expire-bookings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await expirePendingBookings();
    res.json({ message: 'Expiry job completed successfully' });
  } catch (err) {
    next(err);
  }
});

router.delete('/admin/bookings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await db.run('DELETE FROM bookings');
    res.json({ message: 'All bookings deleted successfully' });
  } catch (err) {
    next(err);
  }
});

router.delete('/admin/trips', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Delete bookings first due to foreign key constraint
    await db.run('DELETE FROM bookings');
    await db.run('DELETE FROM trips');
    res.json({ message: 'All trips and bookings deleted successfully' });
  } catch (err) {
    next(err);
  }
});

router.delete('/admin/clean', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Delete bookings first due to foreign key constraint
    await db.run('DELETE FROM bookings');
    await db.run('DELETE FROM trips');
    res.json({ message: 'Database cleaned successfully' });
  } catch (err) {
    next(err);
  }
});

export default router;
