-- Add reservations table for Two-Phase Commit (2PC) booking system
-- Phase 1: Create soft reservation (doesn't decrease available_seats)
-- Phase 2: Confirm reservation (decreases available_seats, creates booking)

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  num_seats INTEGER NOT NULL,
  price_at_reservation REAL NOT NULL,
  booking_id TEXT,  -- NULL until Phase 2 confirmation
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (trip_id) REFERENCES trips(id),
  FOREIGN KEY (booking_id) REFERENCES bookings(id)
);

-- Index for finding active reservations by trip
CREATE INDEX IF NOT EXISTS idx_reservations_trip_id ON reservations(trip_id);
-- Index for finding expired reservations
CREATE INDEX IF NOT EXISTS idx_reservations_expires_at ON reservations(expires_at);
-- Index for finding reservation by booking_id
CREATE INDEX IF NOT EXISTS idx_reservations_booking_id ON reservations(booking_id);

