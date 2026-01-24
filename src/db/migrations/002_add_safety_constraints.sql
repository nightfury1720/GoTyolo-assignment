
ALTER TABLE bookings 
ADD CONSTRAINT check_num_seats_positive 
CHECK (num_seats > 0);

ALTER TABLE trips 
ADD CONSTRAINT check_max_capacity_positive 
CHECK (max_capacity > 0);

ALTER TABLE trips 
ADD CONSTRAINT check_price_positive 
CHECK (price > 0);

ALTER TABLE bookings 
ADD CONSTRAINT check_price_at_booking_positive 
CHECK (price_at_booking > 0);

ALTER TABLE trips 
ADD CONSTRAINT check_available_seats_non_negative 
CHECK (available_seats >= 0);

