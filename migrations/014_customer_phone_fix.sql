-- Fix missing customer_phone column in orders table
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(100);
