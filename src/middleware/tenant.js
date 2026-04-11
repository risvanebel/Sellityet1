const pool = require('../config/database');

// Middleware to detect tenant from subdomain or custom domain
async function detectTenant(req, res, next) {
    try {
        const host = req.headers.host || req.hostname;
        
        // Skip tenant detection for API health checks and static files
        if (req.path.startsWith('/api/health') || 
            req.path.startsWith('/api/setup') ||
            req.path.startsWith('/api/run-migrations') ||
            req.path.startsWith('/api/fix-db') ||
            req.path.startsWith('/api/cleanup')) {
            return next();
        }
        
        // Extract subdomain from host
        // Format: shopname.sellityet.com or shopname.localhost:3000
        const hostParts = host.split('.');
        let subdomain = null;
        
        // Check if it's a subdomain (not main domain)
        if (hostParts.length > 2) {
            // e.g., shopname.sellityet.com -> shopname
            subdomain = hostParts[0];
        } else if (hostParts.length === 2 && !host.includes('localhost')) {
            // Check for custom domain
            const customDomain = host;
            const { rows } = await pool.query(
                'SELECT * FROM shops WHERE custom_domain = $1 AND domain_verified = true',
                [customDomain]
            );
            
            if (rows.length > 0) {
                req.shop = rows[0];
                req.shopId = rows[0].id;
                req.isCustomDomain = true;
                return next();
            }
        }
        
        // If subdomain detected, lookup shop
        if (subdomain && subdomain !== 'www' && subdomain !== 'admin') {
            const { rows } = await pool.query(
                'SELECT * FROM shops WHERE subdomain = $1',
                [subdomain]
            );
            
            if (rows.length > 0) {
                req.shop = rows[0];
                req.shopId = rows[0].id;
                req.subdomain = subdomain;
            }
        }
        
        next();
    } catch (error) {
        console.error('Tenant detection error:', error);
        next();
    }
}

// Middleware to require tenant context
function requireTenant(req, res, next) {
    if (!req.shop) {
        return res.status(404).json({ 
            error: 'Shop not found',
            message: 'This shop does not exist or the URL is incorrect'
        });
    }
    next();
}

module.exports = {
    detectTenant,
    requireTenant
};
