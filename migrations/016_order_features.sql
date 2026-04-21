-- Order notes and partial shipment support

CREATE TABLE IF NOT EXISTS order_notes (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    note TEXT NOT NULL,
    created_by VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_order_notes_order ON order_notes(order_id);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_items JSONB DEFAULT '[]';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_partial_shipment BOOLEAN DEFAULT false;