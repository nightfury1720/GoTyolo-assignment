-- GoTyolo Database Schema
-- Version: 1.0.0

PRAGMA foreign_keys = ON;

-- Trips table
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  destination TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  price REAL NOT NULL,
  max_capacity INTEGER NOT NULL,
  available_seats INTEGER NOT NULL,
  status TEXT CHECK(status IN ('DRAFT', 'PUBLISHED')) NOT NULL,
  refundable_until_days_before INTEGER NOT NULL,
  cancellation_fee_percent INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Bookings table
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  num_seats INTEGER NOT NULL,
  state TEXT CHECK(state IN ('PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'EXPIRED')) NOT NULL,
  price_at_booking REAL NOT NULL,
  payment_reference TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  cancelled_at TEXT,
  refund_amount REAL,
  idempotency_key TEXT UNIQUE,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (trip_id) REFERENCES trips(id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_bookings_trip_id ON bookings(trip_id);
CREATE INDEX IF NOT EXISTS idx_bookings_state ON bookings(state);
CREATE INDEX IF NOT EXISTS idx_bookings_expires_at ON bookings(expires_at);
CREATE INDEX IF NOT EXISTS idx_bookings_idempotency_key ON bookings(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);
