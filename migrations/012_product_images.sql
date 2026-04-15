-- Multiple Product Images Migration

-- Create product_images table for multiple images per product
CREATE TABLE IF NOT EXISTS product_images (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    image_url VARCHAR(500) NOT NULL,
    alt_text VARCHAR(255),
    sort_order INTEGER DEFAULT 0,
    is_primary BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id);
CREATE INDEX IF NOT EXISTS idx_product_images_sort ON product_images(product_id, sort_order);

-- Migrate existing image_urls from products table
-- Convert existing image_urls array to product_images records
DO $$
DECLARE
    prod RECORD;
    img_url TEXT;
    img_order INTEGER := 0;
BEGIN
    FOR prod IN SELECT id, image_urls FROM products WHERE image_urls IS NOT NULL AND array_length(image_urls, 1) > 0
    LOOP
        img_order := 0;
        FOREACH img_url IN ARRAY prod.image_urls
        LOOP
            INSERT INTO product_images (product_id, image_url, sort_order, is_primary)
            VALUES (prod.id, img_url, img_order, img_order = 0)
            ON CONFLICT DO NOTHING;
            img_order := img_order + 1;
        END LOOP;
    END LOOP;
END $$;
