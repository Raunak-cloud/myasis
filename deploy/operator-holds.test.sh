#!/usr/bin/env bash
# Execute the real cleanup trap in disposable directories; no production app,
# database, service, remote host or user data is accessed.
set -euo pipefail
SCRIPT=$(cd "$(dirname "$0")" && pwd)/deploy.sh
TMP_BASE=$(realpath "${TMPDIR:-/tmp}")
FIXTURE=$(mktemp -d "$TMP_BASE/owtomate-operator-deploy-test.XXXXXXXX")
FIXTURE=$(realpath "$FIXTURE")
case "$FIXTURE" in "$TMP_BASE"/owtomate-operator-deploy-test.*) ;; *) exit 1 ;; esac
trap 'rm -rf -- "$FIXTURE"' EXIT
sed -n '/^cleanup_deployment() {/,/^}/p' "$SCRIPT" > "$FIXTURE/cleanup.sh"
test -s "$FIXTURE/cleanup.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
for scenario in default-failure planned-build-failure planned-cli-failure planned-health-failure planned-success; do
  mkdir "$FIXTURE/$scenario"
  set +e
  bash -s -- "$FIXTURE/$scenario" "$FIXTURE/cleanup.sh" "$scenario" > "$FIXTURE/$scenario/log" 2>&1 <<'CASE'
set -euo pipefail
APP=$1
LOCK=$APP/.deploying
OPERATOR_HOLD_REQUIRED=1
OPERATOR_HOLD_RELEASE_READY=0
as_app() { bash -c "$1"; }
source "$2"
trap cleanup_deployment EXIT
printf 'draining\n' > "$LOCK"
case "$3" in
  default-failure) OPERATOR_HOLD_REQUIRED=0; exit 2;;
  planned-build-failure) exit 2;;
  planned-cli-failure)
    mkdir -p "$APP/dashboard" "$APP/seek-bot/node_modules/.bin"
    printf '#!/usr/bin/env bash\nexit 42\n' > "$APP/seek-bot/node_modules/.bin/tsx"
    chmod 755 "$APP/seek-bot/node_modules/.bin/tsx"
    OPERATOR_HOLD_PLAN="$APP/explicit-plan.json"
    # The exact fixed CLI invocation used by the deployment hook.
    (cd "$APP/dashboard" && ../seek-bot/node_modules/.bin/tsx scripts/apply-operator-holds.mts "$OPERATOR_HOLD_PLAN")
    touch "$APP/restarted"
    ;;
  planned-health-failure) printf 'holds-applied\n' > "$APP/stage"; exit 2;;
  planned-success) printf 'holds-applied-and-guard-healthy\n' > "$APP/stage"; OPERATOR_HOLD_RELEASE_READY=1;;
esac
CASE
  result=$?
  set -e
  if [ "$scenario" = planned-success ]; then
    [ "$result" = 0 ] || fail 'successful safety release failed'
    [ ! -e "$FIXTURE/$scenario/.deploying" ] || fail 'healthy completed release did not reopen gate'
  else
    [ "$result" != 0 ] || fail 'failure became success'
    if [ "$scenario" = default-failure ]; then
      [ ! -e "$FIXTURE/$scenario/.deploying" ] || fail 'default cleanup changed'
    else
      grep -q '^operator-safety-hold-required$' "$FIXTURE/$scenario/.deploying" || fail 'planned failure reopened the gate'
    fi
  fi
done
[ ! -e "$FIXTURE/planned-cli-failure/restarted" ] || fail 'failed CLI was followed by restart'
node --input-type=module - "$SCRIPT" <<'JS'
import {readFileSync} from 'node:fs';
const source=readFileSync(process.argv[2],'utf8');
const migrate=source.indexOf('tsx scripts/migrate-db.mts');
const apply=source.indexOf('tsx scripts/apply-operator-holds.mts "$OPERATOR_HOLD_PLAN"');
const restart=source.indexOf('pm2 restart myasis-dashboard');
const verify=source.indexOf('tsx scripts/apply-operator-holds.mts --verify');
const release=source.lastIndexOf('OPERATOR_HOLD_RELEASE_READY=1');
if(!(migrate>=0&&migrate<apply&&apply<restart&&restart<verify&&verify<release))throw Error('Unsafe operator hold release ordering');
JS
echo 'PASS: default cleanup preserved; explicit hold-plan build/CLI/health failures retain safety gate; failed CLI prevents restart; verified success reopens gate; migration/hold/restart/verification order checked.'
