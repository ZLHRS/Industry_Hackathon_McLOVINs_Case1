\set app_password `cat /run/secrets/app_password`
SELECT length(:'app_password') BETWEEN 6 AND 128 AS app_password_valid \gset
\if :app_password_valid
CREATE ROLE naryadai_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
ALTER DATABASE naryadai OWNER TO naryadai_app;
\else
DO $$ BEGIN RAISE EXCEPTION 'A readable, non-empty app_password secret is required'; END $$;
\endif
