-- Migration 010: Add cost_price to products for profit calculation

-- Add cost_price column to products table
ALTER TABLE products 
ADD COLUMN IF NOT EXISTS cost_price DECIMAL(10, 2) DEFAULT 0.00;

-- Add index for profit calculations
CREATE INDEX IF NOT EXISTS idx_products_cost_price ON products(cost_price);

-- Add comment for documentation
COMMENT ON COLUMN products.cost_price IS 'Einkaufspreis für Gewinnberechnung';
