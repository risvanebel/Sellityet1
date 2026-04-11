// MicroStore Backend - PostgreSQL Version v2
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./src/config/database');
const { upload, uploadToCloudinary } = require('./src/config/upload');
const { sendOrderConfirmation, sendOrderNotificationToOwner, sendShippingConfirmation } = require('./src/config/email');
const { 
  PAYMENT_METHODS, 
  getEnabledPaymentMethods, 
  createStripePaymentIntent, 
  createPayPalOrder,
  capturePayPalOrder,
  createCryptoPayment,
  getStripeClient
} = require('./src/config/payments');
const { generateInvoiceHTML } = require('./src/utils/invoice');
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

// Get product variants (public)
app.get('/api/shops/:shopId/products/:productId/variants', async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT v.id, v.name, v.price_adjustment, v.stock
            FROM product_variants v
            JOIN products p ON v.product_id = p.id
            WHERE p.id = $1 AND p.shop_id = $2 AND v.is_active = true AND p.status = 'published'
            ORDER BY v.name
        `, [req.params.productId, req.params.shopId]);
        res.json(rows);
    } catch (error) {
        console.error('Get variants error:', error);
        res.status(500).json({ error: 'Failed to fetch variants' });
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
        
        // Run all migrations in order
        const migrations = [
            '001_initial.sql',
            '002_variants.sql',
            '003_orders.sql',
            '004_shop_email.sql',
            '005_payments.sql',
            '006_coupons.sql'
        ];
        
        for (const migration of migrations) {
            const sqlPath = path.join(__dirname, 'migrations', migration);
            if (fs.existsSync(sqlPath)) {
                const sql = fs.readFileSync(sqlPath, 'utf8');
                await pool.query(sql);
                console.log(`✅ Migration ${migration} executed`);
            }
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

// ========== COUPONS ==========

// Get all coupons for shop
app.get('/api/owner/coupons', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT c.*, 
                   (SELECT COUNT(*) FROM coupon_usage WHERE coupon_id = c.id) as times_used
            FROM coupons c
            JOIN shops s ON c.shop_id = s.id
            WHERE s.owner_id = $1
            ORDER BY c.created_at DESC
        `, [req.user.id]);
        
        res.json(rows);
    } catch (error) {
        console.error('Get coupons error:', error);
        res.status(500).json({ error: 'Failed to fetch coupons' });
    }
});

// Create coupon
app.post('/api/owner/coupons', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    const {
        code, description, discount_type, discount_value,
        min_order_amount, max_discount_amount, usage_limit,
        valid_from, valid_until, applies_to, product_ids, category_ids
    } = req.body;
    
    if (!code || !discount_value) {
        return res.status(400).json({ error: 'Code and discount value required' });
    }
    
    try {
        // Get shop for this owner
        const { rows: shopRows } = await pool.query(
            'SELECT id FROM shops WHERE owner_id = $1 LIMIT 1',
            [req.user.id]
        );
        
        if (shopRows.length === 0) {
            return res.status(404).json({ error: 'No shop found' });
        }
        
        const shopId = shopRows[0].id;
        
        const { rows } = await pool.query(`
            INSERT INTO coupons (
                shop_id, code, description, discount_type, discount_value,
                min_order_amount, max_discount_amount, usage_limit,
                valid_from, valid_until, applies_to, product_ids, category_ids
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING *
        `, [
            shopId, code.toUpperCase(), description, discount_type || 'percentage', discount_value,
            min_order_amount || 0, max_discount_amount || null, usage_limit || null,
            valid_from || new Date(), valid_until || null, applies_to || 'all',
            product_ids || null, category_ids || null
        ]);
        
        res.status(201).json(rows[0]);
    } catch (error) {
        console.error('Create coupon error:', error);
        if (error.code === '23505') {
            return res.status(400).json({ error: 'Coupon code already exists' });
        }
        res.status(500).json({ error: 'Failed to create coupon' });
    }
});

// Update coupon
app.put('/api/owner/coupons/:id', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    const { is_active, usage_limit, valid_until } = req.body;
    
    try {
        const { rows } = await pool.query(`
            UPDATE coupons c
            SET is_active = COALESCE($1, is_active),
                usage_limit = COALESCE($2, usage_limit),
                valid_until = COALESCE($3, valid_until),
                updated_at = CURRENT_TIMESTAMP
            FROM shops s
            WHERE c.id = $4 AND c.shop_id = s.id AND s.owner_id = $5
            RETURNING c.*
        `, [is_active, usage_limit, valid_until, req.params.id, req.user.id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Coupon not found' });
        }
        
        res.json(rows[0]);
    } catch (error) {
        console.error('Update coupon error:', error);
        res.status(500).json({ error: 'Failed to update coupon' });
    }
});

// Get shop analytics
app.get('/api/owner/analytics', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    const { period = '30' } = req.query; // days
    
    try {
        // Get shop ID
        const { rows: shopRows } = await pool.query(
            'SELECT id FROM shops WHERE owner_id = $1 LIMIT 1',
            [req.user.id]
        );
        
        if (shopRows.length === 0) {
            return res.json({
                sales: { total: 0, count: 0 },
                topProducts: [],
                recentOrders: []
            });
        }
        
        const shopId = shopRows[0].id;
        
        // Sales stats
        const { rows: salesRows } = await pool.query(`
            SELECT 
                COALESCE(SUM(total_amount), 0) as total_revenue,
                COUNT(*) as order_count,
                AVG(total_amount) as avg_order_value
            FROM orders
            WHERE shop_id = $1 
              AND created_at >= CURRENT_TIMESTAMP - INTERVAL '${period} days'
              AND status != 'cancelled'
        `, [shopId]);
        
        // Top products
        const { rows: topProducts } = await pool.query(`
            SELECT 
                p.name,
                SUM(oi.quantity) as total_sold,
                SUM(oi.quantity * oi.unit_price) as revenue
            FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            JOIN products p ON oi.product_id = p.id
            WHERE o.shop_id = $1 
              AND o.created_at >= CURRENT_TIMESTAMP - INTERVAL '${period} days'
              AND o.status != 'cancelled'
            GROUP BY p.id, p.name
            ORDER BY total_sold DESC
            LIMIT 5
        `, [shopId]);
        
        // Recent orders
        const { rows: recentOrders } = await pool.query(`
            SELECT o.*, 
                   (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count
            FROM orders o
            WHERE o.shop_id = $1
            ORDER BY o.created_at DESC
            LIMIT 5
        `, [shopId]);
        
        res.json({
            period: `${period} days`,
            sales: {
                total_revenue: parseFloat(salesRows[0].total_revenue),
                order_count: parseInt(salesRows[0].order_count),
                avg_order_value: parseFloat(salesRows[0].avg_order_value || 0)
            },
            top_products: topProducts,
            recent_orders: recentOrders
        });
    } catch (error) {
        console.error('Get analytics error:', error);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// Delete coupon
app.delete('/api/owner/coupons/:id', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    try {
        const { rowCount } = await pool.query(`
            DELETE FROM coupons c
            USING shops s
            WHERE c.id = $1 AND c.shop_id = s.id AND s.owner_id = $2
        `, [req.params.id, req.user.id]);
        
        if (rowCount === 0) {
            return res.status(404).json({ error: 'Coupon not found' });
        }
        
        res.json({ message: 'Coupon deleted' });
    } catch (error) {
        console.error('Delete coupon error:', error);
        res.status(500).json({ error: 'Failed to delete coupon' });
    }
});

// Validate and apply coupon (public)
app.post('/api/coupons/validate', async (req, res) => {
    const { code, shop_id, cart_total, product_ids } = req.body;
    
    if (!code || !shop_id) {
        return res.status(400).json({ error: 'Code and shop required' });
    }
    
    try {
        const { rows } = await pool.query(`
            SELECT * FROM coupons
            WHERE code = UPPER($1) 
              AND shop_id = $2 
              AND is_active = true
              AND (valid_until IS NULL OR valid_until > CURRENT_TIMESTAMP)
              AND (valid_from <= CURRENT_TIMESTAMP)
        `, [code, shop_id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Invalid or expired coupon' });
        }
        
        const coupon = rows[0];
        
        // Check usage limit
        if (coupon.usage_limit && coupon.usage_count >= coupon.usage_limit) {
            return res.status(400).json({ error: 'Coupon usage limit reached' });
        }
        
        // Check minimum order amount
        if (cart_total < coupon.min_order_amount) {
            return res.status(400).json({ 
                error: `Minimum order amount is €${coupon.min_order_amount}` 
            });
        }
        
        // Calculate discount
        let discount = 0;
        if (coupon.discount_type === 'percentage') {
            discount = cart_total * (coupon.discount_value / 100);
            if (coupon.max_discount_amount && discount > coupon.max_discount_amount) {
                discount = coupon.max_discount_amount;
            }
        } else {
            discount = coupon.discount_value;
        }
        
        res.json({
            valid: true,
            coupon: {
                id: coupon.id,
                code: coupon.code,
                description: coupon.description,
                discount_type: coupon.discount_type,
                discount_value: coupon.discount_value
            },
            discount_amount: parseFloat(discount.toFixed(2)),
            new_total: parseFloat((cart_total - discount).toFixed(2))
        });
    } catch (error) {
        console.error('Validate coupon error:', error);
        res.status(500).json({ error: 'Failed to validate coupon' });
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

// Get low stock products
app.get('/api/owner/products/low-stock', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    try {
        const threshold = req.query.threshold || 10;
        
        const { rows } = await pool.query(`
            SELECT p.*, c.name as category_name,
                   COALESCE(SUM(pv.stock), p.stock) as total_stock
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.id
            LEFT JOIN product_variants pv ON p.id = pv.product_id
            JOIN shops s ON p.shop_id = s.id
            WHERE s.owner_id = $1
            GROUP BY p.id, c.name
            HAVING COALESCE(SUM(pv.stock), p.stock) <= $2
            ORDER BY total_stock ASC
        `, [req.user.id, threshold]);
        
        res.json(rows);
    } catch (error) {
        console.error('Get low stock products error:', error);
        res.status(500).json({ error: 'Failed to fetch low stock products' });
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
        
        // Create product with image_urls (PostgreSQL array format)
        const pgImageUrls = image_urls ? `{${image_urls.map(url => `"${url.replace(/"/g, '\"')}"`).join(',')}}` : null;
        const { rows: productRows } = await client.query(`
            INSERT INTO products (shop_id, category_id, name, description, price, sku, status, image_urls)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
        `, [shop_id, category_id, name, description, price, sku, status || 'draft', pgImageUrls]);
        
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
        res.status(500).json({ error: 'Failed to create product: ' + error.message });
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
            updateFields.push(`image_urls = $${paramIndex}::text[]`);
            params.push(image_urls || null);
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

// ========== ORDERS ==========

// Get my orders (owner/admin)
app.get('/api/owner/orders', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    try {
        const { status, limit = 50, offset = 0 } = req.query;
        
        let query = `
            SELECT o.*, s.name as shop_name, 
                   COUNT(oi.id) as item_count,
                   u.email as customer_email
            FROM orders o
            JOIN shops s ON o.shop_id = s.id
            LEFT JOIN order_items oi ON o.id = oi.order_id
            LEFT JOIN users u ON o.customer_id = u.id
            WHERE s.owner_id = $1
        `;
        const params = [req.user.id];
        
        if (status) {
            query += ` AND o.status = $${params.length + 1}`;
            params.push(status);
        }
        
        query += ` GROUP BY o.id, s.name, u.email ORDER BY o.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);
        
        const { rows } = await pool.query(query, params);
        res.json(rows);
    } catch (error) {
        console.error('Get orders error:', error);
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// Get order details
app.get('/api/owner/orders/:id', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    try {
        // Get order with items
        const { rows: orderRows } = await pool.query(`
            SELECT o.*, s.name as shop_name, s.slug as shop_slug,
                   u.email as customer_email
            FROM orders o
            JOIN shops s ON o.shop_id = s.id
            LEFT JOIN users u ON o.customer_id = u.id
            WHERE o.id = $1 AND s.owner_id = $2
        `, [req.params.id, req.user.id]);
        
        if (orderRows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        const order = orderRows[0];
        
        // Get order items
        const { rows: items } = await pool.query(`
            SELECT oi.*, p.image_urls
            FROM order_items oi
            LEFT JOIN products p ON oi.product_id = p.id
            WHERE oi.order_id = $1
        `, [req.params.id]);
        
        order.items = items;
        res.json(order);
    } catch (error) {
        console.error('Get order error:', error);
        res.status(500).json({ error: 'Failed to fetch order' });
    }
});

// Update shop email settings
app.put('/api/owner/shops/email-settings', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    const { 
        email_enabled, notification_email, sender_email,
        smtp_host, smtp_port, smtp_user, smtp_pass 
    } = req.body;
    
    try {
        const { rows } = await pool.query(`
            UPDATE shops s
            SET email_enabled = $1,
                notification_email = $2,
                sender_email = $3,
                smtp_host = $4,
                smtp_port = $5,
                smtp_user = $6,
                smtp_pass = $7,
                updated_at = CURRENT_TIMESTAMP
            WHERE s.owner_id = $8
            RETURNING s.*
        `, [
            email_enabled, notification_email, sender_email,
            smtp_host, smtp_port, smtp_user, smtp_pass,
            req.user.id
        ]);
        
        if (rows.length === 0) {
            return res.status(404).json({ error: 'No shop found' });
        }
        
        res.json({ success: true, message: 'Email settings saved' });
    } catch (error) {
        console.error('Update email settings error:', error);
        res.status(500).json({ error: 'Failed to save email settings' });
    }
});

// Update order status
app.put('/api/owner/orders/:id/status', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    const { status, tracking_number } = req.body;
    const validStatuses = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];
    
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }
    
    try {
        const { rows } = await pool.query(`
            UPDATE orders o
            SET status = $1, tracking_number = COALESCE($2, tracking_number), updated_at = CURRENT_TIMESTAMP
            FROM shops s
            WHERE o.id = $3 AND o.shop_id = s.id AND s.owner_id = $4
            RETURNING o.*
        `, [status, tracking_number, req.params.id, req.user.id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        const order = rows[0];
        
        // Send shipping confirmation if status changed to shipped
        if (status === 'shipped' && process.env.SMTP_USER) {
            try {
                // Get shop details
                const { rows: shopRows } = await pool.query(
                    'SELECT * FROM shops WHERE id = $1',
                    [order.shop_id]
                );
                const shop = shopRows[0];
                
                sendShippingConfirmation(order.customer_email, order, shop, tracking_number).catch(console.error);
            } catch (emailError) {
                console.error('Shipping email error:', emailError);
            }
        }
        
        res.json(order);
    } catch (error) {
        console.error('Update order status error:', error);
        res.status(500).json({ error: 'Failed to update order' });
    }
});

// ========== CART (Customer) ==========

// Get or create cart
app.get('/api/cart', async (req, res) => {
    const sessionId = req.headers['x-session-id'] || req.query.session_id;
    const shopId = req.query.shop_id;
    
    if (!sessionId || !shopId) {
        return res.status(400).json({ error: 'Session ID and Shop ID required' });
    }
    
    try {
        // Get or create cart
        let { rows: cartRows } = await pool.query(
            'SELECT * FROM carts WHERE session_id = $1 AND shop_id = $2',
            [sessionId, shopId]
        );
        
        let cart;
        if (cartRows.length === 0) {
            const { rows: newCart } = await pool.query(
                'INSERT INTO carts (session_id, shop_id) VALUES ($1, $2) RETURNING *',
                [sessionId, shopId]
            );
            cart = newCart[0];
        } else {
            cart = cartRows[0];
        }
        
        // Get cart items with product details
        const { rows: items } = await pool.query(`
            SELECT ci.*, p.name as product_name, p.price as product_price, 
                   p.image_urls, v.name as variant_name, v.price_adjustment
            FROM cart_items ci
            JOIN products p ON ci.product_id = p.id
            LEFT JOIN product_variants v ON ci.variant_id = v.id
            WHERE ci.cart_id = $1
        `, [cart.id]);
        
        cart.items = items;
        res.json(cart);
    } catch (error) {
        console.error('Get cart error:', error);
        res.status(500).json({ error: 'Failed to get cart' });
    }
});

// Add to cart
app.post('/api/cart/items', async (req, res) => {
    const { session_id, shop_id, product_id, variant_id, quantity } = req.body;
    
    if (!session_id || !shop_id || !product_id || !quantity) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        // Get or create cart
        let { rows: cartRows } = await client.query(
            'SELECT * FROM carts WHERE session_id = $1 AND shop_id = $2',
            [session_id, shop_id]
        );
        
        let cartId;
        if (cartRows.length === 0) {
            const { rows: newCart } = await client.query(
                'INSERT INTO carts (session_id, shop_id) VALUES ($1, $2) RETURNING id',
                [session_id, shop_id]
            );
            cartId = newCart[0].id;
        } else {
            cartId = cartRows[0].id;
        }
        
        // Check if item already exists
        const { rows: existingItem } = await client.query(
            'SELECT * FROM cart_items WHERE cart_id = $1 AND product_id = $2 AND (variant_id = $3 OR (variant_id IS NULL AND $3 IS NULL))',
            [cartId, product_id, variant_id]
        );
        
        if (existingItem.length > 0) {
            // Update quantity
            await client.query(
                'UPDATE cart_items SET quantity = quantity + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                [quantity, existingItem[0].id]
            );
        } else {
            // Insert new item
            await client.query(
                'INSERT INTO cart_items (cart_id, product_id, variant_id, quantity) VALUES ($1, $2, $3, $4)',
                [cartId, product_id, variant_id, quantity]
            );
        }
        
        await client.query('COMMIT');
        
        res.json({ success: true, message: 'Item added to cart' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Add to cart error:', error);
        res.status(500).json({ error: 'Failed to add item to cart' });
    } finally {
        client.release();
    }
});

// Update cart item quantity
app.put('/api/cart/items/:id', async (req, res) => {
    const { quantity } = req.body;
    
    try {
        if (quantity <= 0) {
            await pool.query('DELETE FROM cart_items WHERE id = $1', [req.params.id]);
        } else {
            await pool.query(
                'UPDATE cart_items SET quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                [quantity, req.params.id]
            );
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Update cart item error:', error);
        res.status(500).json({ error: 'Failed to update cart' });
    }
});

// Remove from cart
app.delete('/api/cart/items/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM cart_items WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Remove from cart error:', error);
        res.status(500).json({ error: 'Failed to remove item' });
    }
});

// ========== CHECKOUT ==========

// Create order from cart
app.post('/api/orders', async (req, res) => {
    const { 
        session_id, shop_id, 
        customer_email, customer_name, customer_phone,
        shipping_address, items, total_amount 
    } = req.body;
    
    if (!shop_id || !customer_email || !items || !total_amount) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        // Generate order number
        const orderNumber = 'ORD-' + Date.now();
        
        // Create order
        const { rows: orderRows } = await client.query(`
            INSERT INTO orders (order_number, shop_id, customer_email, customer_name, customer_phone,
                              shipping_address, total_amount, status, payment_status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 'pending')
            RETURNING *
        `, [orderNumber, shop_id, customer_email, customer_name, customer_phone,
            JSON.stringify(shipping_address), total_amount]);
        
        const order = orderRows[0];
        
        // Create order items
        for (const item of items) {
            await client.query(`
                INSERT INTO order_items (order_id, product_id, variant_id, product_name, product_sku, 
                                        quantity, unit_price, variant_name)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [order.id, item.product_id, item.variant_id, item.product_name, item.sku,
                item.quantity, item.price, item.variant_name]);
            
            // Update inventory
            if (item.variant_id) {
                await client.query(
                    'UPDATE product_variants SET stock = stock - $1 WHERE id = $2',
                    [item.quantity, item.variant_id]
                );
            } else {
                await client.query(
                    'UPDATE inventory SET quantity = quantity - $1 WHERE product_id = $2',
                    [item.quantity, item.product_id]
                );
            }
        }
        
        // Clear cart if session_id provided
        if (session_id) {
            await client.query(
                'DELETE FROM carts WHERE session_id = $1 AND shop_id = $2',
                [session_id, shop_id]
            );
        }
        
        await client.query('COMMIT');
        
        // Send confirmation emails (don't wait for response)
        try {
            // Get shop details
            const { rows: shopRows } = await pool.query(
                'SELECT * FROM shops WHERE id = $1',
                [shop_id]
            );
            const shop = shopRows[0];
            
            // Get owner email
            const { rows: ownerRows } = await pool.query(
                'SELECT email FROM users WHERE id = $1',
                [shop.owner_id]
            );
            const ownerEmail = ownerRows[0]?.email;
            
            // Get order items
            const { rows: orderItems } = await pool.query(
                'SELECT * FROM order_items WHERE order_id = $1',
                [order.id]
            );
            order.items = orderItems;
            
            // Send emails
            if (process.env.SMTP_USER) {
                sendOrderConfirmation(customer_email, order, shop).catch(console.error);
                if (ownerEmail) {
                    sendOrderNotificationToOwner(order, shop, ownerEmail).catch(console.error);
                }
            }
        } catch (emailError) {
            console.error('Email sending error:', emailError);
            // Don't fail the order if email fails
        }
        
        res.status(201).json(order);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Create order error:', error);
        res.status(500).json({ error: 'Failed to create order' });
    } finally {
        client.release();
    }
});

// Get order (customer view)
app.get('/api/orders/:id', async (req, res) => {
    try {
        const { rows: orderRows } = await pool.query(`
            SELECT o.*, s.name as shop_name
            FROM orders o
            JOIN shops s ON o.shop_id = s.id
            WHERE o.id = $1
        `, [req.params.id]);
        
        if (orderRows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        const order = orderRows[0];
        
        const { rows: items } = await pool.query(
            'SELECT * FROM order_items WHERE order_id = $1',
            [req.params.id]
        );
        
        order.items = items;
        res.json(order);
    } catch (error) {
        console.error('Get order error:', error);
        res.status(500).json({ error: 'Failed to get order' });
    }
});

// ========== PAYMENTS ==========

// Get available payment methods for shop (public)
app.get('/api/shops/:shopId/payment-methods', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT payment_methods, stripe_public_key, paypal_client_id, paypal_mode FROM shops WHERE id = $1',
      [req.params.shopId]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }
    
    const shop = rows[0];
    const methods = getEnabledPaymentMethods(shop);
    
    // Add configuration for each method
    const response = methods.map(method => ({
      ...method,
      config: method.type === 'stripe' ? { 
        public_key: shop.stripe_public_key || process.env.STRIPE_PUBLIC_KEY 
      } : 
      method.type === 'paypal' ? {
        client_id: shop.paypal_client_id || process.env.PAYPAL_CLIENT_ID,
        mode: shop.paypal_mode
      } : null
    }));
    
    res.json(response);
  } catch (error) {
    console.error('Get payment methods error:', error);
    res.status(500).json({ error: 'Failed to fetch payment methods' });
  }
});

// Track order (public)
app.get('/api/orders/track', async (req, res) => {
    const { number, email } = req.query;
    
    if (!number || !email) {
        return res.status(400).json({ error: 'Order number and email required' });
    }
    
    try {
        const { rows: orderRows } = await pool.query(`
            SELECT o.*, s.name as shop_name, s.slug as shop_slug
            FROM orders o
            JOIN shops s ON o.shop_id = s.id
            WHERE o.order_number = $1 AND o.customer_email = $2
        `, [number, email]);
        
        if (orderRows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        const order = orderRows[0];
        
        // Get order items
        const { rows: items } = await pool.query(`
            SELECT oi.*, p.name as product_name
            FROM order_items oi
            JOIN products p ON oi.product_id = p.id
            WHERE oi.order_id = $1
        `, [order.id]);
        
        order.items = items;
        
        res.json(order);
    } catch (error) {
        console.error('Track order error:', error);
        res.status(500).json({ error: 'Failed to track order' });
    }
});

// Initialize payment
app.post('/api/orders/:orderId/payment', async (req, res) => {
  const { method } = req.body;
  const orderId = req.params.orderId;
  
  try {
    // Get order with shop
    const { rows: orderRows } = await pool.query(`
      SELECT o.*, s.* 
      FROM orders o 
      JOIN shops s ON o.shop_id = s.id 
      WHERE o.id = $1
    `, [orderId]);
    
    if (orderRows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const order = orderRows[0];
    
    let paymentData;
    
    switch (method) {
      case 'creditcard':
        paymentData = await createStripePaymentIntent(order, order);
        break;
        
      case 'paypal':
        paymentData = await createPayPalOrder(order, order);
        break;
        
      case 'crypto':
        paymentData = await createCryptoPayment(order, req.body.currency || 'BTC');
        await pool.query(
          'UPDATE orders SET crypto_currency = $1, crypto_address = $2, crypto_amount = $3 WHERE id = $4',
          [paymentData.currency, paymentData.address, paymentData.amount, orderId]
        );
        break;
        
      case 'banktransfer':
      case 'sepa':
      case 'paypal_friends':
        // Manual payment methods - just return instructions
        paymentData = {
          instructions: getPaymentInstructions(method, order)
        };
        break;
        
      default:
        return res.status(400).json({ error: 'Invalid payment method' });
    }
    
    // Update order with payment method
    await pool.query(
      'UPDATE orders SET payment_method = $1, payment_provider = $2 WHERE id = $3',
      [method, method === 'creditcard' ? 'stripe' : method, orderId]
    );
    
    res.json({
      method,
      ...paymentData
    });
  } catch (error) {
    console.error('Initialize payment error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Confirm Stripe payment
app.post('/api/orders/:orderId/payment/confirm', async (req, res) => {
  const { payment_intent_id } = req.body;
  const orderId = req.params.orderId;
  
  try {
    // Get shop for Stripe client
    const { rows } = await pool.query(`
      SELECT s.* FROM shops s
      JOIN orders o ON o.shop_id = s.id
      WHERE o.id = $1
    `, [orderId]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const shop = rows[0];
    const stripeClient = getStripeClient(shop) || stripe(process.env.STRIPE_SECRET_KEY);
    
    // Retrieve payment intent
    const paymentIntent = await stripeClient.paymentIntents.retrieve(payment_intent_id);
    
    if (paymentIntent.status === 'succeeded') {
      // Update order status
      await pool.query(
        "UPDATE orders SET payment_status = 'paid', status = 'paid', payment_id = $1 WHERE id = $2",
        [payment_intent_id, orderId]
      );
      
      // Log transaction
      await pool.query(
        'INSERT INTO payment_transactions (order_id, provider, transaction_id, amount, status) VALUES ($1, $2, $3, $4, $5)',
        [orderId, 'stripe', payment_intent_id, paymentIntent.amount / 100, 'completed']
      );
      
      res.json({ success: true, status: 'paid' });
    } else {
      res.json({ success: false, status: paymentIntent.status });
    }
  } catch (error) {
    console.error('Confirm payment error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate invoice PDF
app.get('/api/owner/orders/:orderId/invoice', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    try {
        // Get order with items and shop
        const { rows: orderRows } = await pool.query(`
            SELECT o.*, s.name as shop_name, s.email as shop_email, s.phone as shop_phone, 
                   s.description as shop_description, s.bank_account_name, s.bank_account_iban, 
                   s.bank_account_bic
            FROM orders o
            JOIN shops s ON o.shop_id = s.id
            WHERE o.id = $1 AND s.owner_id = $2
        `, [req.params.orderId, req.user.id]);
        
        if (orderRows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        const order = orderRows[0];
        
        // Get order items
        const { rows: items } = await pool.query(`
            SELECT oi.*, p.name as product_name
            FROM order_items oi
            JOIN products p ON oi.product_id = p.id
            WHERE oi.order_id = $1
        `, [req.params.orderId]);
        
        order.items = items;
        
        const shop = {
            name: order.shop_name,
            email: order.shop_email,
            phone: order.shop_phone,
            description: order.shop_description,
            bank_account_name: order.bank_account_name,
            bank_account_iban: order.bank_account_iban,
            bank_account_bic: order.bank_account_bic
        };
        
        const invoiceHTML = generateInvoiceHTML(order, shop);
        
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Content-Disposition', `inline; filename="Rechnung-${order.order_number}.html"`);
        res.send(invoiceHTML);
        
    } catch (error) {
        console.error('Generate invoice error:', error);
        res.status(500).json({ error: 'Failed to generate invoice' });
    }
});

// Capture PayPal payment
app.post('/api/orders/:orderId/payment/paypal-capture', async (req, res) => {
  const { paypal_order_id } = req.body;
  const orderId = req.params.orderId;
  
  try {
    const { rows } = await pool.query(`
      SELECT s.*, o.total_amount FROM shops s
      JOIN orders o ON o.shop_id = s.id
      WHERE o.id = $1
    `, [orderId]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const shop = rows[0];
    const captureResult = await capturePayPalOrder(paypal_order_id, shop);
    
    if (captureResult.status === 'COMPLETED') {
      await pool.query(
        "UPDATE orders SET payment_status = 'paid', status = 'paid', payment_id = $1 WHERE id = $2",
        [paypal_order_id, orderId]
      );
      
      await pool.query(
        'INSERT INTO payment_transactions (order_id, provider, transaction_id, amount, status) VALUES ($1, $2, $3, $4, $5)',
        [orderId, 'paypal', paypal_order_id, shop.total_amount, 'completed']
      );
      
      res.json({ success: true, status: 'paid' });
    } else {
      res.json({ success: false, status: captureResult.status });
    }
  } catch (error) {
    console.error('PayPal capture error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update shop payment settings
app.put('/api/owner/shops/payment-settings', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
  const {
    payment_methods,
    stripe_public_key,
    stripe_secret_key,
    paypal_client_id,
    paypal_client_secret,
    paypal_mode,
    bank_account_name,
    bank_account_iban,
    bank_account_bic,
    bank_transfer_instructions,
    sepa_mandate_text
  } = req.body;
  
  try {
    const { rows } = await pool.query(`
      UPDATE shops s
      SET payment_methods = $1,
          stripe_public_key = $2,
          stripe_secret_key = $3,
          paypal_client_id = $4,
          paypal_client_secret = $5,
          paypal_mode = $6,
          bank_account_name = $7,
          bank_account_iban = $8,
          bank_account_bic = $9,
          bank_transfer_instructions = $10,
          sepa_mandate_text = $11,
          updated_at = CURRENT_TIMESTAMP
      WHERE s.owner_id = $12
      RETURNING s.*
    `, [
      JSON.stringify(payment_methods),
      stripe_public_key,
      stripe_secret_key,
      paypal_client_id,
      paypal_client_secret,
      paypal_mode,
      bank_account_name,
      bank_account_iban,
      bank_account_bic,
      bank_transfer_instructions,
      sepa_mandate_text,
      req.user.id
    ]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No shop found' });
    }
    
    res.json({ success: true, message: 'Payment settings saved' });
  } catch (error) {
    console.error('Update payment settings error:', error);
    res.status(500).json({ error: 'Failed to save payment settings' });
  }
});

// Helper function for payment instructions
function getPaymentInstructions(method, order) {
  const baseInstructions = {
    banktransfer: `Bitte überweise den Betrag an:\n\nIBAN: [WIRD AUSGEFÜLLT]\nBIC: [WIRD AUSGEFÜLLT]\nVerwendungszweck: ${order.order_number}`,
    sepa: 'SEPA-Lastschrift wird nach Bestellung eingezogen.',
    paypal_friends: 'Bitte sende den Betrag per PayPal an: [E-MAIL]\n\nWichtig: Als "Freunde & Familie" senden!'
  };
  
  return baseInstructions[method] || 'Zahlungsinformationen folgen per E-Mail.';
}

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

// Run auto-tests on startup (after 30s delay for DB connection)
setTimeout(async () => {
    console.log('🧪 Running auto-tests...');
    try {
        const { execSync } = require('child_process');
        const result = execSync('./scripts/auto-test.sh', { encoding: 'utf8', timeout: 60000 });
        console.log(result);
        console.log('✅ Auto-tests completed');
    } catch (error) {
        console.error('❌ Auto-tests failed:', error.stdout || error.message);
    }
}, 30000);

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 MicroStore Server running on port ${PORT}`);
    console.log(`📊 Health check: /api/health`);
});
