-- DEPRECATED: Final Delivery is intentionally not deployable from this file.
-- Apply foundation migration first, then activation migration last.
do $$
begin
  raise exception 'DEPRECATED_FINAL_DELIVERY_COMBINED_MIGRATION: Apply supabase/commission-final-delivery-foundation.sql first, then supabase/commission-final-delivery-activation.sql last.';
end;
$$;
