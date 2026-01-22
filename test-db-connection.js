const { db, initializeDb } = require('./dist/src/db/database');

async function testConnection() {
  try {
    console.log('Initializing database...');
    await initializeDb();
    console.log('Database initialized successfully');

    console.log('Testing simple query...');
    const result = await db.get('SELECT 1 as test');
    console.log('Query result:', result);

    console.log('✅ Database connection test passed!');
  } catch (error) {
    console.error('❌ Database connection test failed:', error);
    process.exit(1);
  } finally {
    db.close();
  }
}

testConnection();
