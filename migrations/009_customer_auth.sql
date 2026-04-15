-- Customer Authentication Migration

-- Add password and auth fields to customers table
ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS first_name VARCHAR(255);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_name VARCHAR(255);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false;

-- Update existing customers - set name from first_name/last_name if needed
UPDATE customers SET first_name = name WHERE first_name IS NULL AND name IS NOT NULL;
