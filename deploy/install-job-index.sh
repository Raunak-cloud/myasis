#!/usr/bin/env bash
set -euo pipefail
APP=/home/myasis/myasis
# No job database is ever created on this VPS. The worker waits for Neon.
# The existing application DB only gets a limited read-only login. Its password
# stays in the protected config and never enters command arguments or output.
python3 - <<'PY'
import json, os, secrets, subprocess, grp
from pathlib import Path
from urllib.parse import urlparse
path=Path('/etc/owtomate-job-index.json');config=json.loads(path.read_text()) if path.exists() else {}
if not config.get('appReadUrl'):
    password=secrets.token_urlsafe(32)
    config['appReadUrl']=f'postgresql://owtomate_job_reader:{password}@127.0.0.1:5432/myasis'
    pending=path.with_name('.owtomate-job-index-'+secrets.token_hex(8)+'.json')
    fd=os.open(str(pending),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f:json.dump(config,f);f.flush();os.fsync(f.fileno())
    os.chown(pending,0,grp.getgrnam('myasis').gr_gid);os.chmod(pending,0o640);os.replace(pending,path)
reader=urlparse(config['appReadUrl']);password=reader.password
assert (reader.hostname,reader.username,reader.path)==('127.0.0.1','owtomate_job_reader','/myasis')
assert password and all(c.isalnum() or c in '_-' for c in password)
sql=f"""
DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='owtomate_job_reader') THEN
 CREATE ROLE owtomate_job_reader LOGIN PASSWORD '{password}'; END IF; END $$;
ALTER ROLE owtomate_job_reader SET default_transaction_read_only=on;
GRANT CONNECT ON DATABASE myasis TO owtomate_job_reader;
GRANT USAGE ON SCHEMA public TO owtomate_job_reader;
GRANT SELECT(id,blocked_at) ON users TO owtomate_job_reader;
GRANT SELECT(user_id,skills,headline) ON profiles TO owtomate_job_reader;
GRANT SELECT(user_id,key,value) ON settings TO owtomate_job_reader;
GRANT SELECT(id,user_id,file_name,is_default,uploaded_at) ON resumes TO owtomate_job_reader;
GRANT SELECT(user_id,purchase_id,expires_at) ON application_credit_grants TO owtomate_job_reader;
GRANT SELECT(id,user_id,plan_key) ON billing_purchases TO owtomate_job_reader;
GRANT SELECT(user_id,url,external,applied_at) ON applications TO owtomate_job_reader;
"""
subprocess.run(['sudo','-u','postgres','psql','-X','-v','ON_ERROR_STOP=1','-d','myasis'],input=sql,text=True,check=True,stdout=subprocess.DEVNULL)
PY
sudo -u myasis -H bash -lc "cd $APP && seek-bot/node_modules/.bin/tsx dashboard/scripts/job-index-worker.mts --migrate"
sudo -u myasis -H bash -lc "cd $APP && pm2 startOrReload ecosystem.config.cjs --only owtomate-job-index --update-env >/dev/null && pm2 save >/dev/null"
echo 'External job collector and read-only account connection ready'
