-- First enable pg_cron, pg_net, and Vault in the Supabase Dashboard.
-- Add these two secrets in Vault before scheduling the job:
--   nurse_reminder_project_url = https://<project-ref>.supabase.co
--   nurse_reminder_cron_secret = the same random value as the Edge Function CRON_SECRET
-- Deploy send-duty-reminders with --no-verify-jwt; it checks x-cron-secret itself.

-- Enable required extensions (safe to re-run).
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

select cron.schedule(
  'send-nursing-duty-reminders',
  '* * * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'nurse_reminder_project_url') || '/functions/v1/send-duty-reminders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'nurse_reminder_cron_secret')
      ),
      body := '{}'::jsonb
    ) as request_id;
  $$
);
