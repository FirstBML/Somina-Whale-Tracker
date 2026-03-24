import Database from 'better-sqlite3';

// Check if we're in a serverless environment
const isServerless = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';

let db: Database.Database | null = null;

export function getDb() {
  if (isServerless) {
    // Return null or a mock object in serverless environments
    return null;
  }
  
  if (!db) {
    try {
      db = new Database('whales.db');
    } catch (error) {
      console.error('Failed to initialize SQLite database:', error);
      return null;
    }
  }
  return db;
}

// Helper to safely query database
export function safeQuery<T>(query: () => T): T | null {
  if (isServerless) {
    console.log('SQLite query skipped in serverless environment');
    return null;
  }
  try {
    return query();
  } catch (error) {
    console.error('Database query failed:', error);
    return null;
  }
}