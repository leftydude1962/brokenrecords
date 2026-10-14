-- Temporary: runs record-enrich every 2 minutes (8 records a run) until every record is enriched.
-- Built from the alerts-ingest job's command, so the headers (and keys) are copied, not typed here.
-- Unschedule with: select cron.unschedule('record-enrich-backfill');
select cron.schedule('record-enrich-backfill', '*/2 * * * *',
  replace(replace((select command from cron.job where jobname = 'alerts-ingest-hourly'),
    '/functions/v1/alerts-ingest', '/functions/v1/record-enrich'),
    'body := ''{}''::jsonb', 'body := ''{"limit": 8}''::jsonb'));
