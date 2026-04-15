-- Product Variants Migration

-- Product variants table
CREATE TABLE IF NOT EXISTS product_variants (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    sku VARCHAR(50),
    price_adjustment DECIMAL(10,2) DEFAULT 0,
    stock INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add variant support to products table
ALTER TABLE products ADD COLUMN IF NOT EXISTS has_variants BOOLEAN DEFAULT false;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);

-- Update existing products to not have variants
UPDATE products SET has_variants = false WHERE has_variants IS NULL;