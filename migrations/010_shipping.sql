-- Shipping Rules Migration

-- Add shipping settings to shops
ALTER TABLE shops ADD COLUMN IF NOT EXISTS free_shipping_threshold DECIMAL(10,2);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS default_shipping_method VARCHAR(50) DEFAULT 'standard';

-- Create shipping zones table
CREATE TABLE IF NOT EXISTS shipping_zones (
    id SERIAL PRIMARY KEY,
    shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL, -- z.B. "Deutschland", "EU", "Weltweit"
    countries JSONB NOT NULL, -- Liste von Länder-Codes ["DE", "AT", "CH"]
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_shipping_zones_shop ON shipping_zones(shop_id);

-- Create shipping methods table
CREATE TABLE IF NOT EXISTS shipping_methods (
    id SERIAL PRIMARY KEY,
    shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    zone_id INTEGER REFERENCES shipping_zones(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL, -- z.B. "Standard", "Express"
    description TEXT,
    price DECIMAL(10,2) NOT NULL DEFAULT 0,
    free_shipping_threshold DECIMAL(10,2), -- ab diesem Betrag kostenlos
    max_weight DECIMAL(10,2), -- maximales Gewicht in kg
    estimated_days_min INTEGER, -- geschätzte Lieferzeit von
    estimated_days_max INTEGER, -- geschätzte Lieferzeit bis
    is_active BOOLEAN DEFAULT true,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_shipping_methods_shop ON shipping_methods(shop_id);
CREATE INDEX IF NOT EXISTS idx_shipping_methods_zone ON shipping_methods(zone_id);

-- Add shipping fields to orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_method VARCHAR(100);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_cost DECIMAL(10,2) DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_zone_id INTEGER;

-- Insert default shipping zones for existing shops
INSERT INTO shipping_zones (shop_id, name, countries, is_default)
SELECT id, 'Deutschland', '["DE"]'::jsonb, true
FROM shops
WHERE NOT EXISTS (
    SELECT 1 FROM shipping_zones WHERE shop_id = shops.id
);

-- Insert default shipping method for existing shops
INSERT INTO shipping_methods (shop_id, zone_id, name, description, price, estimated_days_min, estimated_days_max)
SELECT 
    s.id,
    sz.id,
    'Standard Versand',
    'Lieferung innerhalb Deutschlands',
    4.99,
    2,
    4
FROM shops s
JOIN shipping_zones sz ON sz.shop_id = s.id AND sz.is_default = true
WHERE NOT EXISTS (
    SELECT 1 FROM shipping_methods WHERE shop_id = s.id
);
