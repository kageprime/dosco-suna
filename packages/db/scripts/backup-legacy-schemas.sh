#!/usr/bin/env bash
# Back up the Suna-era schemas (`public` and `basejump`) to a private S3 bucket before
# packages/db/migrations-pending/drop_legacy_suna_schemas.sql.pending drops them.
#
#   backup-legacy-schemas.sh bucket <bucket> <region> <expire_days|never>
#       Create the bucket: private (Block Public Access), versioned, SSE-KMS with a bucket
#       key, TLS only, tagged, and a lifecycle rule that deletes the backup <expire_days>
#       after upload ("never": no expiry). Run once per environment.
#
#   DATABASE_URL=<postgres url> backup-legacy-schemas.sh dump <bucket> <region> [rate]
#       Dump three custom-format archives (public.messages, public.documents, and the rest
#       of public + basejump), each streamed through `pv -L <rate>` (default 40m = 40 MB/s,
#       about a third of prod's 125 MiB/s disk throughput) and zstd to
#       s3://<bucket>/<yyyymmdd>/<part>.dump.zst. Then it lists each archive's table of
#       contents back from S3 and checks that every table has a TABLE DATA entry.
#
#   DATABASE_URL=<postgres url> SCRATCH_URL=<empty database url> \
#     backup-legacy-schemas.sh verify <bucket> <region> <yyyymmdd>
#       The restore test. Decode every archive of that day end to end and count each table's
#       rows; restore basejump and the extra part into the scratch database; compare the row
#       counts of public.messages, public.documents and basejump.account_user in the archive,
#       the scratch database (basejump only) and the live database. Exits non-zero on a
#       mismatch. The live counts are index-only scans: the frozen tables are all-visible, so
#       they read the primary keys, not the heap. A scratch server on localhost needs
#       sslmode=disable in SCRATCH_URL.
#
# Why three archives: pg_dump holds one snapshot for its whole run, and a snapshot that old
# keeps VACUUM from cleaning every hot table in the database. One archive per big table keeps
# the longest snapshot to the time public.messages takes (~45 min at 40 MB/s on prod).
#
# Needs: pg_dump/pg_restore of the server's major version or newer, pv, zstd, aws (CLI v2),
# python3. An archive needs a pg_restore at least as new as the pg_dump that wrote it (the
# 2026-11-10 prod archives: pg_dump 17). The dump writes nothing to local disk. On prod the
# ECS egress is 443 and 5432 only. Run it inside AWS eu-west-2, next to the database and the
# bucket: on 2026-11-10 a run from a laptop (6-8 MB/s to S3 London) read public.messages at
# ~2 MB/s, which is 10-30 h for prod and keeps the messages snapshot open as long.
# The URL is split into libpq variables (PGHOST, PGPASSWORD, ...) so the password never appears
# in a process list.
# Restore: rest.dump first (every table definition, the types, and all other data), then the
# data of the two big tables:
#   aws s3 cp s3://<bucket>/<day>/rest.dump.zst - | zstd -dc | pg_restore --no-owner -d <url>
#   aws s3 cp s3://<bucket>/<day>/messages.dump.zst - | zstd -dc | pg_restore --no-owner --data-only -d <url>
#   aws s3 cp s3://<bucket>/<day>/documents.dump.zst - | zstd -dc | pg_restore --no-owner --data-only -d <url>
set -euo pipefail

die() { echo "backup-legacy-schemas: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed"; }

cmd="${1:-}"; bucket="${2:-}"; region="${3:-}"
[ -n "$cmd" ] && [ -n "$bucket" ] && [ -n "$region" ] || die "usage: $0 bucket|dump|verify <bucket> <region> [expire_days|never|rate|yyyymmdd]"
need aws

# Split DATABASE_URL into the libpq variables. pg_dump/psql then get no URL argument, so
# `ps` never shows the password.
libpq_env() {
  [ -n "${DATABASE_URL:-}" ] || die "set DATABASE_URL"
  eval "$(python3 - <<'PY'
import os, shlex, urllib.parse as u
p = u.urlsplit(os.environ['DATABASE_URL'])
q = dict(u.parse_qsl(p.query))
env = {'PGHOST': p.hostname or '', 'PGPORT': str(p.port or 5432), 'PGUSER': u.unquote(p.username or ''),
       'PGPASSWORD': u.unquote(p.password or ''), 'PGDATABASE': u.unquote(p.path.lstrip('/')) or 'postgres',
       'PGSSLMODE': q.get('sslmode', 'require')}
print('\n'.join(f'export {k}={shlex.quote(v)}' for k, v in env.items()))
PY
)"
  unset DATABASE_URL
}

case "$cmd" in
  bucket)
    expire="${4:-}"
    [ -n "$expire" ] || die "bucket needs <expire_days|never>"
    if [ "$region" = "us-east-1" ]; then
      aws s3api create-bucket --bucket "$bucket" --region "$region"
    else
      aws s3api create-bucket --bucket "$bucket" --region "$region" --create-bucket-configuration "LocationConstraint=$region"
    fi
    aws s3api put-public-access-block --bucket "$bucket" --region "$region" \
      --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
    aws s3api put-bucket-ownership-controls --bucket "$bucket" --region "$region" \
      --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
    aws s3api put-bucket-versioning --bucket "$bucket" --region "$region" --versioning-configuration Status=Enabled
    aws s3api put-bucket-encryption --bucket "$bucket" --region "$region" --server-side-encryption-configuration \
      '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"},"BucketKeyEnabled":true}]}'
    aws s3api put-bucket-policy --bucket "$bucket" --region "$region" --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"DenyInsecureTransport\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",\"Resource\":[\"arn:aws:s3:::$bucket\",\"arn:aws:s3:::$bucket/*\"],\"Condition\":{\"Bool\":{\"aws:SecureTransport\":\"false\"}}}]}"
    aws s3api put-bucket-tagging --bucket "$bucket" --region "$region" --tagging \
      'TagSet=[{Key=ManagedBy,Value=manual},{Key=Project,Value=kortix},{Key=Service,Value=legacy-suna-backup},{Key=DataClass,Value=customer-content}]'
    if [ "$expire" = "never" ]; then
      rules='{"Rules":[{"ID":"abort-incomplete-uploads","Status":"Enabled","Filter":{},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":2}}]}'
    else
      [[ "$expire" =~ ^[0-9]+$ ]] || die "expire_days must be a number or never"
      rules="{\"Rules\":[{\"ID\":\"expire-backup\",\"Status\":\"Enabled\",\"Filter\":{},\"Expiration\":{\"Days\":$expire},\"NoncurrentVersionExpiration\":{\"NoncurrentDays\":1},\"AbortIncompleteMultipartUpload\":{\"DaysAfterInitiation\":2}},{\"ID\":\"expired-delete-markers\",\"Status\":\"Enabled\",\"Filter\":{},\"Expiration\":{\"ExpiredObjectDeleteMarker\":true}}]}"
    fi
    aws s3api put-bucket-lifecycle-configuration --bucket "$bucket" --region "$region" --lifecycle-configuration "$rules"
    echo "bucket s3://$bucket ready (region $region, expiry: $expire)"
    ;;

  dump)
    rate="${4:-40m}"
    libpq_env
    need pg_dump; need pg_restore; need pv; need zstd; need psql
    day="$(date -u +%Y%m%d)"
    # pg_dump keeps a transaction open; the postgres role ends idle transactions after 20 s on prod.
    export PGOPTIONS="-c statement_timeout=0 -c idle_in_transaction_session_timeout=0 -c lock_timeout=30s"
    # tables_in "<schemas>" "<extra filter>": tables whose data a part must list.
    tables_in() { psql -Atc "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and not c.relispartition and n.nspname in ($1) $2"; }

    dump_part() {
      local part="$1" expected="$2"; shift 2
      local key="s3://$bucket/$day/$part.dump.zst"
      echo "[$part] dumping to $key at $rate"
      # -Z0: pg_dump does not compress, so pv limits the bytes the server reads; zstd compresses after.
      pg_dump --format=custom --compress=0 --no-owner --no-privileges --lock-wait-timeout=30s "$@" \
        | pv -L "$rate" -i 30 -f \
        | zstd -q -T0 -10 \
        | aws s3 cp - "$key" --region "$region" --expected-size 500000000000 --sse aws:kms
      echo "[$part] uploaded: $(aws s3api head-object --bucket "$bucket" --key "$day/$part.dump.zst" --region "$region" --query ContentLength --output text) bytes"
      local listed
      # pg_restore exits once it has read the table of contents; aws then stops on the closed pipe.
      listed="$( (aws s3 cp "$key" - --region "$region" 2>/dev/null || true) | (zstd -dcq 2>/dev/null || true) | pg_restore --list | grep -c ' TABLE DATA ' || true)"
      [ "$listed" = "$expected" ] || die "[$part] archive lists $listed TABLE DATA entries, expected $expected"
      echo "[$part] table of contents: $listed of $expected tables"
    }

    dump_part messages 1 --table=public.messages
    dump_part documents 1 --table=public.documents
    rest="$(tables_in "'public', 'basejump'" "and c.oid not in ('public.messages'::regclass, 'public.documents'::regclass)")"
    dump_part rest "$rest" --schema=public --schema=basejump --exclude-table-data=public.messages --exclude-table-data=public.documents
    # The retired YOLO gateway's schema and the dead drizzle-kit ledger, dropped by the same migration.
    extra="$(tables_in "'kortix_yolo', 'drizzle'" "")"
    if [ "$extra" -gt 0 ]; then dump_part extra "$extra" --schema=kortix_yolo --schema=drizzle; fi
    echo "done: s3://$bucket/$day/{messages,documents,rest,extra}.dump.zst"
    ;;

  verify)
    day="${4:-}"
    [[ "$day" =~ ^[0-9]{8}$ ]] || die "verify needs <yyyymmdd>"
    [ -n "${SCRATCH_URL:-}" ] || die "set SCRATCH_URL to an empty scratch database"
    libpq_env
    need pg_restore; need zstd; need psql
    export PGOPTIONS="-c statement_timeout=0"
    work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
    fetch() { aws s3 cp "s3://$bucket/$day/$1.dump.zst" - --region "$region" | zstd -dcq; }
    exists() { aws s3api head-object --bucket "$bucket" --key "$day/$1.dump.zst" --region "$region" >/dev/null 2>&1; }

    # 1. Every archive decodes end to end. In COPY text format one row is one line.
    for part in messages documents rest extra; do
      if ! exists "$part"; then
        [ "$part" = extra ] && continue
        die "s3://$bucket/$day/$part.dump.zst does not exist"
      fi
      echo "[$part] decoding every table's data"
      fetch "$part" | pg_restore --data-only -f - \
        | awk -v OFS='\t' '/^COPY /{t=$2; n=0; c=1; next} c && $0 == "\\."{print t, n; c=0; next} c{n++}' >>"$work/archive.tsv"
    done
    echo "[archive] $(wc -l <"$work/archive.tsv" | tr -d ' ') tables, $(awk -F'\t' '{s+=$2} END {print s+0}' "$work/archive.tsv") rows"

    # 2. Restore basejump and the extra part into the scratch database. pg_restore --schema
    # does not create the schema itself. The stubs stand in for the Supabase schemas the column
    # defaults call (extensions.*, auth.*). Statements that need
    # an object outside the dump (FKs to auth.users, policies for the API roles) fail and count.
    psql -d "$SCRATCH_URL" -v ON_ERROR_STOP=1 -qc '
      create schema if not exists extensions;
      create extension if not exists "uuid-ossp" with schema extensions;
      create extension if not exists pgcrypto with schema extensions;
      create schema if not exists basejump;
      create schema if not exists auth;
      create or replace function auth.uid() returns uuid language sql as $$select null::uuid$$;
      create or replace function auth.role() returns text language sql as $$select null::text$$;
      create or replace function auth.jwt() returns jsonb language sql as $$select null::jsonb$$;'
    restore() {
      local part="$1"; shift
      fetch "$part" | pg_restore --no-owner --no-privileges -d "$SCRATCH_URL" "$@" 2>"$work/restore-$part.log" || true
      echo "[restore $part] $(grep -c '^pg_restore: error' "$work/restore-$part.log" || true) statements failed:"
      { grep '^pg_restore: error' "$work/restore-$part.log" || true; } | cut -c1-160 | sort | uniq -c | sort -rn | head -5
    }
    restore rest --schema=basejump
    if exists extra; then restore extra; fi

    # 3. Compare. A row deleted after its part's snapshot shows as live < archive.
    archived() { awk -F'\t' -v t="$1" '$1 == t {print $2; f=1} END {if (!f) print "missing"}' "$work/archive.tsv"; }
    scratch() { psql -d "$SCRATCH_URL" -qAt -c "select count(*) from $1" 2>/dev/null || echo missing; }
    live() { psql -qAt -c "set enable_seqscan = off" -c "set max_parallel_workers_per_gather = 0" -c "select count(*) from $1"; }
    fail=0
    printf '%-24s %12s %12s %12s\n' table archive scratch live
    for t in public.messages public.documents basejump.account_user; do
      a="$(archived "$t")"; l="$(live "$t")"; s=-
      [[ "$t" == basejump.* ]] && s="$(scratch "$t")"
      printf '%-24s %12s %12s %12s\n' "$t" "$a" "$s" "$l"
      [ "$a" = "$l" ] || fail=1
      [[ "$t" != basejump.* ]] || [ "$s" = "$l" ] || fail=1
    done
    for t in $(awk -F'\t' '$1 ~ /^(basejump|kortix_yolo|drizzle)\./ {print $1}' "$work/archive.tsv"); do
      a="$(archived "$t")"; s="$(scratch "$t")"
      [ "$a" = "$s" ] || { echo "[restore] $t: archive $a rows, scratch $s"; fail=1; }
    done
    [ "$fail" = 0 ] || die "row counts differ (rows deleted after the dump: compare pg_stat_user_tables.n_tup_del)"
    echo "verified: s3://$bucket/$day/ decodes end to end, basejump restores, row counts match"
    ;;

  *) die "unknown command $cmd (bucket|dump|verify)" ;;
esac
