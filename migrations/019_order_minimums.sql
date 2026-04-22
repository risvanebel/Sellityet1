-- Add minimum order settings to shops
ALTER TABLE shops ADD COLUMN IF NOT EXISTS min_order_quantity INTEGER DEFAULT 1 CHECK (min_order_quantity >= 1);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS min_order_amount DECIMAL(10,2) DEFAULT 0 CHECK (min_order_amount >= 0);
