// MicroStore Backend
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'microstore-secret-key';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database setup - In-Memory für Vercel (Test-Modus)
const db = new sqlite3.Database(':memory:');

// Initialize tables
db.serialize(() => {
  // Users table
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'customer',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Shops table
  db.run(`CREATE TABLE IF NOT EXISTS shops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT,
    logo_url TEXT,
    primary_color TEXT DEFAULT '#FF6B6B',
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_id) REFERENCES users(id)
  )`);

  // Products table
  db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    price DECIMAL(10,2) NOT NULL,
    image_url TEXT,
    category TEXT,
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (shop_id) REFERENCES shops(id)
  )`);

  // Product variants
  db.run(`CREATE TABLE IF NOT EXISTS product_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    price_adjustment DECIMAL(10,2) DEFAULT 0,
    stock INTEGER DEFAULT 0,
    FOREIGN KEY (product_id) REFERENCES products(id)
  )`);
});

// Auth middleware
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// Routes

// Auth routes
app.post('/api/auth/register', async (req, res) => {
  const { email, password, role = 'customer' } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  
  db.run('INSERT INTO users (email, password, role) VALUES (?, ?, ?)', 
    [email, hashedPassword, role], 
    function(err) {
      if (err) return res.status(400).json({ error: err.message });
      const token = jwt.sign({ id: this.lastID, email, role }, JWT_SECRET);
      res.json({ token, user: { id: this.lastID, email, role } });
    }
  );
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  
  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (err || !user) return res.status(400).json({ error: 'User not found' });
    
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid password' });
    
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET);
    res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
  });
});

// Shop routes
app.post('/api/shops', authMiddleware, (req, res) => {
  const { name, slug, description, primary_color } = req.body;
  
  db.run('INSERT INTO shops (owner_id, name, slug, description, primary_color) VALUES (?, ?, ?, ?, ?)',
    [req.user.id, name, slug, description, primary_color],
    function(err) {
      if (err) return res.status(400).json({ error: err.message });
      res.json({ id: this.lastID, message: 'Shop created' });
    }
  );
});

app.get('/api/shops/:slug', (req, res) => {
  db.get('SELECT * FROM shops WHERE slug = ? AND is_active = 1', [req.params.slug], (err, shop) => {
    if (err || !shop) return res.status(404).json({ error: 'Shop not found' });
    res.json(shop);
  });
});

// Product routes
app.post('/api/shops/:shopId/products', authMiddleware, (req, res) => {
  const { name, description, price, category } = req.body;
  
  db.run('INSERT INTO products (shop_id, name, description, price, category) VALUES (?, ?, ?, ?, ?)',
    [req.params.shopId, name, description, price, category],
    function(err) {
      if (err) return res.status(400).json({ error: err.message });
      res.json({ id: this.lastID, message: 'Product created' });
    }
  );
});

app.get('/api/shops/:shopId/products', (req, res) => {
  db.all('SELECT * FROM products WHERE shop_id = ? AND is_active = 1', [req.params.shopId], (err, products) => {
    if (err) return res.status(400).json({ error: err.message });
    res.json(products);
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 MicroStore Server running on port ${PORT}`);
});
