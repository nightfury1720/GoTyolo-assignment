
CREATE TABLE IF NOT EXISTS reservations (
  id VARCHAR(36) PRIMARY KEY,
  trip_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  num_seats INTEGER NOT NULL,
  price_at_reservation DECIMAL(10,2) NOT NULL,
  booking_id VARCHAR(36),  -- NULL until Phase 2 confirmation
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  FOREIGN KEY (trip_id) REFERENCES trips(id),
  FOREIGN KEY (booking_id) REFERENCES bookings(id)
);

CREATE INDEX IF NOT EXISTS idx_reservations_trip_id ON reservations(trip_id);
CREATE INDEX IF NOT EXISTS idx_reservations_expires_at ON reservations(expires_at);
CREATE INDEX IF NOT EXISTS idx_reservations_booking_id ON reservations(booking_id);

