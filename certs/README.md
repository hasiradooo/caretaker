# Supabase certificate

`supabase-root-2021.crt` is the public Supabase Root 2021 CA, downloaded over HTTPS from:

https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

Downloaded file SHA-256: `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7`.

The connection factory uses this certificate only for Supabase database/pooler hostnames. Other hosts use system certificate authorities. `DATABASE_CA_FILE` can supply a project-specific CA. Certificate and hostname verification remain enabled.

When Supabase rotates its certificate, obtain the new CA from your project's Database Settings → SSL Configuration and update `DATABASE_CA_FILE`. Do not work around a certificate error by disabling verification.

Reference: https://supabase.com/docs/guides/platform/ssl-enforcement
# Aiven

Download your project's CA certificate from the Aiven service overview and save
it here as `aiven-ca.pem`. Set `DATABASE_CA_FILE=certs/aiven-ca.pem` in `.env`.
This file is specific to your Aiven project and is not included in the rewrite.
Certificate verification stays enabled. Replace this file if Aiven rotates the CA.

See [Aiven TLS certificates](https://aiven.io/docs/platform/concepts/tls-ssl-certificates).

