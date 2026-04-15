-- Extended Coupon Rules Migration

-- Add exclusion rules to coupons
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS exclude_sale_items BOOLEAN DEFAULT false;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS excluded_product_ids INTEGER[] DEFAULT '{}';
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS excluded_category_ids INTEGER[] DEFAULT '{}';
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS customer_usage_limit INTEGER; -- null = unlimited per customer
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS first_order_only BOOLEAN DEFAULT false;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS requires_minimum_items INTEGER DEFAULT 0;

-- Add coupon validation rules description
COMMENT ON COLUMN coupons.exclude_sale_items IS 'If true, items with discount_price are excluded from coupon';
COMMENT ON COLUMN coupons.excluded_product_ids IS 'Array of product IDs excluded from this coupon';
COMMENT ON COLUMN coupons.excluded_category_ids IS 'Array of category IDs excluded from this coupon';
COMMENT ON COLUMN coupons.customer_usage_limit IS 'Maximum times a single customer can use this coupon';
COMMENT ON COLUMN coupons.first_order_only IS 'If true, only customers with no previous orders can use this';
