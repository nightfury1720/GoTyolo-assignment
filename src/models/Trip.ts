import { TripRow, TripStatus } from '../types';

export class Trip {
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

  constructor(data: TripRow) {
    this.id = data.id;
    this.title = data.title;
    this.destination = data.destination;
    this.start_date = data.start_date;
    this.end_date = data.end_date;
    this.price = data.price;
    this.max_capacity = data.max_capacity;
    this.available_seats = data.available_seats;
    this.status = data.status;
    this.refundable_until_days_before = data.refundable_until_days_before;
    this.cancellation_fee_percent = data.cancellation_fee_percent;
    this.created_at = data.created_at;
    this.updated_at = data.updated_at;
  }

  static fromRow(row: TripRow | undefined): Trip | null {
    return row ? new Trip(row) : null;
  }

  isBookable(): boolean {
    return this.status === 'PUBLISHED' && this.available_seats > 0;
  }

  hasAvailableSeats(numSeats: number): boolean {
    return this.available_seats >= numSeats;
  }

  daysUntilStart(): number {
    const startDate = new Date(this.start_date);
    const now = new Date();
    const diffTime = startDate.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays;
  }

  isRefundable(): boolean {
    const daysUntilStart = this.daysUntilStart();
    return daysUntilStart > this.refundable_until_days_before;
  }

  calculateRefund(priceAtBooking: number): number {
    if (!this.isRefundable()) {
      return 0;
    }
    const refundPercent = 1 - this.cancellation_fee_percent / 100;
    return Number((priceAtBooking * refundPercent).toFixed(2));
  }

  toJSON() {
    return {
      id: this.id,
      title: this.title,
      destination: this.destination,
      start_date: this.start_date,
      end_date: this.end_date,
      price: this.price,
      max_capacity: this.max_capacity,
      available_seats: this.available_seats,
      status: this.status,
      refund_policy: {
        refundable_until_days_before: this.refundable_until_days_before,
        cancellation_fee_percent: this.cancellation_fee_percent,
      },
      created_at: this.created_at,
      updated_at: this.updated_at,
    };
  }
}
