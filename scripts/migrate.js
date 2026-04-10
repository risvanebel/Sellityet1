const fs = require('fs');
const path = require('path');
const pool = require('../src/config/database');

async function migrate() {
    try {
        const sqlPath = path.join(__dirname, '../migrations/001_initial.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');
        
        console.log('🔄 Running migrations...');
        
        await pool.query(sql);
        
        console.log('✅ Migrations completed successfully');
        
        // Verify admin user exists
        const { rows } = await pool.query(
            'SELECT email, role FROM users WHERE email = $1',
            ['admin@sellityet.com']
        );
        
        if (rows.length > 0) {
            console.log('✅ Admin user verified:', rows[0].email);
        }
        
        process.exit(0);
    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        process.exit(1);
    }
}

migrate();
