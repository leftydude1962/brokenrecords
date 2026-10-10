-- Every scheduled job now sends x-job-secret, read from job_secrets when the job runs.
-- The functions it calls refuse any request without it (jobSecretOk in each function), because
-- the project's public key, which the scheduler also sends, is public and protects nothing.
select cron.alter_job(jobid, command := regexp_replace(command,
  '(''Authorization'',\s*''Bearer [^'']+'')',
  '\1, ''x-job-secret'', (select value from public.job_secrets where key = ''jobs'')'))
from cron.job where position('x-job-secret' in command) = 0;
