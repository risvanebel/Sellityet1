-- Shop visibility and registration code settings
ALTER TABLE shops ADD COLUMN IF NOT EXISTS visibility_mode VARCHAR(20) DEFAULT 'public' CHECK (visibility_mode IN ('public', 'customers_only'));
ALTER TABLE shops ADD COLUMN IF NOT EXISTS registration_code VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_shops_visibility ON shops(visibility_mode);
