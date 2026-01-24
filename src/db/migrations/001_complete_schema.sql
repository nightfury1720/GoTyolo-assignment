CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS trips (
  id VARCHAR(36) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  destination VARCHAR(255) NOT NULL,
  start_date TIMESTAMP NOT NULL,
  end_date TIMESTAMP NOT NULL,
  price DECIMAL(10,2) NOT NULL CHECK (price > 0),
  max_capacity INTEGER NOT NULL CHECK (max_capacity > 0),
  available_seats INTEGER NOT NULL CHECK (available_seats >= 0),
  status VARCHAR(20) CHECK(status IN ('DRAFT', 'PUBLISHED')) NOT NULL,
  refundable_until_days_before INTEGER NOT NULL,
  cancellation_fee_percent INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id VARCHAR(36) PRIMARY KEY,
  trip_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  num_seats INTEGER NOT NULL CHECK (num_seats > 0),
  state VARCHAR(20) CHECK(state IN ('PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'EXPIRED')) NOT NULL,
  price_at_booking DECIMAL(10,2) NOT NULL CHECK (price_at_booking > 0),
  payment_reference VARCHAR(255),
  created_at TIMESTAMP NOT NULL,
  expires_at TIMESTAMP,
  cancelled_at TIMESTAMP,
  refund_amount DECIMAL(10,2),
  idempotency_key VARCHAR(255) UNIQUE,
  updated_at TIMESTAMP NOT NULL,
  FOREIGN KEY (trip_id) REFERENCES trips(id)
);

CREATE INDEX IF NOT EXISTS idx_bookings_trip_id ON bookings(trip_id);
CREATE INDEX IF NOT EXISTS idx_bookings_state ON bookings(state);
CREATE INDEX IF NOT EXISTS idx_bookings_expires_at ON bookings(expires_at);
CREATE INDEX IF NOT EXISTS idx_bookings_idempotency_key ON bookings(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);

CREATE INDEX IF NOT EXISTS idx_bookings_pending_availability ON bookings(trip_id, expires_at) WHERE state = 'PENDING_PAYMENT';

