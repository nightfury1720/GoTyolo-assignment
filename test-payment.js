const { v4: uuidv4 } = require('uuid');

async function testPayment() {
  try {
    // Create a booking
    const createResponse = await fetch('http://localhost:3000/api/trips', {
      method: 'GET'
    });
    const tripsData = await createResponse.json();
    const tripId = tripsData.trips[0].id;

    const bookingResponse = await fetch(`http://localhost:3000/api/trips/${tripId}/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: uuidv4(), num_seats: 1 })
    });
    const bookingData = await bookingResponse.json();
    const bookingId = bookingData.booking.id;

    console.log('Created booking:', bookingId);

    // Confirm payment
    const paymentResponse = await fetch('http://localhost:3000/api/payments/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        booking_id: bookingId,
        status: 'success',
        idempotency_key: uuidv4()
      })
    });
    const paymentData = await paymentResponse.json();

    console.log('Payment response:', paymentData);

  } catch (error) {
    console.error('Error:', error);
  }
}

testPayment();
