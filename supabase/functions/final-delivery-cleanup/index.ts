import { createClient } from 'npm:@supabase/supabase-js@2';

const BUCKET = 'commission-final-deliveries';

interface ExpiredUpload {
  delivery_id: string;
  storage_paths: string[];
}

function response(status: number): Response {
  return new Response(null, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return response(405);
  const configuredToken = Deno.env.get('FINAL_DELIVERY_CLEANUP_TOKEN');
  if (!configuredToken || request.headers.get('X-Final-Delivery-Cleanup-Token') !== configuredToken) {
    return response(401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Final Delivery cleanup service is not configured.');
    return response(500);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await admin.rpc('claim_expired_final_delivery_uploads');
  if (error) {
    console.error('Unable to claim expired Final Delivery uploads.', error.message);
    return response(502);
  }

  const uploads = Array.isArray(data) ? data as ExpiredUpload[] : [];
  let failed = false;
  for (const upload of uploads) {
    const paths = Array.isArray(upload.storage_paths) ? upload.storage_paths : [];
    if (paths.length > 0) {
      const { error: removeError } = await admin.storage.from(BUCKET).remove(paths);
      if (removeError) {
        console.error('Unable to remove expired Final Delivery objects.', upload.delivery_id, removeError.message);
        failed = true;
        continue;
      }
    }

    const { error: completeError } = await admin.rpc('complete_final_delivery_storage_cleanup', {
      p_delivery_id: upload.delivery_id,
    });
    if (completeError) {
      console.error('Unable to record expired Final Delivery cleanup.', upload.delivery_id, completeError.message);
      failed = true;
    }
  }

  return response(failed ? 502 : 204);
});
