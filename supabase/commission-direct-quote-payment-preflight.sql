-- Read-only payment-schema preflight for the direct-quote Start Work guard.
-- The Original simulated-payment marker is demo_paid_at.

WITH expected_columns(column_name, expected_udt, requirement) AS (
  VALUES
    ('commission_id', 'uuid', 'BASELINE_REQUIRED'),
    ('payer_id', 'uuid', 'BASELINE_REQUIRED'),
    ('payee_id', 'uuid', 'BASELINE_REQUIRED'),
    ('amount', 'numeric', 'BASELINE_REQUIRED'),
    ('currency', 'text', 'BASELINE_REQUIRED'),
    ('status', 'text', 'BASELINE_REQUIRED'),
    ('provider', 'text', 'BASELINE_REQUIRED'),
    ('provider_reference', 'text', 'BASELINE_REQUIRED'),
    ('paid_at', 'timestamptz', 'BASELINE_REQUIRED'),
    ('demo_paid_at', 'timestamptz', 'BASELINE_REQUIRED'),
    ('refunded_at', 'timestamptz', 'BASELINE_REQUIRED'),
    ('refunded_amount', 'numeric', 'BASELINE_REQUIRED')
)
SELECT
  e.requirement,
  e.column_name,
  e.expected_udt,
  c.udt_name AS actual_udt,
  c.is_nullable,
  c.column_default,
  CASE
    WHEN c.column_name IS NULL THEN 'MISSING'
    WHEN c.udt_name <> e.expected_udt THEN 'TYPE MISMATCH'
    ELSE 'PRESENT'
  END AS result
FROM expected_columns AS e
LEFT JOIN information_schema.columns AS c
  ON c.table_schema = 'public'
 AND c.table_name = 'commission_payments'
 AND c.column_name = e.column_name
ORDER BY e.column_name;

SELECT
  con.conname AS constraint_name,
  con.convalidated AS validated,
  pg_get_constraintdef(con.oid, true) AS definition
FROM pg_catalog.pg_constraint AS con
WHERE con.conrelid = to_regclass('public.commission_payments')
  AND con.contype = 'c'
ORDER BY con.conname;
