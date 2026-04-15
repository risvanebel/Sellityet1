-- Multi-Tenant Subdomain Support

-- Add subdomain and custom domain support to shops
ALTER TABLE shops ADD COLUMN IF NOT EXISTS subdomain VARCHAR(100) UNIQUE;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS custom_domain VARCHAR(255) UNIQUE;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS domain_verified BOOLEAN DEFAULT false;

-- Create index for fast subdomain lookup
CREATE INDEX IF NOT EXISTS idx_shops_subdomain ON shops(subdomain);
CREATE INDEX IF NOT EXISTS idx_shops_custom_domain ON shops(custom_domain);

-- Update existing shops to generate subdomains from slug
UPDATE shops 
SET subdomain = slug 
WHERE subdomain IS NULL;
