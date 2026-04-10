// MicroStore Backend - Multi-Role Version
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

// Database setup - In-Memory für Test (später PostgreSQL)
const db = new sqlite3.Database(':memory:');

// Initialize tables
function initDB() {
  return new Promise((resolve) => {
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

      // Hardcoded Admin-Account erstellen
      const adminEmail = 'admin@sellityet.com';
      const adminPassword = 'admin123';
      
      bcrypt.hash(adminPassword, 10).then(hashedPassword => {
        db.run('INSERT OR IGNORE INTO users (id, email, password, role) VALUES (1, ?, ?, ?)', 
          [adminEmail, hashedPassword, 'admin'], 
          (err) => {
            if (err) console.log('Admin exists or error:', err);
            else console.log('✅ Admin-Account erstellt:', adminEmail);
            resolve();
          }
        );
      });
    });
  });
}

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

// Admin middleware
const adminMiddleware = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// Owner middleware
const ownerMiddleware = (req, res, next) => {
  if (req.user.role !== 'owner' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Shop owner access required' });
  }
  next();
};

// ========== AUTH ROUTES ==========

// Register
app.post('/api/auth/register', async (req, res) => {
  const { email, password, role = 'customer' } = req.body;
  
  // Nur 'customer' oder 'owner' erlaubt beim Register
  const allowedRoles = ['customer', 'owner'];
  const userRole = allowedRoles.includes(role) ? role : 'customer';
  
  const hashedPassword = await bcrypt.hash(password, 10);
  
  db.run('INSERT INTO users (email, password, role) VALUES (?, ?, ?)', 
    [email, hashedPassword, userRole], 
    function(err) {
      if (err) return res.status(400).json({ error: err.message });
      const token = jwt.sign({ id: this.lastID, email, role: userRole }, JWT_SECRET);
      res.json({ token, user: { id: this.lastID, email, role: userRole } });
    }
  );
});

// Login
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

// ========== PUBLIC ROUTES (Kunden) ==========

// Alle Shops ansehen
app.get('/api/shops', (req, res) => {
  db.all('SELECT s.*, u.email as owner_email FROM shops s JOIN users u ON s.owner_id = u.id WHERE s.is_active = 1', [], (err, shops) => {
    if (err) return res.status(400).json({ error: err.message });
    res.json(shops);
  });
});

// Einzelnen Shop ansehen
app.get('/api/shops/:slug', (req, res) => {
  db.get('SELECT * FROM shops WHERE slug = ? AND is_active = 1', [req.params.slug], (err, shop) => {
    if (err || !shop) return res.status(404).json({ error: 'Shop not found' });
    res.json(shop);
  });
});

// Produkte eines Shops ansehen
app.get('/api/shops/:shopId/products', (req, res) => {
  db.all('SELECT * FROM products WHERE shop_id = ? AND is_active = 1', [req.params.shopId], (err, products) => {
    if (err) return res.status(400).json({ error: err.message });
    res.json(products);
  });
});

// ========== OWNER ROUTES (Shop-Besitzer) ==========

// Eigene Shops verwalten
app.get('/api/owner/shops', authMiddleware, ownerMiddleware, (req, res) => {
  db.all('SELECT * FROM shops WHERE owner_id = ?', [req.user.id], (err, shops) => {
    if (err) return res.status(400).json({ error: err.message });
    res.json(shops);
  });
});

// Shop erstellen
app.post('/api/owner/shops', authMiddleware, ownerMiddleware, (req, res) => {
  const { name, slug, description, primary_color } = req.body;
  
  db.run('INSERT INTO shops (owner_id, name, slug, description, primary_color) VALUES (?, ?, ?, ?, ?)',
    [req.user.id, name, slug, description, primary_color || '#FF6B6B'],
    function(err) {
      if (err) return res.status(400).json({ error: err.message });
      res.json({ id: this.lastID, message: 'Shop created' });
    }
  );
});

// Produkt erstellen
app.post('/api/owner/products', authMiddleware, ownerMiddleware, (req, res) => {
  const { shop_id, name, description, price, category } = req.body;
  
  // Prüfen ob Shop dem User gehört
  db.get('SELECT * FROM shops WHERE id = ? AND owner_id = ?', [shop_id, req.user.id], (err, shop) => {
    if (err || !shop) return res.status(403).json({ error: 'Not your shop' });
    
    db.run('INSERT INTO products (shop_id, name, description, price, category) VALUES (?, ?, ?, ?, ?)',
      [shop_id, name, description, price, category],
      function(err) {
        if (err) return res.status(400).json({ error: err.message });
        res.json({ id: this.lastID, message: 'Product created' });
      }
    );
  });
});

// ========== ADMIN ROUTES (Du als Eigentümer) ==========

// Alle User sehen
app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  db.all('SELECT id, email, role, created_at FROM users', [], (err, users) => {
    if (err) return res.status(400).json({ error: err.message });
    res.json(users);
  });
});

// Alle Shops sehen (inkl. inaktive)
app.get('/api/admin/shops', authMiddleware, adminMiddleware, (req, res) => {
  db.all('SELECT s.*, u.email as owner_email FROM shops s JOIN users u ON s.owner_id = u.id', [], (err, shops) => {
    if (err) return res.status(400).json({ error: err.message });
    res.json(shops);
  });
});

// Alle Produkte sehen
app.get('/api/admin/products', authMiddleware, adminMiddleware, (req, res) => {
  db.all('SELECT p.*, s.name as shop_name FROM products p JOIN shops s ON p.shop_id = s.id', [], (err, products) => {
    if (err) return res.status(400).json({ error: err.message });
    res.json(products);
  });
});

// Shop löschen
app.delete('/api/admin/shops/:id', authMiddleware, adminMiddleware, (req, res) => {
  db.run('DELETE FROM shops WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(400).json({ error: err.message });
    res.json({ message: 'Shop deleted' });
  });
});

// Produkt löschen
app.delete('/api/admin/products/:id', authMiddleware, adminMiddleware, (req, res) => {
  db.run('DELETE FROM products WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(400).json({ error: err.message });
    res.json({ message: 'Product deleted' });
  });
});

// User löschen
app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  if (req.params.id == '1') return res.status(400).json({ error: 'Cannot delete admin' });
  db.run('DELETE FROM users WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(400).json({ error: err.message });
    res.json({ message: 'User deleted' });
  });
});

// Start server
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 MicroStore Server running on port ${PORT}`);
    console.log(`👤 Admin-Login: admin@sellityet.com / admin123`);
  });
});
