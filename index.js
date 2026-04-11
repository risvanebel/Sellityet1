// MicroStore Backend - PostgreSQL Version v2
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./src/config/database');
const { upload, uploadToCloudinary } = require('./src/config/upload');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    console.error('❌ JWT_SECRET not set');
    process.exit(1);
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Auth middleware
const authMiddleware = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    
    try {
        const user = jwt.verify(token, JWT_SECRET);
        req.user = user;
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Invalid token' });
    }
};

// Role middleware
const requireRole = (...roles) => (req, res, next) => {
    if (!roles.includes(req.user.role)) {
        return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
};

// ========== HEALTH ==========
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', database: 'connected' });
    } catch (error) {
        res.status(500).json({ status: 'error', database: 'disconnected' });
    }
});

// ========== UPLOAD ==========
// Cache bust: 2025-04-11-0908

// Test Cloudinary config
app.get('/api/upload/test', async (req, res) => {
    try {
        const result = await require('cloudinary').v2.api.ping();
        res.json({ status: 'ok', cloudinary: result });
    } catch (error) {
        res.status(500).json({ error: error.message, env: !!process.env.CLOUDINARY_URL });
    }
});

// Direct Cloudinary test
app.post('/api/upload/direct', async (req, res) => {
    try {
        const cloudinary = require('cloudinary').v2;
        // Test with a simple image from URL
        const result = await cloudinary.uploader.upload(
            'https://res.cloudinary.com/demo/image/upload/sample.jpg',
            { folder: 'test' }
        );
        res.json({ success: true, url: result.secure_url });
    } catch (error) {
        console.error('Direct upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Multer error handler middleware
function handleMulterError(err, req, res, next) {
    if (err instanceof multer.MulterError) {
        console.error('Multer error:', err);
        return res.status(400).json({ error: 'Upload error: ' + err.message });
    } else if (err) {
        console.error('Other error:', err);
        return res.status(500).json({ error: err.message });
    }
    next();
}

// Public test endpoint
app.post('/api/upload-test', upload.single('image'), handleMulterError, async (req, res) => {
    try {
        console.log('Upload-test received:', req.file);
        
        if (!req.file) {
            return res.status(400).json({ error: 'Keine Bilddatei' });
        }
        
        console.log('File details:', {
            fieldname: req.file.fieldname,
            originalname: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size
        });
        
        const result = await uploadToCloudinary(req.file.buffer);
        res.json({ url: result.secure_url, public_id: result.public_id });
    } catch (error) {
        console.error('Test upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/upload', authMiddleware, upload.single('image'), async (req, res) => {
    try {
        console.log('Upload request received');
        console.log('File:', req.file ? { name: req.file.originalname, size: req.file.size, mimetype: req.file.mimetype } : 'NO FILE');
        
        if (!req.file) {
            return res.status(400).json({ error: 'Keine Bilddatei empfangen' });
        }
        
        console.log('Uploading to Cloudinary...');
        const result = await uploadToCloudinary(req.file.buffer);
        console.log('Cloudinary result:', result.secure_url);
        res.json({ url: result.secure_url, public_id: result.public_id });
    } catch (error) {
        console.error('Upload error:', error.message, error.stack);
        res.status(500).json({ error: 'Upload fehlgeschlagen: ' + error.message });
    }
});

// ========== SHOP VIEW ==========
app.get('/shop/:slug', (req, res) => {
    res.sendFile(__dirname + '/public/shop-view.html');
});

// ========== SETUP / MIGRATION ==========
app.get('/api/setup', async (req, res) => {
    try {
        const fs = require('fs');
        const path = require('path');
        
        // Run variants migration
        const sqlPath = path.join(__dirname, 'migrations/002_variants.sql');
        if (fs.existsSync(sqlPath)) {
            const sql = fs.readFileSync(sqlPath, 'utf8');
            await pool.query(sql);
        }
        
        res.json({ success: true, message: 'Setup complete' });
    } catch (error) {
        console.error('Setup error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ========== AUTH ==========

// Register
app.post('/api/auth/register', async (req, res) => {
    const { email, password, role = 'customer' } = req.body;
    
    if (!email || !password || password.length < 6) {
        return res.status(400).json({ error: 'Invalid email or password (min 6 chars)' });
    }
    
    const allowedRoles = ['customer', 'owner'];
    const userRole = allowedRoles.includes(role) ? role : 'customer';
    
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const { rows } = await pool.query(
            'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role',
            [email, hashedPassword, userRole]
        );
        
        const user = rows[0];
        const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
        
        res.status(201).json({ token, user });
    } catch (error) {
        if (error.code === '23505') {
            return res.status(400).json({ error: 'Email already registered' });
        }
        console.error('Register error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    
    try {
        const { rows } = await pool.query(
            'SELECT id, email, password_hash, role FROM users WHERE email = $1',
            [email]
        );
        
        if (rows.length === 0) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }
        
        const user = rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        
        if (!valid) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }
        
        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );
        
        res.json({
            token,
            user: { id: user.id, email: user.email, role: user.role }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// ========== PUBLIC ==========

// Get all shops
app.get('/api/shops', async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT s.id, s.name, s.slug, s.description, s.logo_url, s.primary_color, 
                   u.email as owner_email
            FROM shops s
            JOIN users u ON s.owner_id = u.id
            WHERE s.is_active = true
            ORDER BY s.created_at DESC
        `);
        res.json(rows);
    } catch (error) {
        console.error('Get shops error:', error);
        res.status(500).json({ error: 'Failed to fetch shops' });
    }
});

// Get shop by slug
app.get('/api/shops/:slug', async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT s.*, u.email as owner_email
            FROM shops s
            JOIN users u ON s.owner_id = u.id
            WHERE s.slug = $1 AND s.is_active = true
        `, [req.params.slug]);
        
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Shop not found' });
        }
        
        res.json(rows[0]);
    } catch (error) {
        console.error('Get shop error:', error);
        res.status(500).json({ error: 'Failed to fetch shop' });
    }
});

// Get products by shop
app.get('/api/shops/:shopId/products', async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT p.*, i.quantity, i.reserved, i.min_stock, i.max_order_quantity,
                   c.name as category_name
            FROM products p
            LEFT JOIN inventory i ON p.id = i.product_id
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE p.shop_id = $1 AND p.is_active = true AND p.status = 'published'
            ORDER BY p.created_at DESC
        `, [req.params.shopId]);
        
        // Calculate total stock from variants for each product
        for (let product of rows) {
            if (product.has_variants) {
                const { rows: variants } = await pool.query(
                    'SELECT COALESCE(SUM(stock), 0) as total FROM product_variants WHERE product_id = $1 AND is_active = true',
                    [product.id]
                );
                product.quantity = parseInt(variants[0].total);
            }
        }
        
        res.json(rows);
    } catch (error) {
        console.error('Get products error:', error);
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

// ========== OWNER ==========

// Get my shops
app.get('/api/owner/shops', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT s.*, 
                   (SELECT COUNT(*) FROM products WHERE shop_id = s.id) as product_count
            FROM shops s
            WHERE s.owner_id = $1
            ORDER BY s.created_at DESC
        `, [req.user.id]);
        
        res.json(rows);
    } catch (error) {
        console.error('Get owner shops error:', error);
        res.status(500).json({ error: 'Failed to fetch shops' });
    }
});

// Create shop
app.post('/api/owner/shops', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    const { name, slug, description, primary_color } = req.body;
    
    if (!name || !slug) {
        return res.status(400).json({ error: 'Name and slug are required' });
    }
    
    // Validate slug format
    if (!/^[a-z0-9-]+$/.test(slug)) {
        return res.status(400).json({ error: 'Slug can only contain lowercase letters, numbers, and hyphens' });
    }
    
    try {
        const { rows } = await pool.query(`
            INSERT INTO shops (owner_id, name, slug, description, primary_color)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `, [req.user.id, name, slug, description, primary_color || '#2563EB']);
        
        res.status(201).json(rows[0]);
    } catch (error) {
        if (error.code === '23505') {
            return res.status(400).json({ error: 'Slug already exists' });
        }
        console.error('Create shop error:', error);
        res.status(500).json({ error: 'Failed to create shop' });
    }
});

// Get my products
app.get('/api/owner/products', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT p.*, i.quantity, i.reserved, i.min_stock, c.name as category_name
            FROM products p
            LEFT JOIN inventory i ON p.id = i.product_id
            LEFT JOIN categories c ON p.category_id = c.id
            JOIN shops s ON p.shop_id = s.id
            WHERE s.owner_id = $1
            ORDER BY p.created_at DESC
        `, [req.user.id]);
        
        // Calculate total stock from variants for each product
        for (let product of rows) {
            if (product.has_variants) {
                const { rows: variants } = await pool.query(
                    'SELECT COALESCE(SUM(stock), 0) as total FROM product_variants WHERE product_id = $1 AND is_active = true',
                    [product.id]
                );
                product.quantity = parseInt(variants[0].total);
            }
        }
        
        res.json(rows);
    } catch (error) {
        console.error('Get owner products error:', error);
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

// Create product
app.post('/api/owner/products', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    const { shop_id, name, description, price, category_id, sku, status, initial_quantity, image_urls } = req.body;
    
    if (!shop_id || !name || !price) {
        return res.status(400).json({ error: 'Shop ID, name, and price are required' });
    }
    
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        // Verify shop ownership
        const { rows: shopRows } = await client.query(
            'SELECT id FROM shops WHERE id = $1 AND owner_id = $2',
            [shop_id, req.user.id]
        );
        
        if (shopRows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Not your shop' });
        }
        
        // Create product with image_urls
        const { rows: productRows } = await client.query(`
            INSERT INTO products (shop_id, category_id, name, description, price, sku, status, image_urls)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
        `, [shop_id, category_id, name, description, price, sku, status || 'draft', image_urls ? JSON.stringify(image_urls) : null]);
        
        const product = productRows[0];
        
        // Create inventory record
        await client.query(`
            INSERT INTO inventory (product_id, quantity, min_stock)
            VALUES ($1, $2, $3)
        `, [product.id, initial_quantity || 0, 5]);
        
        await client.query('COMMIT');
        
        res.status(201).json(product);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Create product error:', error);
        res.status(500).json({ error: 'Failed to create product' });
    } finally {
        client.release();
    }
});

// Update product
app.put('/api/owner/products/:id', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    const { name, description, price, category_id, sku, status, image_urls } = req.body;
    const productId = req.params.id;
    
    try {
        // Build update fields dynamically
        let updateFields = ['name = $1', 'description = $2', 'price = $3', 'category_id = $4', 
                           'sku = $5', 'status = $6', 'updated_at = CURRENT_TIMESTAMP'];
        let params = [name, description, price, category_id, sku, status];
        let paramIndex = 7;
        
        if (image_urls !== undefined) {
            updateFields.push(`image_urls = $${paramIndex}`);
            params.push(image_urls ? JSON.stringify(image_urls) : null);
            paramIndex++;
        }
        
        params.push(productId, req.user.id);
        
        // Verify ownership through shop
        const { rows } = await pool.query(`
            UPDATE products p
            SET ${updateFields.join(', ')}
            FROM shops s
            WHERE p.id = $${paramIndex} AND p.shop_id = s.id AND s.owner_id = $${paramIndex + 1}
            RETURNING p.*
        `, params);
        
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Product not found or not yours' });
        }
        
        res.json(rows[0]);
    } catch (error) {
        console.error('Update product error:', error);
        res.status(500).json({ error: 'Failed to update product' });
    }
});

// Update inventory
app.put('/api/owner/products/:id/inventory', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    const { quantity, min_stock, max_order_quantity } = req.body;
    const productId = req.params.id;
    
    try {
        // Verify ownership
        const { rows: checkRows } = await pool.query(`
            SELECT p.id FROM products p
            JOIN shops s ON p.shop_id = s.id
            WHERE p.id = $1 AND s.owner_id = $2
        `, [productId, req.user.id]);
        
        if (checkRows.length === 0) {
            return res.status(403).json({ error: 'Not your product' });
        }
        
        const { rows } = await pool.query(`
            INSERT INTO inventory (product_id, quantity, min_stock, max_order_quantity)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (product_id) 
            DO UPDATE SET quantity = $2, min_stock = $3, max_order_quantity = $4, updated_at = CURRENT_TIMESTAMP
            RETURNING *
        `, [productId, quantity, min_stock, max_order_quantity]);
        
        res.json(rows[0]);
    } catch (error) {
        console.error('Update inventory error:', error);
        res.status(500).json({ error: 'Failed to update inventory' });
    }
});

// Get product variants
app.get('/api/owner/products/:id/variants', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT v.* FROM product_variants v
            JOIN products p ON v.product_id = p.id
            JOIN shops s ON p.shop_id = s.id
            WHERE p.id = $1 AND s.owner_id = $2 AND v.is_active = true
            ORDER BY v.name
        `, [req.params.id, req.user.id]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch variants' });
    }
});

// Create variant
app.post('/api/owner/products/:id/variants', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    const { name, sku, price_adjustment, stock } = req.body;
    const productId = req.params.id;
    
    try {
        // Verify ownership
        const { rows: checkRows } = await pool.query(`
            SELECT p.id FROM products p
            JOIN shops s ON p.shop_id = s.id
            WHERE p.id = $1 AND s.owner_id = $2
        `, [productId, req.user.id]);
        
        if (checkRows.length === 0) {
            return res.status(403).json({ error: 'Not your product' });
        }
        
        // Create variant
        const { rows } = await pool.query(`
            INSERT INTO product_variants (product_id, name, sku, price_adjustment, stock)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `, [productId, name, sku, price_adjustment || 0, stock || 0]);
        
        // Update product to indicate it has variants
        await pool.query(`
            UPDATE products SET has_variants = true WHERE id = $1
        `, [productId]);
        
        res.status(201).json(rows[0]);
    } catch (error) {
        res.status(500).json({ error: 'Failed to create variant' });
    }
});

// Delete variant
app.delete('/api/owner/variants/:id', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    try {
        await pool.query(`
            UPDATE product_variants SET is_active = false WHERE id = $1
        `, [req.params.id]);
        res.json({ message: 'Variant deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete variant' });
    }
});

// ========== ADMIN ==========

// Get all users
app.get('/api/admin/users', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT id, email, role, created_at FROM users
            ORDER BY created_at DESC
        `);
        res.json(rows);
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Get all shops (admin)
app.get('/api/admin/shops', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT s.*, u.email as owner_email
            FROM shops s
            JOIN users u ON s.owner_id = u.id
            ORDER BY s.created_at DESC
        `);
        res.json(rows);
    } catch (error) {
        console.error('Get admin shops error:', error);
        res.status(500).json({ error: 'Failed to fetch shops' });
    }
});

// Get stats
app.get('/api/admin/stats', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
        const [users, shops, products, orders] = await Promise.all([
            pool.query('SELECT COUNT(*) FROM users'),
            pool.query('SELECT COUNT(*) FROM shops'),
            pool.query('SELECT COUNT(*) FROM products'),
            pool.query('SELECT COUNT(*), COALESCE(SUM(total_amount), 0) FROM orders')
        ]);
        
        res.json({
            users: parseInt(users.rows[0].count),
            shops: parseInt(shops.rows[0].count),
            products: parseInt(products.rows[0].count),
            orders: parseInt(orders.rows[0].count),
            totalRevenue: parseFloat(orders.rows[0].coalesce)
        });
    } catch (error) {
        console.error('Get stats error:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// Delete user
app.delete('/api/admin/users/:id', authMiddleware, requireRole('admin'), async (req, res) => {
    if (req.params.id === '1') {
        return res.status(400).json({ error: 'Cannot delete admin' });
    }
    
    try {
        await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
        res.json({ message: 'User deleted' });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 MicroStore Server running on port ${PORT}`);
    console.log(`📊 Health check: /api/health`);
});
