import { serve } from "https://deno.land/std@0.178.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.118.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false },
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface InviteBody {
  name?: string;
  email: string;
  role: "head_office" | "nbg" | "zonal" | "branch" | "si";
  scope_id?: string | null;
  scope_type?: "nbg" | "zone" | "branch" | null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // Validate caller identity and HO role
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "Missing Authorization" }, 401);
  }
  const token = authHeader.replace(/^Bearer\s+/, "");
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return jsonResponse({ error: "Invalid token" }, 401);
  }

  const { data: callerProfile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!callerProfile || callerProfile.role !== "head_office") {
    return jsonResponse({ error: "Head Office only" }, 403);
  }

  let body: InviteBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const { name, email, role, scope_id, scope_type } = body;
  if (!email || !role) {
    return jsonResponse({ error: "email and role are required" }, 400);
  }
  const cleanName = name?.trim() || email.split("@")[0];
  if (cleanName.length > 120) {
    return jsonResponse({ error: "name cannot exceed 120 characters" }, 400);
  }

  const nbg_id = scope_type === "nbg" ? scope_id : null;
  const zone_id = scope_type === "zone" ? scope_id : null;
  const branch_id = scope_type === "branch" ? scope_id : null;

  // Create the user via admin API
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email,
    password: "SWatch123!",
    email_confirm: true,
    user_metadata: { role, name: cleanName },
  });
  if (createErr || !created.user) {
    return jsonResponse({ error: createErr?.message ?? "Failed to create user" }, 400);
  }

  // Create the profile
  const { error: profileErr } = await supabase.from("profiles").insert({
    id: created.user.id,
    email,
    name: cleanName,
    role,
    nbg_id,
    zone_id,
    branch_id,
  });
  if (profileErr) {
    // Best-effort cleanup: remove the auth user if profile insert fails
    await supabase.auth.admin.deleteUser(created.user.id);
    return jsonResponse({ error: profileErr.message }, 400);
  }

  return jsonResponse({ ok: true, user: { id: created.user.id, email, role } });
});
