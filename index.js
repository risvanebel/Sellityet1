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
const { generateInvoiceHTML, generateInvoicePDF } = require('./src/utils/invoice');
const { detectTenant, requireTenant } = require('./src/middleware/tenant');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    console.error('❌ JWT_SECRET not set');
    process.exit(1);
}

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Fix product images table (run before other routes)
app.get('/api/fix-product-images', async (req, res) => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS product_images (
                id SERIAL PRIMARY KEY,
                product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                image_url VARCHAR(500) NOT NULL,
                alt_text VARCHAR(255),
                sort_order INTEGER DEFAULT 0,
                is_primary BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_product_images_sort ON product_images(product_id, sort_order)`);
        res.json({ success: true, message: 'Product images table created' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Tenant detection middleware (before static files)
app.use(detectTenant);

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
        min_order_amount, max_discount_amount, usage_limit, customer_usage_limit,
        valid_from, valid_until, applies_to, product_ids, category_ids,
        exclude_sale_items, excluded_product_ids, excluded_category_ids,
        first_order_only, requires_minimum_items
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
                min_order_amount, max_discount_amount, usage_limit, customer_usage_limit,
                valid_from, valid_until, applies_to, product_ids, category_ids,
                exclude_sale_items, excluded_product_ids, excluded_category_ids,
                first_order_only, requires_minimum_items
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
            RETURNING *
        `, [
            shopId, code.toUpperCase(), description, discount_type || 'percentage', discount_value,
            min_order_amount || 0, max_discount_amount || null, usage_limit || null, customer_usage_limit || null,
            valid_from || new Date(), valid_until || null, applies_to || 'all',
            product_ids || null, category_ids || null,
            exclude_sale_items || false, excluded_product_ids || null, excluded_category_ids || null,
            first_order_only || false, requires_minimum_items || 0
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
    const {
        code, description, discount_type, discount_value,
        min_order_amount, max_discount_amount, usage_limit, customer_usage_limit,
        valid_from, valid_until, is_active, applies_to, product_ids, category_ids,
        exclude_sale_items, excluded_product_ids, excluded_category_ids,
        first_order_only, requires_minimum_items
    } = req.body;

    try {
        // Build dynamic update query
        const updates = [];
        const values = [];
        let paramIdx = 1;

        if (code !== undefined) { updates.push(`code = $${paramIdx++}`); values.push(code.toUpperCase()); }
        if (description !== undefined) { updates.push(`description = $${paramIdx++}`); values.push(description); }
        if (discount_type !== undefined) { updates.push(`discount_type = $${paramIdx++}`); values.push(discount_type); }
        if (discount_value !== undefined) { updates.push(`discount_value = $${paramIdx++}`); values.push(discount_value); }
        if (min_order_amount !== undefined) { updates.push(`min_order_amount = $${paramIdx++}`); values.push(min_order_amount); }
        if (max_discount_amount !== undefined) { updates.push(`max_discount_amount = $${paramIdx++}`); values.push(max_discount_amount); }
        if (usage_limit !== undefined) { updates.push(`usage_limit = $${paramIdx++}`); values.push(usage_limit); }
        if (customer_usage_limit !== undefined) { updates.push(`customer_usage_limit = $${paramIdx++}`); values.push(customer_usage_limit); }
        if (valid_from !== undefined) { updates.push(`valid_from = $${paramIdx++}`); values.push(valid_from); }
        if (valid_until !== undefined) { updates.push(`valid_until = $${paramIdx++}`); values.push(valid_until); }
        if (is_active !== undefined) { updates.push(`is_active = $${paramIdx++}`); values.push(is_active); }
        if (applies_to !== undefined) { updates.push(`applies_to = $${paramIdx++}`); values.push(applies_to); }
        if (product_ids !== undefined) { updates.push(`product_ids = $${paramIdx++}`); values.push(product_ids); }
        if (category_ids !== undefined) { updates.push(`category_ids = $${paramIdx++}`); values.push(category_ids); }
        if (exclude_sale_items !== undefined) { updates.push(`exclude_sale_items = $${paramIdx++}`); values.push(exclude_sale_items); }
        if (excluded_product_ids !== undefined) { updates.push(`excluded_product_ids = $${paramIdx++}`); values.push(excluded_product_ids); }
        if (excluded_category_ids !== undefined) { updates.push(`excluded_category_ids = $${paramIdx++}`); values.push(excluded_category_ids); }
        if (first_order_only !== undefined) { updates.push(`first_order_only = $${paramIdx++}`); values.push(first_order_only); }
        if (requires_minimum_items !== undefined) { updates.push(`requires_minimum_items = $${paramIdx++}`); values.push(requires_minimum_items); }

        updates.push(`updated_at = CURRENT_TIMESTAMP`);

        values.push(req.params.id, req.user.id);

        const { rows } = await pool.query(`
            UPDATE coupons c
            SET ${updates.join(', ')}
            FROM shops s
            WHERE c.id = $${paramIdx++} AND c.shop_id = s.id AND s.owner_id = $${paramIdx}
            RETURNING c.*
        `, values);

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
        
        // Sales by category
        const { rows: categoryStats } = await pool.query(`
            SELECT 
                COALESCE(c.name, 'Ohne Kategorie') as category,
                SUM(oi.quantity) as items_sold,
                SUM(oi.quantity * oi.unit_price) as revenue
            FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            JOIN products p ON oi.product_id = p.id
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE o.shop_id = $1 
              AND o.created_at >= CURRENT_TIMESTAMP - INTERVAL '${period} days'
              AND o.status != 'cancelled'
            GROUP BY c.name
            ORDER BY revenue DESC
        `, [shopId]);

        // Sales over time (daily)
        const { rows: dailySales } = await pool.query(`
            SELECT 
                DATE(created_at) as date,
                SUM(total_amount) as revenue,
                COUNT(*) as orders
            FROM orders
            WHERE shop_id = $1 
              AND created_at >= CURRENT_TIMESTAMP - INTERVAL '${period} days'
              AND status != 'cancelled'
            GROUP BY DATE(created_at)
            ORDER BY date
        `, [shopId]);

        // Payment method stats
        const { rows: paymentStats } = await pool.query(`
            SELECT 
                payment_method,
                COUNT(*) as order_count,
                SUM(total_amount) as total_revenue
            FROM orders
            WHERE shop_id = $1 
              AND created_at >= CURRENT_TIMESTAMP - INTERVAL '${period} days'
              AND status != 'cancelled'
            GROUP BY payment_method
            ORDER BY total_revenue DESC
        `, [shopId]);

        res.json({
            period: `${period} days`,
            sales: {
                total_revenue: parseFloat(salesRows[0].total_revenue),
                order_count: parseInt(salesRows[0].order_count),
                avg_order_value: parseFloat(salesRows[0].avg_order_value || 0)
            },
            top_products: topProducts,
            recent_orders: recentOrders,
            category_stats: categoryStats,
            daily_sales: dailySales,
            payment_stats: paymentStats
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
    const { code, shop_id, cart_total, product_ids, customer_email, is_first_order } = req.body;

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

        // Check customer usage limit
        if (coupon.customer_usage_limit && customer_email) {
            const { rows: customerUsage } = await pool.query(
                'SELECT COUNT(*) as count FROM coupon_usage WHERE coupon_id = $1 AND customer_email = $2',
                [coupon.id, customer_email]
            );
            if (parseInt(customerUsage[0].count) >= coupon.customer_usage_limit) {
                return res.status(400).json({ error: `You can only use this coupon ${coupon.customer_usage_limit} time(s)` });
            }
        }

        // Check first order only
        if (coupon.first_order_only && !is_first_order) {
            return res.status(400).json({ error: 'This coupon is only valid for first orders' });
        }

        // Check minimum order amount
        if (cart_total < coupon.min_order_amount) {
            return res.status(400).json({
                error: `Minimum order amount is €${coupon.min_order_amount}`
            });
        }

        // Check minimum items requirement
        if (coupon.requires_minimum_items > 0) {
            // This would need item count from cart
        }

        // Check product/category exclusions if product_ids provided
        if (product_ids && product_ids.length > 0) {
            // Check excluded products
            if (coupon.excluded_product_ids && coupon.excluded_product_ids.length > 0) {
                const excludedInCart = product_ids.filter(id => coupon.excluded_product_ids.includes(id));
                if (excludedInCart.length > 0) {
                    return res.status(400).json({ error: 'Coupon does not apply to some items in your cart' });
                }
            }

            // Check if coupon is product-specific
            if (coupon.applies_to === 'products' && coupon.product_ids) {
                const applicableInCart = product_ids.filter(id => coupon.product_ids.includes(id));
                if (applicableInCart.length === 0) {
                    return res.status(400).json({ error: 'Coupon does not apply to any items in your cart' });
                }
            }
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

// ========== SUBDOMAIN / TENANT ROUTES ==========

// Get current shop by subdomain (for frontend)
app.get('/api/shop/current', async (req, res) => {
    if (!req.shop) {
        return res.status(404).json({ error: 'No shop found for this domain' });
    }
    
    try {
        // Return public shop info
        const { rows } = await pool.query(`
            SELECT s.id, s.name, s.slug, s.description, s.logo_url, s.primary_color,
                   s.subdomain, s.custom_domain
            FROM shops s
            WHERE s.id = $1 AND s.is_active = true
        `, [req.shop.id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Shop not found or inactive' });
        }
        
        res.json(rows[0]);
    } catch (error) {
        console.error('Get current shop error:', error);
        res.status(500).json({ error: 'Failed to fetch shop' });
    }
});

// Get products for current shop (subdomain-based)
app.get('/api/shop/products', async (req, res) => {
    if (!req.shop) {
        return res.status(404).json({ error: 'No shop found for this domain' });
    }

    try {
        const { rows } = await pool.query(`
            SELECT p.*, c.name as category_name
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE p.shop_id = $1 AND p.status = 'published'
            ORDER BY p.created_at DESC
        `, [req.shop.id]);

        // Load images for each product (ignore if table doesn't exist)
        for (let product of rows) {
            try {
                const { rows: images } = await pool.query(
                    'SELECT image_url FROM product_images WHERE product_id = $1 ORDER BY is_primary DESC, sort_order',
                    [product.id]
                );
                product.image_urls = images.map(img => img.image_url);
            } catch (imgErr) {
                product.image_urls = product.image_urls || [];
            }
        }

        res.json(rows);
    } catch (error) {
        console.error('Get shop products error:', error);
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

// ========== CUSTOMER AUTH (Shop-bound) ==========

// Register customer (bound to current shop)
app.post('/api/auth/register-customer', async (req, res) => {
    if (!req.shop) {
        return res.status(400).json({ error: 'No shop context' });
    }
    
    const { email, password, first_name, last_name } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }
    
    try {
        // Check if customer exists in this shop
        const { rows: existing } = await pool.query(
            'SELECT id FROM customers WHERE email = $1 AND shop_id = $2',
            [email.toLowerCase(), req.shop.id]
        );
        
        if (existing.length > 0) {
            return res.status(409).json({ error: 'Email already registered in this shop' });
        }
        
        const hash = await bcrypt.hash(password, 10);
        
        const { rows } = await pool.query(`
            INSERT INTO customers (shop_id, email, password_hash, first_name, last_name)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, email, first_name, last_name, created_at
        `, [req.shop.id, email.toLowerCase(), hash, first_name || null, last_name || null]);
        
        const customer = rows[0];
        const token = jwt.sign(
            { id: customer.id, email: customer.email, shop_id: req.shop.id, type: 'customer' },
            JWT_SECRET,
            { expiresIn: '30d' }
        );
        
        res.status(201).json({
            token,
            customer: {
                id: customer.id,
                email: customer.email,
                first_name: customer.first_name,
                last_name: customer.last_name
            }
        });
    } catch (error) {
        console.error('Customer registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Login customer (bound to current shop)
app.post('/api/auth/login-customer', async (req, res) => {
    if (!req.shop) {
        return res.status(400).json({ error: 'No shop context' });
    }
    
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }
    
    try {
        const { rows } = await pool.query(
            'SELECT * FROM customers WHERE email = $1 AND shop_id = $2',
            [email.toLowerCase(), req.shop.id]
        );
        
        if (rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const customer = rows[0];
        const valid = await bcrypt.compare(password, customer.password_hash);
        
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const token = jwt.sign(
            { id: customer.id, email: customer.email, shop_id: req.shop.id, type: 'customer' },
            JWT_SECRET,
            { expiresIn: '30d' }
        );
        
        res.json({
            token,
            customer: {
                id: customer.id,
                email: customer.email,
                first_name: customer.first_name,
                last_name: customer.last_name
            }
        });
    } catch (error) {
        console.error('Customer login error:', error);
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
        // Use slug as subdomain (they should match for simplicity)
        const subdomain = slug;
        
        const { rows } = await pool.query(`
            INSERT INTO shops (owner_id, name, slug, subdomain, description, primary_color)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `, [req.user.id, name, slug, subdomain, description, primary_color || '#2563EB']);
        
        res.status(201).json(rows[0]);
    } catch (error) {
        if (error.code === '23505') {
            return res.status(400).json({ error: 'Slug or subdomain already exists' });
        }
        console.error('Create shop error:', error);
        res.status(500).json({ error: 'Failed to create shop' });
    }
});

// Delete all test products (admin only)
app.delete('/api/admin/cleanup-test-data', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
        // Delete products with test SKUs or names containing 'Test'
        const { rowCount } = await pool.query(`
            DELETE FROM products 
            WHERE sku LIKE 'TEST%' 
               OR name LIKE '%Test%'
               OR name LIKE '%test%'
               OR name LIKE 'Produkt %'
               OR name LIKE 'E-Liquid%'
               OR description LIKE '%Testbeschreibung%'
               OR created_at > CURRENT_TIMESTAMP - INTERVAL '1 hour'
        `);
        
        res.json({ 
            success: true, 
            message: `${rowCount} Test-Produkte gelöscht`,
            deleted_count: rowCount
        });
    } catch (error) {
        console.error('Cleanup error:', error);
        res.status(500).json({ error: error.message });
    }
});

// EMERGENCY: Delete ALL products except specific ones
app.get('/api/nuke-products', async (req, res) => {
    try {
        const { keep } = req.query;
        console.log('☢️ NUKING all products except:', keep);
        
        if (keep) {
            // Delete all products NOT matching the keep pattern
            const { rowCount } = await pool.query(`
                DELETE FROM products 
                WHERE name NOT LIKE $1
            `, [`%${keep}%`]);
            
            res.json({ 
                success: true, 
                message: `${rowCount} Produkte gelöscht`,
                kept_pattern: keep
            });
        } else {
            // Delete ALL products
            const { rowCount } = await pool.query('DELETE FROM products');
            res.json({ 
                success: true, 
                message: `${rowCount} Produkte komplett gelöscht`,
                warning: 'ALL PRODUCTS DELETED'
            });
        }
    } catch (error) {
        console.error('NUKE error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Public cleanup endpoint (no auth required for now)
app.get('/api/cleanup', async (req, res) => {
    try {
        console.log('🧹 Public cleanup requested');
        const { rowCount } = await pool.query(`
            DELETE FROM products 
            WHERE sku LIKE 'TEST%' 
               OR name LIKE '%Test%'
               OR name LIKE 'Produkt %'
               OR description LIKE '%Testbeschreibung%'
        `);
        
        res.json({ 
            success: true, 
            message: `${rowCount} Test-Produkte gelöscht`
        });
    } catch (error) {
        console.error('Cleanup error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Emergency DB fix endpoint
app.get('/api/fix-db', async (req, res) => {
    try {
        // Add payment_methods column
        await pool.query(`
            ALTER TABLE shops 
            ADD COLUMN IF NOT EXISTS payment_methods JSONB DEFAULT '["banktransfer", "cod"]'
        `);
        
        // Add other columns
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS stripe_public_key VARCHAR(255)`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS stripe_secret_key VARCHAR(255)`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS paypal_client_id VARCHAR(255)`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS paypal_client_secret VARCHAR(255)`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS paypal_mode VARCHAR(10) DEFAULT 'sandbox'`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS bank_account_name VARCHAR(255)`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS bank_account_iban VARCHAR(255)`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS bank_account_bic VARCHAR(255)`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS bank_transfer_instructions TEXT`);
        
        // Add email columns
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS email_enabled BOOLEAN DEFAULT false`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS notification_email VARCHAR(255)`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS sender_email VARCHAR(255)`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS smtp_host VARCHAR(255)`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS smtp_port INTEGER DEFAULT 587`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS smtp_user VARCHAR(255)`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS smtp_pass VARCHAR(255)`);
        
        // Create customers table if not exists
        await pool.query(`
            CREATE TABLE IF NOT EXISTS customers (
                id SERIAL PRIMARY KEY,
                shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
                email VARCHAR(255) NOT NULL,
                name VARCHAR(255),
                phone VARCHAR(50),
                shipping_address JSONB,
                total_orders INTEGER DEFAULT 0,
                total_spent DECIMAL(10,2) DEFAULT 0,
                last_order_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(shop_id, email)
            )
        `);
        
        // Add customer_id to orders if not exists
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id)`);
        
        res.json({ success: true, message: 'Database fixed' });
    } catch (error) {
        console.error('Fix DB error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Auto-run missing migrations on health check
async function runMissingMigrations() {
    try {
        const fs = require('fs');
        const path = require('path');
        
        // Check if payment_methods column exists
        const { rows } = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'shops' AND column_name = 'payment_methods'
        `);
        
        if (rows.length === 0) {
            console.log('🔧 Running missing migrations...');
            
            // Run payment migration
            const sqlPath = path.join(__dirname, 'migrations', '005_payments.sql');
            if (fs.existsSync(sqlPath)) {
                const sql = fs.readFileSync(sqlPath, 'utf8');
                await pool.query(sql);
                console.log('✅ Migration 005_payments.sql executed');
            }
            
            // Run coupon migration
            const couponPath = path.join(__dirname, 'migrations', '006_coupons.sql');
            if (fs.existsSync(couponPath)) {
                const couponSql = fs.readFileSync(couponPath, 'utf8');
                await pool.query(couponSql);
                console.log('✅ Migration 006_coupons.sql executed');
            }
            
            console.log('🔧 All migrations completed');
        }
        
        // Check if customers table exists
        const { rows: customerRows } = await pool.query(`
            SELECT table_name FROM information_schema.tables 
            WHERE table_name = 'customers'
        `);
        
        if (customerRows.length === 0) {
            const customerPath = path.join(__dirname, 'migrations', '007_customers.sql');
            if (fs.existsSync(customerPath)) {
                const customerSql = fs.readFileSync(customerPath, 'utf8');
                await pool.query(customerSql);
                console.log('✅ Migration 007_customers.sql executed');
            }
        }
    } catch (error) {
        console.error('Migration error:', error);
    }
}

// Run migrations on startup
setTimeout(runMissingMigrations, 5000);

// Cleanup test products on startup (after migrations)
setTimeout(async () => {
    try {
        console.log('🧹 Cleaning up test products...');
        const { rowCount } = await pool.query(`
            DELETE FROM products 
            WHERE sku LIKE 'TEST%' 
               OR name LIKE '%Test%'
               OR name LIKE 'Produkt %'
               OR created_at > CURRENT_TIMESTAMP - INTERVAL '1 hour'
        `);
        if (rowCount > 0) {
            console.log(`🗑️ Deleted ${rowCount} test products`);
        }
    } catch (error) {
        console.error('Cleanup error:', error);
    }
}, 10000);

// Run missing migrations endpoint
app.get('/api/run-migrations', async (req, res) => {
    try {
        const fs = require('fs');
        const path = require('path');
        const results = [];
        
        // List all migration files to run
        const migrations = [
            '005_payments.sql',
            '006_coupons.sql',
            '007_customers.sql',
            '008_subdomains.sql',
            '009_customer_auth.sql',
            '010_shipping.sql',
            '011_tax_settings.sql',
            '012_product_images.sql',
            '013_coupon_rules.sql',
            '014_customer_phone_fix.sql'
        ];
        
        for (const migration of migrations) {
            const sqlPath = path.join(__dirname, 'migrations', migration);
            if (fs.existsSync(sqlPath)) {
                try {
                    const sql = fs.readFileSync(sqlPath, 'utf8');
                    await pool.query(sql);
                    results.push(`✅ ${migration}`);
                    console.log(`✅ Migration ${migration} executed`);
                } catch (err) {
                    results.push(`⚠️ ${migration}: ${err.message}`);
                    console.error(`⚠️ Migration ${migration} error:`, err.message);
                }
            } else {
                results.push(`❌ ${migration}: Not found`);
            }
        }
        
        res.json({ success: true, message: 'Migrations completed', results });
    } catch (error) {
        console.error('Migration error:', error);
        res.status(500).json({ error: error.message });
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
        
        // Calculate total stock from variants and load images for each product
        for (let product of rows) {
            if (product.has_variants) {
                const { rows: variants } = await pool.query(
                    'SELECT COALESCE(SUM(stock), 0) as total FROM product_variants WHERE product_id = $1 AND is_active = true',
                    [product.id]
                );
                product.quantity = parseInt(variants[0].total);
            }
            
            // Load product images (ignore if table doesn't exist)
            try {
                const { rows: images } = await pool.query(
                    'SELECT image_url FROM product_images WHERE product_id = $1 ORDER BY is_primary DESC, sort_order',
                    [product.id]
                );
                product.image_urls = images.map(img => img.image_url);
            } catch (imgErr) {
                product.image_urls = product.image_urls || [];
            }
        }
        
        res.json(rows);
    } catch (error) {
        console.error('Get owner products error:', error);
        res.status(500).json({ error: 'Failed to fetch products', details: error.message });
    }
});

// PRODUCT CREATION AUDIT LOG
const productCreationLog = [];

function logProductCreation(userId, userEmail, productName, source) {
    const entry = {
        timestamp: new Date().toISOString(),
        userId,
        userEmail,
        productName,
        source,
        userAgent: 'API'
    };
    productCreationLog.push(entry);
    console.log(`📝 PRODUCT CREATED: ${JSON.stringify(entry)}`);
    
    // Keep only last 100 entries
    if (productCreationLog.length > 100) {
        productCreationLog.shift();
    }
}

// View audit log (admin only)
app.get('/api/admin/product-audit', authMiddleware, requireRole('admin'), async (req, res) => {
    res.json({
        recentCreations: productCreationLog.slice(-20),
        totalLogged: productCreationLog.length
    });
});

// ANTI-SPAM: Block automatic product creation
const BLOCKED_PRODUCT_NAMES = ['test', 'produkt', 'e-liquid', 'hardware', 'demo', 'sample'];
const MAX_PRODUCTS_PER_MINUTE = 5;

// Rate limiting map (in-memory, resets on restart)
const productCreationAttempts = new Map();

function isAutoGeneratedProduct(name, sku) {
    if (!name) return false;
    const lowerName = name.toLowerCase();
    return BLOCKED_PRODUCT_NAMES.some(blocked => lowerName.includes(blocked)) ||
           (sku && sku.startsWith('TEST'));
}

function checkRateLimit(userId) {
    const now = Date.now();
    const windowStart = now - 60000; // 1 minute window
    
    if (!productCreationAttempts.has(userId)) {
        productCreationAttempts.set(userId, []);
    }
    
    const attempts = productCreationAttempts.get(userId);
    // Remove old attempts
    const recentAttempts = attempts.filter(time => time > windowStart);
    
    if (recentAttempts.length >= MAX_PRODUCTS_PER_MINUTE) {
        return false; // Rate limit exceeded
    }
    
    recentAttempts.push(now);
    productCreationAttempts.set(userId, recentAttempts);
    return true;
}

// Create product
app.post('/api/owner/products', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    // ANTI-SPAM Check
    if (isAutoGeneratedProduct(req.body.name, req.body.sku)) {
        console.warn(`🚫 BLOCKED auto-generated product attempt by user ${req.user.id}: ${req.body.name}`);
        return res.status(403).json({ 
            error: 'Produkterstellung blockiert. Verdächtiger automatischer Inhalt erkannt.' 
        });
    }
    
    // Rate limiting
    if (!checkRateLimit(req.user.id)) {
        return res.status(429).json({ 
            error: 'Zu viele Produkte in kurzer Zeit. Bitte warte einen Moment.' 
        });
    }
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
        
        // Log product creation for audit
        logProductCreation(req.user.id, req.user.email, product.name, 'manual_api');
        
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

// ========== PRODUCT IMAGES ==========

// Get product images
app.get('/api/owner/products/:id/images', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT pi.* FROM product_images pi
            JOIN products p ON pi.product_id = p.id
            JOIN shops s ON p.shop_id = s.id
            WHERE pi.product_id = $1 AND s.owner_id = $2
            ORDER BY pi.sort_order, pi.created_at
        `, [req.params.id, req.user.id]);
        
        res.json(rows);
    } catch (error) {
        console.error('Get product images error:', error);
        res.status(500).json({ error: 'Failed to fetch images' });
    }
});

// Add product image
app.post('/api/owner/products/:id/images', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    const { image_url, alt_text, is_primary } = req.body;
    
    if (!image_url) {
        return res.status(400).json({ error: 'Image URL required' });
    }
    
    try {
        // Verify ownership
        const { rows: checkRows } = await pool.query(`
            SELECT p.id FROM products p
            JOIN shops s ON p.shop_id = s.id
            WHERE p.id = $1 AND s.owner_id = $2
        `, [req.params.id, req.user.id]);
        
        if (checkRows.length === 0) {
            return res.status(403).json({ error: 'Not your product' });
        }
        
        // If setting as primary, unset others
        if (is_primary) {
            await pool.query(
                'UPDATE product_images SET is_primary = false WHERE product_id = $1',
                [req.params.id]
            );
        }
        
        // Get next sort order
        const { rows: maxOrder } = await pool.query(
            'SELECT COALESCE(MAX(sort_order), -1) + 1 as next_order FROM product_images WHERE product_id = $1',
            [req.params.id]
        );
        
        const { rows } = await pool.query(`
            INSERT INTO product_images (product_id, image_url, alt_text, sort_order, is_primary)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `, [req.params.id, image_url, alt_text || null, maxOrder[0].next_order, is_primary || false]);
        
        res.status(201).json(rows[0]);
    } catch (error) {
        console.error('Add product image error:', error);
        res.status(500).json({ error: 'Failed to add image' });
    }
});

// Delete product image
app.delete('/api/owner/images/:imageId', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    try {
        // Verify ownership
        const { rows: checkRows } = await pool.query(`
            SELECT pi.id FROM product_images pi
            JOIN products p ON pi.product_id = p.id
            JOIN shops s ON p.shop_id = s.id
            WHERE pi.id = $1 AND s.owner_id = $2
        `, [req.params.imageId, req.user.id]);
        
        if (checkRows.length === 0) {
            return res.status(403).json({ error: 'Not your image' });
        }
        
        await pool.query('DELETE FROM product_images WHERE id = $1', [req.params.imageId]);
        res.json({ message: 'Image deleted' });
    } catch (error) {
        console.error('Delete image error:', error);
        res.status(500).json({ error: 'Failed to delete image' });
    }
});

// Set primary image
app.put('/api/owner/images/:imageId/primary', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    try {
        // Get product_id and verify ownership
        const { rows: checkRows } = await pool.query(`
            SELECT pi.id, pi.product_id FROM product_images pi
            JOIN products p ON pi.product_id = p.id
            JOIN shops s ON p.shop_id = s.id
            WHERE pi.id = $1 AND s.owner_id = $2
        `, [req.params.imageId, req.user.id]);
        
        if (checkRows.length === 0) {
            return res.status(403).json({ error: 'Not your image' });
        }
        
        const productId = checkRows[0].product_id;
        
        // Unset all other primary images for this product
        await pool.query(
            'UPDATE product_images SET is_primary = false WHERE product_id = $1',
            [productId]
        );
        
        // Set this as primary
        await pool.query(
            'UPDATE product_images SET is_primary = true WHERE id = $1',
            [req.params.imageId]
        );
        
        res.json({ message: 'Primary image updated' });
    } catch (error) {
        console.error('Set primary image error:', error);
        res.status(500).json({ error: 'Failed to update image' });
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

// ========== CUSTOMERS ==========

// Get all customers for shop
app.get('/api/owner/customers', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT c.*, 
                   (SELECT COUNT(*) FROM orders WHERE customer_id = c.id) as order_count,
                   (SELECT MAX(created_at) FROM orders WHERE customer_id = c.id) as last_order_date
            FROM customers c
            JOIN shops s ON c.shop_id = s.id
            WHERE s.owner_id = $1
            ORDER BY c.created_at DESC
        `, [req.user.id]);
        
        res.json(rows);
    } catch (error) {
        console.error('Get customers error:', error);
        res.status(500).json({ error: 'Failed to fetch customers' });
    }
});

// Get single customer with order history
app.get('/api/owner/customers/:id', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    try {
        // Get customer
        const { rows: customerRows } = await pool.query(`
            SELECT c.* FROM customers c
            JOIN shops s ON c.shop_id = s.id
            WHERE c.id = $1 AND s.owner_id = $2
        `, [req.params.id, req.user.id]);
        
        if (customerRows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }
        
        const customer = customerRows[0];
        
        // Get order history
        const { rows: orders } = await pool.query(`
            SELECT o.*, 
                   (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count
            FROM orders o
            WHERE o.customer_id = $1
            ORDER BY o.created_at DESC
        `, [req.params.id]);
        
        // Get notes
        const { rows: notes } = await pool.query(`
            SELECT cn.*, u.email as created_by_email
            FROM customer_notes cn
            LEFT JOIN users u ON cn.created_by = u.id
            WHERE cn.customer_id = $1
            ORDER BY cn.created_at DESC
        `, [req.params.id]);
        
        customer.orders = orders;
        customer.notes = notes;
        
        res.json(customer);
    } catch (error) {
        console.error('Get customer error:', error);
        res.status(500).json({ error: 'Failed to fetch customer' });
    }
});

// Add note to customer
app.post('/api/owner/customers/:id/notes', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    const { note } = req.body;
    
    if (!note) {
        return res.status(400).json({ error: 'Note required' });
    }
    
    try {
        // Verify customer belongs to owner's shop
        const { rows } = await pool.query(`
            INSERT INTO customer_notes (customer_id, note, created_by)
            SELECT $1, $2, $3
            FROM customers c
            JOIN shops s ON c.shop_id = s.id
            WHERE c.id = $1 AND s.owner_id = $4
            RETURNING *
        `, [req.params.id, note, req.user.id, req.user.id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found' });
        }
        
        res.status(201).json(rows[0]);
    } catch (error) {
        console.error('Add note error:', error);
        res.status(500).json({ error: 'Failed to add note' });
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
// Simple test order endpoint
app.post('/api/test-order', async (req, res) => {
    try {
        const { shop_id, customer_email, items, total_amount } = req.body;
        
        // Create simple order
        const { rows } = await pool.query(`
            INSERT INTO orders (order_number, shop_id, customer_email, total_amount, status, payment_status)
            VALUES ($1, $2, $3, $4, 'pending', 'pending')
            RETURNING *
        `, ['TEST-' + Date.now(), shop_id, customer_email, total_amount]);
        
        res.json(rows[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

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
        
        // Create or update customer
        const { rows: customerRows } = await client.query(`
            INSERT INTO customers (shop_id, email, name, phone, shipping_address, total_orders, total_spent, last_order_at)
            VALUES ($1, $2, $3, $4, $5, 1, $6, CURRENT_TIMESTAMP)
            ON CONFLICT (shop_id, email) DO UPDATE SET
                name = EXCLUDED.name,
                phone = EXCLUDED.phone,
                shipping_address = EXCLUDED.shipping_address,
                total_orders = customers.total_orders + 1,
                total_spent = customers.total_spent + EXCLUDED.total_spent,
                last_order_at = CURRENT_TIMESTAMP
            RETURNING id
        `, [shop_id, customer_email, customer_name, customer_phone, 
            JSON.stringify(shipping_address), total_amount]);
        
        const customerId = customerRows[0].id;
        
        // Create order
        const { rows: orderRows } = await client.query(`
            INSERT INTO orders (order_number, shop_id, customer_id, customer_email, customer_name, customer_phone,
                              shipping_address, total_amount, status, payment_status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 'pending')
            RETURNING *
        `, [orderNumber, shop_id, customerId, customer_email, customer_name, customer_phone,
            JSON.stringify(shipping_address), total_amount]);
        
        const order = orderRows[0];
        
        // Create order items
        for (const item of items) {
            await client.query(`
                INSERT INTO order_items (order_id, product_id, variant_id, product_name, product_sku, 
                                        quantity, unit_price, variant_name)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [order.id, item.product_id, item.variant_id || null, item.product_name || 'Product', item.sku || item.product_sku || null,
                item.quantity, item.unit_price || item.price || 0, item.variant_name || null]);
            
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
        res.status(500).json({ error: 'Failed to create order', details: error.message });
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
        
        // Generate PDF
        const pdfBuffer = await generateInvoicePDF(order, shop);
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="Rechnung-${order.order_number}.pdf"`);
        res.send(pdfBuffer);
        
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

// ========== SHIPPING ==========

// Get shipping zones for shop
app.get('/api/owner/shipping/zones', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT sz.*, 
                   (SELECT COUNT(*) FROM shipping_methods WHERE zone_id = sz.id AND is_active = true) as method_count
            FROM shipping_zones sz
            JOIN shops s ON sz.shop_id = s.id
            WHERE s.owner_id = $1
            ORDER BY sz.is_default DESC, sz.name
        `, [req.user.id]);
        
        res.json(rows);
    } catch (error) {
        console.error('Get shipping zones error:', error);
        res.status(500).json({ error: 'Failed to fetch shipping zones' });
    }
});

// Create shipping zone
app.post('/api/owner/shipping/zones', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    const { name, countries, is_default } = req.body;
    
    if (!name || !countries || !Array.isArray(countries)) {
        return res.status(400).json({ error: 'Name and countries array required' });
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
        
        // If setting as default, unset other defaults
        if (is_default) {
            await pool.query(
                'UPDATE shipping_zones SET is_default = false WHERE shop_id = $1',
                [shopId]
            );
        }
        
        const { rows } = await pool.query(`
            INSERT INTO shipping_zones (shop_id, name, countries, is_default)
            VALUES ($1, $2, $3, $4)
            RETURNING *
        `, [shopId, name, JSON.stringify(countries), is_default || false]);
        
        res.status(201).json(rows[0]);
    } catch (error) {
        console.error('Create shipping zone error:', error);
        res.status(500).json({ error: 'Failed to create shipping zone' });
    }
});

// Get shipping methods
app.get('/api/owner/shipping/methods', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT sm.*, sz.name as zone_name, sz.countries
            FROM shipping_methods sm
            JOIN shipping_zones sz ON sm.zone_id = sz.id
            JOIN shops s ON sm.shop_id = s.id
            WHERE s.owner_id = $1
            ORDER BY sm.sort_order, sm.name
        `, [req.user.id]);
        
        res.json(rows);
    } catch (error) {
        console.error('Get shipping methods error:', error);
        res.status(500).json({ error: 'Failed to fetch shipping methods' });
    }
});

// Create shipping method
app.post('/api/owner/shipping/methods', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    const { zone_id, name, description, price, free_shipping_threshold, estimated_days_min, estimated_days_max } = req.body;
    
    if (!zone_id || !name || price === undefined) {
        return res.status(400).json({ error: 'Zone, name and price required' });
    }
    
    try {
        // Verify zone belongs to owner's shop
        const { rows: zoneRows } = await pool.query(`
            SELECT sz.id, sz.shop_id 
            FROM shipping_zones sz
            JOIN shops s ON sz.shop_id = s.id
            WHERE sz.id = $1 AND s.owner_id = $2
        `, [zone_id, req.user.id]);
        
        if (zoneRows.length === 0) {
            return res.status(403).json({ error: 'Zone not found or not authorized' });
        }
        
        const { rows } = await pool.query(`
            INSERT INTO shipping_methods 
            (shop_id, zone_id, name, description, price, free_shipping_threshold, estimated_days_min, estimated_days_max)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
        `, [zoneRows[0].shop_id, zone_id, name, description, price, free_shipping_threshold, estimated_days_min, estimated_days_max]);
        
        res.status(201).json(rows[0]);
    } catch (error) {
        console.error('Create shipping method error:', error);
        res.status(500).json({ error: 'Failed to create shipping method' });
    }
});

// Calculate shipping costs (public endpoint for checkout)
app.post('/api/shipping/calculate', async (req, res) => {
    const { cart_total, country, weight } = req.body;
    
    if (!req.shop) {
        return res.status(400).json({ error: 'No shop context' });
    }
    
    try {
        // Find matching zone for country
        const { rows: zoneRows } = await pool.query(`
            SELECT id FROM shipping_zones 
            WHERE shop_id = $1 AND countries @> $2::jsonb
            LIMIT 1
        `, [req.shop.id, JSON.stringify([country])]);
        
        let zoneId = null;
        if (zoneRows.length > 0) {
            zoneId = zoneRows[0].id;
        } else {
            // Fall back to default zone
            const { rows: defaultZone } = await pool.query(`
                SELECT id FROM shipping_zones 
                WHERE shop_id = $1 AND is_default = true
                LIMIT 1
            `, [req.shop.id]);
            if (defaultZone.length > 0) {
                zoneId = defaultZone[0].id;
            }
        }
        
        if (!zoneId) {
            return res.json({ methods: [], message: 'No shipping available' });
        }
        
        // Get shipping methods for zone
        const { rows: methods } = await pool.query(`
            SELECT * FROM shipping_methods 
            WHERE zone_id = $1 AND is_active = true
            ORDER BY price
        `, [zoneId]);
        
        // Calculate final price for each method
        const methodsWithPrice = methods.map(m => {
            let finalPrice = parseFloat(m.price);
            
            // Check free shipping threshold
            if (m.free_shipping_threshold && cart_total >= m.free_shipping_threshold) {
                finalPrice = 0;
            }
            
            // Check shop-wide free shipping
            if (req.shop.free_shipping_threshold && cart_total >= req.shop.free_shipping_threshold) {
                finalPrice = 0;
            }
            
            return {
                ...m,
                final_price: finalPrice
            };
        });
        
        res.json({ methods: methodsWithPrice });
    } catch (error) {
        console.error('Calculate shipping error:', error);
        res.status(500).json({ error: 'Failed to calculate shipping' });
    }
});

// Update shop shipping settings
app.put('/api/owner/shops/shipping-settings', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    const { free_shipping_threshold, default_shipping_method } = req.body;
    
    try {
        const { rows } = await pool.query(`
            UPDATE shops 
            SET free_shipping_threshold = $1, default_shipping_method = $2
            WHERE owner_id = $3
            RETURNING id, free_shipping_threshold, default_shipping_method
        `, [free_shipping_threshold || null, default_shipping_method || 'standard', req.user.id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Shop not found' });
        }
        
        res.json(rows[0]);
    } catch (error) {
        console.error('Update shipping settings error:', error);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// ========== TAX SETTINGS ==========

// Get tax rates for shop
app.get('/api/owner/tax-rates', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT tr.*
            FROM tax_rates tr
            JOIN shops s ON tr.shop_id = s.id
            WHERE s.owner_id = $1
            ORDER BY tr.rate DESC
        `, [req.user.id]);
        
        res.json(rows);
    } catch (error) {
        console.error('Get tax rates error:', error);
        res.status(500).json({ error: 'Failed to fetch tax rates' });
    }
});

// Create tax rate
app.post('/api/owner/tax-rates', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    const { name, rate, description, is_default } = req.body;
    
    if (!name || rate === undefined) {
        return res.status(400).json({ error: 'Name and rate required' });
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
        
        // If setting as default, unset others
        if (is_default) {
            await pool.query(
                'UPDATE tax_rates SET is_default = false WHERE shop_id = $1',
                [shopId]
            );
        }
        
        const { rows } = await pool.query(`
            INSERT INTO tax_rates (shop_id, name, rate, description, is_default)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `, [shopId, name, rate, description, is_default || false]);
        
        res.status(201).json(rows[0]);
    } catch (error) {
        console.error('Create tax rate error:', error);
        res.status(500).json({ error: 'Failed to create tax rate' });
    }
});

// Update shop tax settings
app.put('/api/owner/shops/tax-settings', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
    const { default_tax_rate, tax_included, tax_number, vat_id } = req.body;
    
    try {
        const { rows } = await pool.query(`
            UPDATE shops 
            SET default_tax_rate = $1, tax_included = $2, tax_number = $3, vat_id = $4
            WHERE owner_id = $5
            RETURNING id, default_tax_rate, tax_included, tax_number, vat_id
        `, [default_tax_rate || 19.00, tax_included || false, tax_number || null, vat_id || null, req.user.id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Shop not found' });
        }
        
        res.json(rows[0]);
    } catch (error) {
        console.error('Update tax settings error:', error);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// Update shop payment settings - SIMPLIFIED
app.put('/api/owner/shops/payment-settings', authMiddleware, requireRole('owner', 'admin'), async (req, res) => {
  try {
    console.log('Payment settings update requested by user:', req.user.id);
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
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
      bank_transfer_instructions
    } = req.body;
    
    // Validate payment_methods
    if (!Array.isArray(payment_methods)) {
      return res.status(400).json({ error: 'payment_methods must be an array' });
    }
    
    // Get shop for this owner
    const { rows: shopRows } = await pool.query(
      'SELECT id FROM shops WHERE owner_id = $1',
      [req.user.id]
    );
    
    if (shopRows.length === 0) {
      console.log('No shop found for owner:', req.user.id);
      return res.status(404).json({ error: 'No shop found' });
    }
    
    const shopId = shopRows[0].id;
    console.log('Found shop ID:', shopId);
    
    // Simplified update - only update what we have
    const updateQuery = `
      UPDATE shops
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
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $11
      RETURNING id
    `;
    
    const values = [
      JSON.stringify(payment_methods || []),
      stripe_public_key || null,
      stripe_secret_key || null,
      paypal_client_id || null,
      paypal_client_secret || null,
      paypal_mode || 'sandbox',
      bank_account_name || null,
      bank_account_iban || null,
      bank_account_bic || null,
      bank_transfer_instructions || null,
      shopId
    ];
    
    console.log('Executing update...');
    const { rows } = await pool.query(updateQuery, values);
    console.log('Update result:', rows);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Shop not found or no changes made' });
    }
    
    res.json({ success: true, message: 'Payment settings saved', shop_id: rows[0].id });
    
  } catch (error) {
    console.error('Update payment settings ERROR:', error);
    console.error('Error details:', error.message);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: 'Failed to save payment settings',
      details: error.message 
    });
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

// Auto-tests DISABLED - were creating test products on every deploy
// setTimeout(async () => {
//     console.log('🧪 Running auto-tests...');
//     try {
//         const { execSync } = require('child_process');
//         const result = execSync('./scripts/auto-test.sh', { encoding: 'utf8', timeout: 60000 });
//         console.log(result);
//         console.log('✅ Auto-tests completed');
//     } catch (error) {
//         console.error('❌ Auto-tests failed:', error.stdout || error.message);
//     }
// }, 30000);

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 MicroStore Server running on port ${PORT}`);
    console.log(`📊 Health check: /api/health`);
});
// Trigger redeploy Sat Apr 11 18:50:31 CEST 2026
