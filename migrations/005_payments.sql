-- Payment Methods Migration

-- Add payment methods to shops
ALTER TABLE shops ADD COLUMN IF NOT EXISTS payment_methods JSONB DEFAULT '["banktransfer", "cod"]';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS stripe_public_key VARCHAR(255);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS stripe_secret_key VARCHAR(255);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS paypal_client_id VARCHAR(255);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS paypal_client_secret VARCHAR(255);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS paypal_mode VARCHAR(10) DEFAULT 'sandbox';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS bank_account_name VARCHAR(255);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS bank_account_iban VARCHAR(255);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS bank_account_bic VARCHAR(255);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS bank_transfer_instructions TEXT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS sepa_mandate_text TEXT;

-- Update orders table with payment details
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_provider VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_intent_id VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_id VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS crypto_currency VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS crypto_address VARCHAR(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS crypto_amount DECIMAL(20, 8);

-- Create payment transactions log
CREATE TABLE IF NOT EXISTS payment_transactions (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    transaction_id VARCHAR(255),
    amount DECIMAL(10,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'EUR',
    status VARCHAR(50) NOT NULL,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_order ON payment_transactions(order_id);
