\set app_password `cat /run/secrets/app_password`
CREATE ROLE naryadai_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
ALTER DATABASE naryadai OWNER TO naryadai_app;
