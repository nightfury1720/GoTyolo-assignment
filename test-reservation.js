const { db, initializeDb } = require('./dist/src/db/database');
const { createReservation } = require('./dist/src/services/bookingService');

async function testReservation() {
  try {
    console.log('Initializing database...');
    await initializeDb();

    console.log('Getting a trip from the database...');
    const trip = await db.get('SELECT * FROM trips WHERE status = ? LIMIT 1', ['PUBLISHED']);
    if (!trip) {
      throw new Error('No published trips found');
    }
    console.log('Found trip:', trip.id, trip.title);

    console.log('Creating reservation...');
    const result = await createReservation(trip.id, 'test-user-123', 2);
    console.log('Reservation created:', result);

    console.log('Checking reservations table...');
    const reservations = await db.all('SELECT * FROM reservations WHERE trip_id = ?', [trip.id]);
    console.log('Active reservations:', reservations.length);

    console.log('✅ Reservation test passed!');
  } catch (error) {
    console.error('❌ Reservation test failed:', error);
    process.exit(1);
  } finally {
    db.close();
  }
}

testReservation();
