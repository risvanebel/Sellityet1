-- Add theme support to shops table
ALTER TABLE shops ADD COLUMN IF NOT EXISTS theme VARCHAR(50) DEFAULT 'modern';

-- Update existing shops to have default theme
UPDATE shops SET theme = 'modern' WHERE theme IS NULL;