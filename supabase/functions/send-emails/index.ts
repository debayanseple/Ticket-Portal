import { serve } from "https://deno.land/std@0.178.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.118.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const emailSendUrl = Deno.env.get("EMAIL_SEND_URL") || "";
const emailApiKey = Deno.env.get("EMAIL_API_KEY") || "";
const scheduledSecret = Deno.env.get("SCHEDULED_JOB_SECRET") || "";

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false },
});

interface EmailRow {
  id: string;
  ticket_id: string;
  to_email: string;
  subject: string;
  body: string;
}

async function sendOne(email: EmailRow): Promise<{ ok: boolean; error?: string }> {
  if (!emailSendUrl || !emailApiKey) {
    return { ok: false, error: "EMAIL_SEND_URL/EMAIL_API_KEY not configured" };
  }
  try {
    const res = await fetch(emailSendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${emailApiKey}`,
      },
      body: JSON.stringify({
        to: email.to_email,
        subject: email.subject,
        body: email.body,
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

serve(async (req) => {
  // Only the hosted scheduled caller may drain the organization-wide outbox.
  if (!scheduledSecret) {
    return new Response(JSON.stringify({ error: "SCHEDULED_JOB_SECRET is not configured" }), { status: 503 });
  }
  const suppliedSecret = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (suppliedSecret !== scheduledSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized scheduled invocation" }), { status: 401 });
  }

  // Fetch pending emails using service role (bypasses RLS)
  const { data: emails, error: fetchError } = await supabase
    .from("email_outbox")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (fetchError) {
    return new Response(JSON.stringify({ error: fetchError.message }), { status: 500 });
  }

  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const email of emails ?? []) {
    const { data: ticket, error: ticketError } = await supabase
      .from("tickets")
      .select("status")
      .eq("id", email.ticket_id)
      .maybeSingle();
    const result = ticketError
      ? { ok: false, error: "Ticket status could not be verified" }
      : ticket?.status === "resolved"
      ? { ok: false, error: "Ticket was resolved before email delivery" }
      : await sendOne(email as EmailRow);
    const outcome = ticket?.status === "resolved"
      ? "cancelled"
      : result.ok
      ? "sent"
      : result.error?.includes("not configured")
      ? "not_configured"
      : "failed";
    await supabase
      .from("email_outbox")
      .update({
        status: result.ok ? "sent" : "failed",
        error: result.error ?? null,
        sent_at: result.ok ? new Date().toISOString() : null,
      })
      .eq("id", email.id);
    await supabase
      .from("ticket_escalations")
      .update({ email_outcome: outcome })
      .eq("email_outbox_id", email.id);
    results.push({ id: email.id, ...result });
  }

  return new Response(
    JSON.stringify({ processed: results.length, results }),
    { headers: { "Content-Type": "application/json" } },
  );
});
