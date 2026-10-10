-- Mail schedules. Each call carries the x-job-secret header, read from job_secrets at run time,
-- so the secret is never stored in a job definition or in code. The Authorization value is
-- copied from the recheck job (the project's public key, which the function gateway requires).
--   mail-confirmations-every-10-min  confirm emails for signups that have not had one yet
--   mail-digest-monday               the weekly email, Mondays 13:00 UTC (8 AM Central in summer, 7 AM in winter)
do $$
declare
  auth text := (select substring(command from '''Authorization'',''(Bearer [^'']+)''') from cron.job where jobname = 'record-recheck-every-5-min');
  tmpl text := $t$select net.http_post(url := 'https://ccwmynoumrqpvnmpcgch.supabase.co/functions/v1/mail-jobs', headers := jsonb_build_object('Content-Type','application/json','Authorization',%L,'x-job-secret',(select value from public.job_secrets where key = 'jobs')), body := %L::jsonb, timeout_milliseconds := 120000)$t$;
begin
  perform cron.schedule('mail-confirmations-every-10-min', '*/10 * * * *', format(tmpl, auth, '{"job":"confirmations"}'));
  perform cron.schedule('mail-digest-monday', '0 13 * * 1', format(tmpl, auth, '{"job":"digest"}'));
end $$;
