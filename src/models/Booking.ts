import { BookingRow, BookingState, STATES } from '../types';

/**
 * Booking model representing a user's trip reservation
 */
export class Booking {
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

  constructor(data: BookingRow) {
    this.id = data.id;
    this.trip_id = data.trip_id;
    this.user_id = data.user_id;
    this.num_seats = data.num_seats;
    this.state = data.state;
    this.price_at_booking = data.price_at_booking;
    this.payment_reference = data.payment_reference || null;
    this.created_at = data.created_at;
    this.expires_at = data.expires_at || null;
    this.cancelled_at = data.cancelled_at || null;
    this.refund_amount = data.refund_amount || null;
    this.idempotency_key = data.idempotency_key || null;
    this.updated_at = data.updated_at;
  }

  /**
   * Create a Booking instance from a database row
   */
  static fromRow(row: BookingRow | undefined): Booking | null {
    return row ? new Booking(row) : null;
  }

  /**
   * Check if booking is in a terminal state
   */
  isTerminal(): boolean {
    return this.state === STATES.CANCELLED || this.state === STATES.EXPIRED;
  }

  /**
   * Check if booking is expired based on expires_at timestamp
   */
  isExpired(): boolean {
    if (!this.expires_at) {
      return false;
    }
    return new Date(this.expires_at) < new Date();
  }

  /**
   * Check if booking can be cancelled
   */
  canBeCancelled(): boolean {
    return this.state === STATES.CONFIRMED || this.state === STATES.PENDING_PAYMENT;
  }

  /**
   * Check if booking is pending payment
   */
  isPendingPayment(): boolean {
    return this.state === STATES.PENDING_PAYMENT;
  }

  /**
   * Check if booking is confirmed
   */
  isConfirmed(): boolean {
    return this.state === STATES.CONFIRMED;
  }

  /**
   * Convert to JSON-friendly object
   */
  toJSON() {
    return {
      id: this.id,
      trip_id: this.trip_id,
      user_id: this.user_id,
      num_seats: this.num_seats,
      state: this.state,
      price_at_booking: this.price_at_booking,
      payment_reference: this.payment_reference,
      created_at: this.created_at,
      expires_at: this.expires_at,
      cancelled_at: this.cancelled_at,
      refund_amount: this.refund_amount,
      updated_at: this.updated_at,
    };
  }
}
