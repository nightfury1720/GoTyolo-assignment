export const STATES = {
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  CONFIRMED: 'CONFIRMED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
} as const;

export type BookingState = typeof STATES[keyof typeof STATES];

export const EVENTS = {
  PAYMENT_SUCCESS: 'PAYMENT_SUCCESS',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  AUTO_EXPIRE: 'AUTO_EXPIRE',
  CANCEL_BEFORE_CUTOFF: 'CANCEL_BEFORE_CUTOFF',
  CANCEL_AFTER_CUTOFF: 'CANCEL_AFTER_CUTOFF',
} as const;

export type BookingEvent = typeof EVENTS[keyof typeof EVENTS];

export type TripStatus = 'DRAFT' | 'PUBLISHED';

export interface TripRow {
  id: string;
  title: string;
  destination: string;
  start_date: string;
  end_date: string;
  price: number;
  max_capacity: number;
  available_seats: number;
  status: TripStatus;
  refundable_until_days_before: number;
  cancellation_fee_percent: number;
  created_at: string;
  updated_at: string;
}

export interface BookingRow {
  id: string;
  trip_id: string;
  user_id: string;
  num_seats: number;
  state: BookingState;
  price_at_booking: number;
  payment_reference: string | null;
  created_at: string;
  expires_at: string | null;
  cancelled_at: string | null;
  refund_amount: number | null;
  idempotency_key: string | null;
  updated_at: string;
}




export interface TripMetricsResponse {
  trip_id: string;
  title: string;
  occupancy_percent: number;
  total_seats: number;
  booked_seats: number;
  available_seats: number;
  booking_summary: {
    confirmed: number;
    pending_payment: number;
    cancelled: number;
    expired: number;
  };
  financial: {
    gross_revenue: number;
    refunds_issued: number;
    net_revenue: number;
  };
}

export interface AtRiskTrip {
  trip_id: string;
  title: string;
  departure_date: string;
  occupancy_percent: number;
  reason: string;
}

export interface AtRiskTripsResponse {
  at_risk_trips: AtRiskTrip[];
}

export type TransitionMap = {
  [K in BookingState]?: {
    [E in BookingEvent]?: BookingState;
  };
};

export const TRANSITIONS: TransitionMap = {
  [STATES.PENDING_PAYMENT]: {
    [EVENTS.PAYMENT_SUCCESS]: STATES.CONFIRMED,
    [EVENTS.PAYMENT_FAILED]: STATES.EXPIRED,
    [EVENTS.AUTO_EXPIRE]: STATES.EXPIRED,
  },
  [STATES.CONFIRMED]: {
    [EVENTS.CANCEL_BEFORE_CUTOFF]: STATES.CANCELLED,
    [EVENTS.CANCEL_AFTER_CUTOFF]: STATES.CANCELLED,
  },
};

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}
