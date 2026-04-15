-- Tax Settings Migration

-- Add tax settings to shops
ALTER TABLE shops ADD COLUMN IF NOT EXISTS default_tax_rate DECIMAL(5,2) DEFAULT 19.00; -- Standard 19% MwSt
ALTER TABLE shops ADD COLUMN IF NOT EXISTS tax_included BOOLEAN DEFAULT false; -- false = zzgl. MwSt, true = inkl. MwSt
ALTER TABLE shops ADD COLUMN IF NOT EXISTS tax_number VARCHAR(50); -- USt-IdNr.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS vat_id VARCHAR(50); -- VAT ID für Rechnungen

-- Add tax rate to products (optional, falls abweichend vom Standard)
ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_rate DECIMAL(5,2); -- NULL = Shop-Standard verwenden

-- Add tax breakdown to orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_amount DECIMAL(10,2) DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_rate DECIMAL(5,2) DEFAULT 19.00;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal DECIMAL(10,2) DEFAULT 0; -- Netto oder Brutto je nach Einstellung

-- Create tax rates table for multiple tax rates per shop
CREATE TABLE IF NOT EXISTS tax_rates (
    id SERIAL PRIMARY KEY,
    shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL, -- z.B. "Standard", "Ermäßigt", "Befreit"
    rate DECIMAL(5,2) NOT NULL, -- z.B. 19.00, 7.00, 0.00
    description TEXT,
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tax_rates_shop ON tax_rates(shop_id);

-- Insert default tax rates for existing shops
INSERT INTO tax_rates (shop_id, name, rate, description, is_default)
SELECT id, 'Standard (19%)', 19.00, 'Regulärer Mehrwertsteuersatz', true
FROM shops
WHERE NOT EXISTS (
    SELECT 1 FROM tax_rates WHERE shop_id = shops.id
);

INSERT INTO tax_rates (shop_id, name, rate, description, is_default)
SELECT id, 'Ermäßigt (7%)', 7.00, 'Ermäßigter Mehrwertsteuersatz für Lebensmittel, Bücher etc.', false
FROM shops
WHERE NOT EXISTS (
    SELECT 1 FROM tax_rates WHERE shop_id = shops.id AND rate = 7.00
);
