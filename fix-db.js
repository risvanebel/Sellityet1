const pool = require('./src/config/database');

async function fixDatabase() {
    try {
        console.log('🔧 Fixing database...');
        
        // Add payment_methods column
        await pool.query(`
            ALTER TABLE shops 
            ADD COLUMN IF NOT EXISTS payment_methods JSONB DEFAULT '["banktransfer", "cod"]'
        `);
        console.log('✅ payment_methods column added');
        
        // Add other payment columns
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS stripe_public_key VARCHAR(255)`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS stripe_secret_key VARCHAR(255)`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS paypal_client_id VARCHAR(255)`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS paypal_client_secret VARCHAR(255)`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS paypal_mode VARCHAR(10) DEFAULT 'sandbox'`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS bank_account_name VARCHAR(255)`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS bank_account_iban VARCHAR(255)`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS bank_account_bic VARCHAR(255)`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS bank_transfer_instructions TEXT`);
        console.log('✅ All payment columns added');
        
        // Add email columns
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS email_enabled BOOLEAN DEFAULT false`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS notification_email VARCHAR(255)`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS sender_email VARCHAR(255)`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS smtp_host VARCHAR(255)`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS smtp_port INTEGER DEFAULT 587`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS smtp_user VARCHAR(255)`);
        await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS smtp_pass VARCHAR(255)`);
        console.log('✅ All email columns added');
        
        console.log('🎉 Database fix complete!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

fixDatabase();
