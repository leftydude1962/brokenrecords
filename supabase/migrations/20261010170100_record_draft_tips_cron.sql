-- Researches tips from /tip every 10 minutes (3 at most per run). When no tip is waiting,
-- the run ends before any AI search, so it costs nothing.
-- The call is copied from the recheck job so the access key is never written in this file.
select cron.schedule('record-draft-tips-every-10-min', '*/10 * * * *',
  replace(replace(command, '/functions/v1/record-recheck', '/functions/v1/record-draft'), '''limit'', 5', '''limit'', 3'))
from cron.job where jobname = 'record-recheck-every-5-min';
