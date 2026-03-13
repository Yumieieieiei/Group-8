const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// PostgreSQL Connection Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize Database Tables
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_stats (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        total_attempts INT DEFAULT 0,
        total_correct INT DEFAULT 0,
        total_wrong INT DEFAULT 0,
        best_score INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_played TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS attempt_history (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) NOT NULL,
        attempt_number INT,
        score INT,
        total_questions INT,
        accuracy DECIMAL(5,2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (username) REFERENCES user_stats(username) ON DELETE CASCADE
      );
    `);
    console.log('✅ Database initialized successfully');
  } catch (err) {
    console.error('❌ DB init error:', err);
  }
}

initDB();

// ===== API ENDPOINTS =====

// GET user stats
app.get('/api/user/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    if (!username || username.trim() === '') {
      return res.status(400).json({ error: 'Username is required' });
    }

    const result = await pool.query(
      'SELECT * FROM user_stats WHERE username = $1',
      [username]
    );
    
    if (result.rows.length === 0) {
      await pool.query(
        'INSERT INTO user_stats (username) VALUES ($1)',
        [username]
      );
      return res.json({ 
        username, 
        total_attempts: 0, 
        total_correct: 0,
        total_wrong: 0,
        best_score: 0,
        created_at: new Date() 
      });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error getting user stats:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST record attempt
app.post('/api/record-attempt', async (req, res) => {
  try {
    const { username, score, totalQuestions } = req.body;
    
    if (!username || username.trim() === '') {
      return res.status(400).json({ error: 'Username is required' });
    }
    if (score === undefined || score === null) {
      return res.status(400).json({ error: 'Score is required' });
    }
    if (!totalQuestions || totalQuestions <= 0) {
      return res.status(400).json({ error: 'Total questions must be > 0' });
    }

    const correctAnswers = score;
    const wrongAnswers = totalQuestions - score;
    const accuracy = ((score / totalQuestions) * 100).toFixed(2);

    const userCheck = await pool.query(
      'SELECT * FROM user_stats WHERE username = $1',
      [username]
    );
    
    if (userCheck.rows.length === 0) {
      await pool.query(
        `INSERT INTO user_stats (username, total_attempts, total_correct, total_wrong, best_score, last_played) 
         VALUES ($1, 1, $2, $3, $4, CURRENT_TIMESTAMP)`,
        [username, correctAnswers, wrongAnswers, score]
      );
    } else {
      const currentBest = userCheck.rows[0].best_score || 0;
      const newBest = score > currentBest ? score : currentBest;
      
      await pool.query(
        `UPDATE user_stats 
         SET total_attempts = total_attempts + 1,
             total_correct = total_correct + $1,
             total_wrong = total_wrong + $2,
             best_score = $3,
             last_played = CURRENT_TIMESTAMP
         WHERE username = $4`,
        [correctAnswers, wrongAnswers, newBest, username]
      );
    }
    
    const attemptNum = await pool.query(
      'SELECT COUNT(*) as count FROM attempt_history WHERE username = $1',
      [username]
    );
    
    const currentAttemptNumber = parseInt(attemptNum.rows[0].count) + 1;
    
    await pool.query(
      `INSERT INTO attempt_history (username, attempt_number, score, total_questions, accuracy) 
       VALUES ($1, $2, $3, $4, $5)`,
      [username, currentAttemptNumber, score, totalQuestions, accuracy]
    );
    
    const updated = await pool.query(
      'SELECT * FROM user_stats WHERE username = $1',
      [username]
    );
    
    res.status(201).json({
      success: true,
      message: 'Attempt recorded successfully',
      userStats: updated.rows[0],
      attemptData: {
        attemptNumber: currentAttemptNumber,
        score,
        totalQuestions,
        accuracy
      }
    });
  } catch (err) {
    console.error('Error recording attempt:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET user history
app.get('/api/history/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    if (!username || username.trim() === '') {
      return res.status(400).json({ error: 'Username is required' });
    }

    const result = await pool.query(
      `SELECT * FROM attempt_history 
       WHERE username = $1 
       ORDER BY created_at DESC 
       LIMIT $2 OFFSET $3`,
      [username, limit, offset]
    );
    
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching history:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    
    const result = await pool.query(
      `SELECT username, total_attempts, total_correct, total_wrong, best_score, last_played
       FROM user_stats 
       ORDER BY best_score DESC, total_correct DESC, total_attempts DESC
       LIMIT $1`,
      [limit]
    );
    
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching leaderboard:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET user statistics summary
app.get('/api/user/:username/stats', async (req, res) => {
  try {
    const { username } = req.params;

    if (!username || username.trim() === '') {
      return res.status(400).json({ error: 'Username is required' });
    }

    const result = await pool.query(
      `SELECT 
        username,
        total_attempts,
        total_correct,
        total_wrong,
        best_score,
        ROUND(CAST(total_correct AS float) / NULLIF(total_attempts, 0) * 100, 2) as overall_accuracy,
        created_at,
        last_played
       FROM user_stats WHERE username = $1`,
      [username]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching stats:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
});
