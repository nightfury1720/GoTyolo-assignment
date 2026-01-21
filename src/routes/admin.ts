import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../db/database';
import { TripRow, TripMetricsResponse, AtRiskTripsResponse } from '../types';

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

interface TripWithBooked extends TripRow {
  booked: number;
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

      const bookedSeats = trip.max_capacity - trip.available_seats;
      const occupancyPercent = Math.round((bookedSeats / trip.max_capacity) * 100);

      const response: TripMetricsResponse = {
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

    const trips = await db.all<TripWithBooked>(
        `SELECT *, (max_capacity - available_seats) AS booked
         FROM trips
         WHERE start_date <= ? AND start_date >= ? AND status = 'PUBLISHED'`,
        [inSevenDays, todayIso]
      );

      const atRisk = trips
      .map((t) => ({ trip: t, occupancy: Math.round((t.booked / t.max_capacity) * 100) }))
        .filter((t) => t.occupancy < 50)
        .map((t) => ({
          trip_id: t.trip.id,
          title: t.trip.title,
          departure_date: t.trip.start_date,
          occupancy_percent: t.occupancy,
          reason: 'Low occupancy with imminent departure',
        }));

      const response: AtRiskTripsResponse = { at_risk_trips: atRisk };
      res.json(response);
    } catch (err) {
      next(err);
    }
});

export default router;
